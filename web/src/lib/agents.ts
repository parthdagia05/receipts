import { BaseError, ContractFunctionRevertedError, ExecutionRevertedError } from 'viem';
import type { Address } from 'viem';
import { identityRegistryAbi, reputationRegistryAbi } from './abi';
import { MAX_LOG_RANGE, publicClient } from './chain';
import { config } from './config';

/** The ERC-721 Transfer event, used only for recovering ownership from logs. */
const erc721TransferAbi = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

/**
 * Agent discovery against the live ERC-8004 Identity Registry.
 *
 * The registry exposes no enumeration: `totalSupply`, `tokenByIndex` and every
 * obvious counter revert on the deployed contract. What it does guarantee is
 * ERC-721 semantics — `ownerOf` reverts with `ERC721NonexistentToken` for an
 * id that was never minted — and ids are allocated sequentially from 1.
 *
 * So the highest minted id is found by binary search over `ownerOf`, and the
 * directory is "the most recent N agents", counting down from it. That is a
 * real view of the registry rather than a curated list, and it costs about
 * fourteen reads instead of a full scan of eleven thousand tokens.
 */

export interface AgentSummary {
  readonly agentId: bigint;
  /** Null when the token exists but the owner read failed. */
  readonly owner: Address | null;
  /** `address(0)` means no payment wallet is set, which blocks paid reviews. */
  readonly agentWallet: Address | null;
  /** Raw `tokenURI`; may be `ipfs://…`, which this app does not resolve. */
  readonly tokenURI: string | null;
  /** Distinct addresses that have written ERC-8004 feedback for this agent. */
  readonly clientCount: number | null;
}

export interface AgentDetail extends AgentSummary {
  /** Aggregate across every feedback author, as the registry computes it. */
  readonly summary: {
    readonly count: number;
    readonly value: bigint;
    readonly valueDecimals: number;
  } | null;
  /** Aggregate restricted to feedback written by the Receipts gateway. */
  readonly receiptsSummary: {
    readonly count: number;
    readonly value: bigint;
    readonly valueDecimals: number;
  } | null;
}

/** Cached across calls: the head of the registry moves slowly. */
let highestIdCache: { value: bigint; fetchedAt: number } | null = null;
const HIGHEST_ID_TTL_MS = 60_000;

/**
 * Whether `ownerOf` reverted because the token does not exist.
 *
 * This distinction is the whole correctness of the search below. `ownerOf`
 * reverting with `ERC721NonexistentToken` means "no such agent"; the RPC
 * timing out means "we do not know". Treating the second as the first makes
 * an unreachable endpoint report zero agents, which is a fabricated number
 * presented with the same confidence as a real one.
 *
 * Only a revert counts. Anything else — transport failure, rate limit,
 * malformed response — propagates, so the caller surfaces an error state.
 */
