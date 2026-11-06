import {
  createPublicClient as createArkivPublicClient,
  createWalletClient as createArkivWalletClient,
} from '@arkiv-network/sdk';
import type { PublicArkivClient } from '@arkiv-network/sdk';
import { rabdi } from '@arkiv-network/sdk/chains';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, formatEther, getAddress, http, isAddress } from 'viem';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { GatewaySource } from '../reputation/retrieval.js';
import { normalizeReviewContentBaseUrl } from '../signing/feedbackUri.js';
import { indexConfirmedReviews } from './indexer.js';
import { CREATE_POLICY, planPublication } from './publisher.js';
import type { PublicationPlan } from './publisher.js';
import {
  assertSeparateFromSigner,
  checkApprovedPlan,
  fromPlanFile,
  PlanApprovalError,
  planFileHash,
  toPlanFile,
} from './planFile.js';
import type { PlanFile } from './planFile.js';
import {
  countProvenance,
  openProvenanceDatabases,
  parseRpEnvironments,
  resolveProvenance,
} from './provenance.js';
import type { Provenance } from './provenance.js';
import { describeValues, reviewId } from './records.js';
import { REPUTATION_SCHEMA_NAME, REVIEW_SCHEMA_NAME } from './schemas.js';
import { estimatePlan, executePlan, readPublishedState } from './sdk.js';
import { computeSnapshot } from './snapshot.js';

/**
 * Publish confirmed Receipts reviews and reputation snapshots to Arkiv.
 *
 *   npm run arkiv:publish                       # dry run: write arkiv-plan.json, send nothing
 *   npm run arkiv:publish -- --agents 1,7       # also snapshot agents with no reviews yet
 *   npm run arkiv:publish -- --execute --plan arkiv-plan.json --confirm <planHash>
 *
 * A dry run prints every entity in full, the publisher address and its tGLM
 * balance, writes the plan to a file and prints that file's hash.
 * `--execute` sends that file and nothing else, and refuses unless it still
 * hashes to the `--confirm` value, so what is written is exactly what was
 * reviewed.
 *
 * Runs outside the API server on purpose. The Arkiv key lives only in this
 * process, and the server, which holds the attestation key, never sees it.
 *
 * Environment (the server's names where they overlap):
 *   RPC_URL, CHAIN_ID, REVIEW_GATEWAY_ADDRESS, GATEWAY_DEPLOY_BLOCK,
 *   RECEIPT_SETTLER_ADDRESS, IDENTITY_REGISTRY_ADDRESS,
 *   REPUTATION_REGISTRY_ADDRESS, ADDITIONAL_REVIEW_GATEWAYS,
 *   REPUTATION_CONFIRMATIONS, REVIEW_CONTENT_BASE_URL
 *   ARKIV_PUBLISHER_PRIVATE_KEY  required for --execute; never printed
 *   ARKIV_PUBLISHER_ADDRESS      lets a dry run plan without the key
 *   ARKIV_ACCESS_KEY             optional; empty uses the public endpoint
 *   ARKIV_CONFIRMATIONS          Sepolia blocks a review must be buried under (default 12)
 *   ARKIV_CONTENT_BASE_URL       where to fetch review text (default REVIEW_CONTENT_BASE_URL)
 *   ARKIV_PROVENANCE_DATABASE_URLS  comma-separated Postgres URLs, opened read-only, to find
 *                                which World ID RP verified each review; unset means every
 *                                review is published as `unknown`. Never printed.
 *   ARKIV_RP_ENVIRONMENTS        `rp_…:production,rp_…:staging`; an unlisted RP is `unknown`
 */

const recordServerSignerAbi = [
  {
    type: 'function',
    name: 'recordServerSigner',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

class CliError extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === '') throw new CliError(`${name} is required`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function address(name: string): Address {
  const value = required(name);
  if (!isAddress(value, { strict: false })) throw new CliError(`${name} must be an address`);
  return getAddress(value);
}

function blockNumber(name: string, fallback?: bigint): bigint {
  const value = optional(name);
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new CliError(`${name} is required`);
  }
  if (!/^[0-9]+$/.test(value)) throw new CliError(`${name} must be a non-negative integer`);
  return BigInt(value);
}

function parseArgs(argv: readonly string[]): {
  execute: boolean;
  confirm?: string;
  agents: bigint[];
  planPath: string;
} {
  let execute = false;
  let confirm: string | undefined;
  let planPath = 'arkiv-plan.json';
  const agents: bigint[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--execute') execute = true;
    else if (arg === '--confirm') confirm = argv[++i];
    else if (arg === '--plan') planPath = argv[++i] ?? planPath;
    else if (arg === '--agents') {
      for (const id of (argv[++i] ?? '').split(',').filter((s) => s !== '')) {
        if (!/^[1-9][0-9]*$/.test(id)) throw new CliError(`--agents: "${id}" is not an agent id`);
        agents.push(BigInt(id));
      }
    } else throw new CliError(`unknown argument ${arg ?? ''}`);
  }
  return { execute, ...(confirm === undefined ? {} : { confirm }), agents, planPath };
}

/** Fetch review text from the Record Server's public content route. */
function contentFetcher(baseUrl: string): (hash: Hex) => Promise<Uint8Array | null> {
  return async (hash) => {
    try {
      const res = await fetch(`${baseUrl}/reviews/${hash}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  };
}

/** The plan as printed for review. Every value spelled out, nothing elided. */
function renderPlan(plan: PublicationPlan): Record<string, unknown> {
  return {
    creates: plan.creates.map((c) => ({
      kind: c.kind,
      id: c.id,
      schema: c.kind === 'review' ? REVIEW_SCHEMA_NAME : REPUTATION_SCHEMA_NAME,
      lifetime: CREATE_POLICY[c.kind].lifetime,
      flags: CREATE_POLICY[c.kind].flags,
      values: describeValues(c.values as Record<string, unknown>),
    })),
    extensions: plan.extensions,
    unchanged: plan.unchanged,
    refused: plan.refused,
  };
}

/**
 * The publisher must never be the attestation signer: a leaked Arkiv key must
 * not also be able to forge "human-verified" reviews. Checked on both the dry
 * run and execute, since a plan file need not have come from a dry run.
 */
async function refuseAttestationSigner(
  sepolia: ReturnType<typeof createPublicClient>,
  reviewGateway: Address,
  publisher: Address,
): Promise<void> {
  const signer = await sepolia.readContract({
    address: reviewGateway,
    abi: recordServerSignerAbi,
    functionName: 'recordServerSigner',
  });
  assertSeparateFromSigner(getAddress(signer), publisher);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const chain = rabdi({ accessKey: optional('ARKIV_ACCESS_KEY') ?? '' });
  const arkiv = createArkivPublicClient({ chain, transport: http() });

  const rawKey = optional('ARKIV_PUBLISHER_PRIVATE_KEY');
  if (rawKey !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new CliError('ARKIV_PUBLISHER_PRIVATE_KEY must be a 32-byte hex key');
  }
  const account = rawKey === undefined ? undefined : privateKeyToAccount(rawKey as Hex);

  if (args.execute) {
    await execute(args, chain, arkiv, account);
    return;
  }

  const chainId = Number(required('CHAIN_ID'));
  const sepolia = createPublicClient({ transport: http(required('RPC_URL')) });
  const reviewGateway = address('REVIEW_GATEWAY_ADDRESS');
  const reputationRegistry = address('REPUTATION_REGISTRY_ADDRESS');
  const gatewayDeployBlock = blockNumber('GATEWAY_DEPLOY_BLOCK');
  const additionalGateways: GatewaySource[] = (optional('ADDITIONAL_REVIEW_GATEWAYS') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((entry) => {
      const [addr, block] = entry.split('@');
      if (
        addr === undefined ||
        block === undefined ||
        !isAddress(addr) ||
        !/^[0-9]+$/.test(block)
      ) {
        throw new CliError(
          'ADDITIONAL_REVIEW_GATEWAYS: each entry must be "<address>@<deploy block>"',
        );
      }
      return { address: getAddress(addr), fromBlock: BigInt(block) };
    });
  const contentBase = normalizeReviewContentBaseUrl(
    optional('ARKIV_CONTENT_BASE_URL') ?? required('REVIEW_CONTENT_BASE_URL'),
  );
  if (contentBase === null) throw new CliError('the review content base URL is not a usable URL');

  // A dry run can plan from the address alone; only execute needs the key.
  const publisher = account?.address ?? address('ARKIV_PUBLISHER_ADDRESS');

  await refuseAttestationSigner(sepolia, reviewGateway, publisher);

  const indexed = await indexConfirmedReviews({
    client: sepolia,
    reputationRegistry,
    gateways: [{ address: reviewGateway, fromBlock: gatewayDeployBlock }, ...additionalGateways],
    confirmations: blockNumber('ARKIV_CONFIRMATIONS', 12n),
  });

  // Provenance is resolved once per review, before planning, so the plan,
  // the snapshot counts and the printed summary all agree.
  const rpEnvironments = parseRpEnvironments(optional('ARKIV_RP_ENVIRONMENTS') ?? '');
  const databases = openProvenanceDatabases(
    (optional('ARKIV_PROVENANCE_DATABASE_URLS') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  );
  const provenance = new Map<string, Provenance>();
  try {
    for (const review of indexed.reviews) {
      provenance.set(
        reviewId(review),
        await resolveProvenance(review, databases.lookups, rpEnvironments),
      );
    }
  } finally {
    await databases.close();
  }
  const provenanceOf = (review: (typeof indexed.reviews)[number]): Provenance =>
    provenance.get(reviewId(review)) ?? { environment: 'unknown' };

  const agentIds = [...new Set([...indexed.reviews.map((r) => r.agentId), ...args.agents])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );
  const snapshotDeps = {
    client: sepolia,
    chainId,
    contracts: {
      reviewGateway,
      receiptSettler: address('RECEIPT_SETTLER_ADDRESS'),
      identityRegistry: address('IDENTITY_REGISTRY_ADDRESS'),
      reputationRegistry,
    },
    gatewayDeployBlock,
    additionalGateways,
    confirmations: blockNumber('REPUTATION_CONFIRMATIONS', 2n),
  };
  const snapshots = [];
  for (const id of agentIds) {
    const scored = await computeSnapshot(snapshotDeps, id);
    snapshots.push({
      ...scored,
      // Over the reviews the indexer saw, which stops ARKIV_CONFIRMATIONS
      // blocks back; a review newer than that is in neither count nor plan.
      provenance: countProvenance(
        indexed.reviews
          .filter((r) => r.agentId === id && r.blockNumber <= scored.snapshotBlock)
          .map(provenanceOf),
      ),
    });
  }

  const [published, timing, balance] = await Promise.all([
    readPublishedState(arkiv, publisher),
    arkiv.getBlockTiming(),
    arkiv.getBalance({ address: publisher }),
  ]);

  const plan = await planPublication({
    chainId,
    reviews: indexed.reviews,
    contentFor: contentFetcher(contentBase),
    provenanceFor: async (review) => provenanceOf(review),
    snapshots,
    published,
    arkivBlock: timing.currentBlock,
  });
  const file = toPlanFile(plan, publisher, chain.id);
  const planHash = planFileHash(file);
  const estimate =
    plan.creates.length + plan.extensions.length === 0
      ? null
      : await estimatePlan(chain, chain.rpcUrls.default.http[0], publisher, plan);
  writeFileSync(args.planPath, `${JSON.stringify(file, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        network: {
          name: chain.name,
          chainId: chain.id,
          explorer: chain.blockExplorers.default.url,
        },
        publisher,
        publisherBalanceTGLM: formatEther(balance),
        estimate:
          estimate === null
            ? null
            : {
                transactions: estimate.batches,
                gasPerTransaction: estimate.gas.map((g) =>
                  g === null ? 'node would not estimate' : g.toString(10),
                ),
                gasPriceWei: estimate.gasPrice.toString(10),
                costTGLM: estimate.cost === null ? null : formatEther(estimate.cost),
                note: 'tGLM is the Rabdi testnet token from the faucet; no real funds are spent',
              },
        sepoliaScannedTo: indexed.toBlock.toString(10),
        provenance: {
          sources: databases.lookups.length,
          rpEnvironments: Object.fromEntries(rpEnvironments),
          reviews: indexed.reviews.map((r) => ({ review: reviewId(r), ...provenanceOf(r) })),
        },
        indexerSkipped: indexed.skipped,
        plan: renderPlan(plan),
        planFile: args.planPath,
        planHash,
      },
      null,
      2,
    ),
  );

  const operations = plan.creates.length + plan.extensions.length;
  console.error(
    operations === 0
      ? '\nDry run: nothing to write.'
      : `\nDry run: ${operations} operation(s) written to ${args.planPath}, nothing sent. To send exactly that file:\n` +
          `  npm run arkiv:publish -- --execute --plan ${args.planPath} --confirm ${planHash}`,
  );
}

/** Send a previously reviewed plan file, and nothing else. */
async function execute(
  args: ReturnType<typeof parseArgs>,
  chain: ReturnType<typeof rabdi>,
  arkiv: PublicArkivClient,
  account: ReturnType<typeof privateKeyToAccount> | undefined,
): Promise<void> {
  if (account === undefined) throw new CliError('--execute needs ARKIV_PUBLISHER_PRIVATE_KEY');
  if (args.confirm === undefined) throw new CliError('--execute needs --confirm <planHash>');

  const file = JSON.parse(readFileSync(args.planPath, 'utf8')) as PlanFile;
  checkApprovedPlan(file, {
    confirm: args.confirm,
    signer: account.address,
    arkivChainId: chain.id,
  });
  await refuseAttestationSigner(
    createPublicClient({ transport: http(required('RPC_URL')) }),
    address('REVIEW_GATEWAY_ADDRESS'),
    account.address,
  );

  // A plan run twice must not publish a review twice.
  const plan = fromPlanFile(file);
  const published = await readPublishedState(arkiv, account.address);
  const already = plan.creates.filter((c) => c.kind === 'review' && published.reviews.has(c.id));
  if (already.length > 0) {
    throw new CliError(
      `${already.length} planned review(s) are already on Arkiv; run a new dry run`,
    );
  }

  const wallet = createArkivWalletClient({ chain, transport: http(), account });
  const batches = await executePlan(wallet, plan);
  const explorer = chain.blockExplorers.default.url;
  console.log(
    JSON.stringify(
      batches.map((b) => ({
        tx: `${explorer}/tx/${b.txHash}`,
        created: b.created.map((c) => ({ ...c, url: `${explorer}/entity/${c.entityKey}` })),
        extended: b.extended,
      })),
      null,
      2,
    ),
  );
}

main().catch((err: unknown) => {
  // The RPC URL can carry an API key, and viem puts it in `message`. Only
  // `shortMessage` and `details` are printed: both come from the node's
  // response, never from the request URL.
  if (err instanceof CliError || err instanceof PlanApprovalError) {
    console.error(`[arkiv] ${err.message}`);
  } else if (err instanceof Error) {
    const { shortMessage, details } = err as { shortMessage?: string; details?: string };
    console.error(
      `[arkiv] failed: ${err.name}: ${shortMessage ?? '(no detail)'}${details ? ` (${details})` : ''}`,
    );
  } else {
    console.error('[arkiv] failed: unknown error');
  }
  process.exitCode = 1;
});