function isNonexistentToken(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return (
    error.walk(
      (e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError,
    ) !== null
  );
}

async function exists(agentId: bigint): Promise<boolean> {
  try {
    await publicClient.readContract({
      address: config.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    });
    return true;
  } catch (error) {
    if (isNonexistentToken(error)) return false;
    throw error;
  }
}

/**
 * The highest minted agent id.
 *
 * Doubles an upper bound until `ownerOf` reverts, then bisects. Returns 0n
 * when the registry is empty or unreachable.
 */
export async function findHighestAgentId(): Promise<bigint> {
  const cached = highestIdCache;
  if (cached !== null && Date.now() - cached.fetchedAt < HIGHEST_ID_TTL_MS) {
    return cached.value;
  }

  // Agent 1 missing is a real answer (empty registry); a throw here is not,
  // and propagates rather than being reported as an empty registry.
  if (!(await exists(1n))) return 0n;

  let low = 1n;
  let high = 2n;
  while (await exists(high)) {
    low = high;
    high *= 2n;
    // Guard against an endpoint that answers every call successfully.
    if (high > 1n << 40n) break;
  }

  while (high - low > 1n) {
    const mid = (low + high) / 2n;
    if (await exists(mid)) low = mid;
    else high = mid;
  }

  highestIdCache = { value: low, fetchedAt: Date.now() };
  return low;
}

/**
 * Read a batch of agents in one multicall round trip.
 *
 * `allowFailure` is on: a single agent whose `tokenURI` reverts must not blank
 * the whole directory, so each field degrades to null on its own.
 */
export async function loadAgents(agentIds: readonly bigint[]): Promise<AgentSummary[]> {
  if (agentIds.length === 0) return [];

  const contracts = agentIds.flatMap((agentId) => [
    {
      address: config.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'ownerOf',
      args: [agentId],
    } as const,
    {
      address: config.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'getAgentWallet',
      args: [agentId],
    } as const,
    {
      address: config.identityRegistry,
      abi: identityRegistryAbi,
      functionName: 'tokenURI',
      args: [agentId],
    } as const,
    {
      address: config.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: 'getClients',
      args: [agentId],
    } as const,
  ]);

  const results = await publicClient.multicall({ contracts, allowFailure: true });

  return agentIds.map((agentId, index) => {
    const base = index * 4;
    const owner = results[base];
    const wallet = results[base + 1];
    const uri = results[base + 2];
    const clients = results[base + 3];

    return {
      agentId,
      owner: owner?.status === 'success' ? (owner.result as Address) : null,
      agentWallet: wallet?.status === 'success' ? (wallet.result as Address) : null,
      tokenURI: uri?.status === 'success' ? (uri.result as string) : null,
      clientCount:
        clients?.status === 'success' ? (clients.result as readonly Address[]).length : null,
    };
  });
}

/** The `count` most recent agents, newest first. */
export async function loadRecentAgents(count: number): Promise<AgentSummary[]> {
  const highest = await findHighestAgentId();
  if (highest === 0n) return [];

  const ids: bigint[] = [];
  for (let id = highest; id > 0n && ids.length < count; id--) ids.push(id);
  return loadAgents(ids);
}

/** One agent, with both reputation aggregates. Returns null if it does not exist. */
export async function loadAgentDetail(agentId: bigint): Promise<AgentDetail | null> {
  const [summary] = await loadAgents([agentId]);
  if (summary === undefined || summary.owner === null) return null;

  // `getSummary` requires a non-empty client list, so it is only worth asking
  // when the agent has at least one feedback author.
  const clients = await publicClient
    .readContract({
      address: config.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: 'getClients',
      args: [agentId],
    })
    .catch(() => [] as readonly Address[]);

  if (clients.length === 0) {
    return { ...summary, summary: null, receiptsSummary: null };
  }

  const receiptsIsClient = clients.some(
    (client) => client.toLowerCase() === config.reviewGateway.toLowerCase(),
  );

  const [overall, receipts] = await publicClient.multicall({
    contracts: [
      {
        address: config.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'getSummary',
        args: [agentId, clients as Address[], '', ''],
      } as const,
      {
        address: config.reputationRegistry,
        abi: reputationRegistryAbi,
        functionName: 'getSummary',
        // Restricted to our own gateway: these are the Receipts reviews, as
        // distinct from whatever else has written feedback for this agent.
        args: [agentId, [config.reviewGateway], '', ''],
      } as const,
    ],
    allowFailure: true,
  });

  const unpack = (
    entry: { status: 'success'; result: unknown } | { status: 'failure' } | undefined,
  ) => {
    if (entry?.status !== 'success') return null;
    const [count, value, valueDecimals] = entry.result as readonly [bigint, bigint, number];
    return { count: Number(count), value, valueDecimals };
  };

  return {
    ...summary,
    summary: unpack(overall),
    receiptsSummary: receiptsIsClient ? unpack(receipts) : null,
  };
}

/**
 * Agents currently owned by `owner`.
 *
 * The registry implements no `ERC721Enumerable`, so ownership is recovered
 * from `Transfer` logs: every id ever transferred to this address, then
 * filtered by a present-tense `ownerOf` check so anything since sold is
 * dropped.
 *
 * The scan is bounded. `eth_getLogs` is capped per request by the endpoint and
 * the registry predates this app by a long way, so walking to genesis would be
 * slow and usually pointless. `windows` sets how far back to look, and the UI
 * states the depth rather than implying the result is exhaustive.
 */
export async function loadOwnedAgents(
  owner: Address,
  windows = 6,
): Promise<{ agents: AgentSummary[]; scannedFrom: bigint; complete: boolean }> {
  const head = await publicClient.getBlockNumber();
  const ids = new Set<bigint>();

  let toBlock = head;
  let scannedFrom = head;

  for (let window = 0; window < windows; window++) {
    const candidate = toBlock - MAX_LOG_RANGE + 1n;
    const fromBlock = candidate > 0n ? candidate : 0n;

    const logs = await publicClient.getContractEvents({
      address: config.identityRegistry,
      abi: erc721TransferAbi,
      eventName: 'Transfer',
      fromBlock,
      toBlock,
      args: { to: owner },
    });

    for (const log of logs) {
      if (log.args.tokenId !== undefined) ids.add(log.args.tokenId);
    }

    scannedFrom = fromBlock;
    if (fromBlock === 0n) return finish(ids, scannedFrom, true);
    toBlock = fromBlock - 1n;
  }

  return finish(ids, scannedFrom, false);

  async function finish(tokenIds: Set<bigint>, from: bigint, complete: boolean) {
    const sorted = [...tokenIds].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const loaded = await loadAgents(sorted);
    // Transferred away since: the log says it arrived, `ownerOf` says who has
    // it now, and now is what the page claims to show.
    const owned = loaded.filter(
      (agent) => agent.owner !== null && agent.owner.toLowerCase() === owner.toLowerCase(),
    );
    return { agents: owned, scannedFrom: from, complete };
  }
}

/** Whether `candidate` may review `agentId` — owners and operators may not. */
export async function isSelfReview(agentId: bigint, candidate: Address): Promise<boolean> {
  return publicClient.readContract({
    address: config.identityRegistry,
    abi: identityRegistryAbi,
    functionName: 'isAuthorizedOrOwner',
    args: [candidate, agentId],
  });
}
