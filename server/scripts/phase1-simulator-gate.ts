/**
 * Phase 1 gate: does the World ID Simulator issue the credential we require?
 *
 * Standalone and throwaway. It is not imported by the server, not covered by
 * tsconfig.json ("src", "test", "vitest.config.ts") and not built by
 * tsconfig.build.json ("src"), so it cannot affect the application or the
 * Phase 5 checks. It reads staging configuration only and never touches
 * .env.prod, the database or any container.
 *
 * It reuses the server's own validators -- parseIDKitResult, findProofOfHuman,
 * isBoundToReviewer, createRpContextSigner -- so a pass here means the real
 * Record Server would accept the proof, rather than meaning some reimplemented
 * approximation accepted it.
 *
 * Secrets: the signing key is read, used and never printed. The only thing
 * derived from it that is shown is a yes/no address comparison.
 *
 * Usage:
 *   cd server && npx tsx scripts/phase1-simulator-gate.ts          # all stages
 *   cd server && npx tsx scripts/phase1-simulator-gate.ts --preflight-only
 *
 * --preflight-only runs stages A and B.
 *
 * Measured, not assumed: IDKit.request() only opens a bridge session. It does
 * NOT validate the RP id or the rp_context signature -- a request opens
 * perfectly well with a randomly generated key against any rp_ string. Those
 * are checked by World App and the Portal when the proof comes back, so
 * unknown_rp / inactive_rp / invalid_rp_signature surface in stage C, not here.
 * Preflight therefore proves the configuration is well-formed and locally
 * signable, and nothing more.
 */

import { readFileSync } from 'node:fs';

import { IDKit, proofOfHuman } from '@worldcoin/idkit-core';
import { privateKeyToAccount } from 'viem/accounts';

import { reviewAgentAction } from '../src/worldid/action.ts';
import {
  PROOF_OF_HUMAN_IDENTIFIER,
  PROOF_OF_HUMAN_SCHEMA_ID,
  findProofOfHuman,
  isBoundToReviewer,
  normalizeNullifier,
  parseIDKitResult,
} from '../src/worldid/proof.ts';
import { createRpContextSigner } from '../src/worldid/signing.ts';

const ENV_PATH = process.env.STAGING_ENV_FILE ?? '/Users/parthdagia/receipt/.env.staging';
const PORTAL_BASE = 'https://developer.world.org';
const EXPECTED_ENVIRONMENT = 'staging';

/** A throwaway agent id, so the action has the real shape without naming a real agent. */
const GATE_AGENT_ID = 999999n;

/** A throwaway signal. Not a wallet anyone controls; it only has to bind. */
const GATE_SIGNAL = '0x000000000000000000000000000000000000dEaD';

const preflightOnly = process.argv.includes('--preflight-only');

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): boolean {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  -- ${detail}`}`);
  return ok;
}

/**
 * Classify a value's *shape* so a parse failure can be diagnosed without
 * printing proof material. Identifiers and booleans are safe to show; anything
 * that could be cryptographic material is reduced to a format label.
 */
function shapeOf(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `array(${value.length}) of [${[...new Set(value.map(shapeOf))].join(', ')}]`;
  }
  if (typeof value !== 'string') return typeof value;

  // Short, non-secret descriptors are worth seeing in full.
  if (/^(app_|rp_|review-agent-|production$|staging$|sandbox$|proof_of_human$)/.test(value)) {
    return `"${value}"`;
  }
  if (/^[0-9]+$/.test(value)) return `decimal string (len ${value.length})`;
  if (/^0x[0-9a-fA-F]+$/.test(value)) return `0x-hex (len ${value.length}, ${(value.length - 2) / 2} bytes)`;
  if (/^[0-9a-fA-F]+$/.test(value)) return `bare hex (len ${value.length})`;
  return `string (len ${value.length})`;
}

/** Print the payload's structure, with every value reduced to a shape. */
function describePayload(payload: unknown): void {
  console.log('\n  --- payload shape (values withheld) ---');
  const result = payload as Record<string, unknown>;
  const isObjectArray = (v: unknown): v is Record<string, unknown>[] =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'object' && e !== null);

  for (const [k, v] of Object.entries(result)) {
    if (isObjectArray(v)) continue;
    console.log(`    ${k.padEnd(20)} ${shapeOf(v)}`);
  }
  // Descend into any array of objects -- `responses` on the IDKit payload,
  // `results` on the Portal's verification response.
  for (const [k, v] of Object.entries(result)) {
    if (!isObjectArray(v)) continue;
    v.forEach((item, i) => {
      console.log(`    ${k}[${i}]:`);
      for (const [ik, iv] of Object.entries(item)) {
        console.log(`      ${ik.padEnd(18)} ${shapeOf(iv)}`);
      }
    });
  }
  console.log('  ---------------------------------------');
}

function fatal(message: string): never {
  console.log(`\nSTOP: ${message}`);
  process.exit(1);
}

/** Minimal KEY=VALUE reader. Values are not logged. */
function readEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    fatal(
      `cannot read ${path}. Create it with the staging values ` +
        `(WORLD_APP_ID_STAGING, WORLD_RP_ID_STAGING, WORLD_SIGNING_KEY_STAGING).`,
    );
  }

  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

async function main(): Promise<void> {
  console.log('Phase 1 gate -- World ID Simulator credential check');
  console.log(`env file: ${ENV_PATH}\n`);

  // ---- Stage A: configuration, offline -------------------------------------
  console.log('Stage A  configuration (offline, no network)');

  const env = readEnvFile(ENV_PATH);

  /** Accept both the _STAGING-suffixed names and the plain ones. */
  const pick = (name: string): string => env[`${name}_STAGING`] ?? env[name] ?? '';

  const appId = pick('WORLD_APP_ID');
  const rpId = pick('WORLD_RP_ID');
  const expectedSigner = pick('WORLD_SIGNER_ADDRESS');

  // The key may be held out of the env file entirely, in a 0600 JSON file
  // named by WORLD_SIGNING_KEY_FILE. That is the better arrangement, so it is
  // supported here -- but note that server/src/config/env.ts reads only
  // WORLD_SIGNING_KEY and has no such indirection, so a backend started from
  // this file alone would fail to boot.
  let signingKey = pick('WORLD_SIGNING_KEY');
  const keyFile = pick('WORLD_SIGNING_KEY_FILE');
  if (signingKey === '' && keyFile !== '') {
    try {
      const parsed = JSON.parse(readFileSync(keyFile, 'utf8')) as Record<string, unknown>;
      const fromFile = parsed.privateKey ?? parsed.private_key ?? parsed.signingKey;
      if (typeof fromFile !== 'string') {
        fatal(`${keyFile} has no string "privateKey" field.`);
      }
      signingKey = fromFile;
      console.log(`  note: signing key read from ${keyFile}`);
    } catch (error) {
      fatal(`cannot read the signing key file: ${(error as Error).message}`);
    }
  }

  const declaredEnvironment = pick('WORLD_ENVIRONMENT');
  check(
    `WORLD_ENVIRONMENT is "${EXPECTED_ENVIRONMENT}"`,
    declaredEnvironment === EXPECTED_ENVIRONMENT,
    declaredEnvironment === '' ? 'not set' : declaredEnvironment,
  );

  check('app id present and app_-prefixed', /^app_[A-Za-z0-9_-]+$/.test(appId), appId);
  check('rp id present and rp_-prefixed', /^rp_[A-Za-z0-9_-]+$/.test(rpId), rpId);
  check('signing key available', signingKey !== '', '(value withheld)');
  check(
    'staging app id differs from production',
    appId !== 'app_7de77482d1055cc43c0c5a2a7ede66a5',
    'production app must not be used for the gate',
  );
  check(
    'staging rp id differs from production',
    rpId !== 'rp_d3afb91156ea1942',
    'production RP must not be used for the gate',
  );

  if (failures > 0) fatal('fix the staging configuration above before continuing.');

  // The signing key is a secp256k1 scalar; its address is public. Comparing it
  // to the Portal's signer address catches a truncated or wrong-app key here,
  // instead of as an opaque invalid_rp_signature later.
  if (expectedSigner === '') {
    console.log('  SKIP  signer address comparison (WORLD_SIGNER_ADDRESS_STAGING not set)');
  } else {
    let derived: string;
    try {
      const normalized = signingKey.startsWith('0x') ? signingKey : `0x${signingKey}`;
      derived = privateKeyToAccount(normalized as `0x${string}`).address;
    } catch {
      check('signing key is a valid secp256k1 scalar', false, 'key rejected by viem');
      fatal('the staging signing key is malformed. Re-download it from the Developer Portal.');
    }
    check(
      'signing key derives the Portal signer address',
      derived.toLowerCase() === expectedSigner.toLowerCase(),
      `derived ${derived}, expected ${expectedSigner}`,
    );
  }

  if (failures > 0) fatal('the staging key does not match the staging RP.');

  // ---- Stage B: open a bridge session, no proof consumed --------------------
  console.log('\nStage B  open bridge session (nothing scanned, no proof consumed)');
  console.log('  NOTE: this does not validate the RP id or the signature.');

  const action = reviewAgentAction(GATE_AGENT_ID);
  let rpContext;
  try {
    rpContext = createRpContextSigner({ signingKeyHex: signingKey, rpId })(action);
  } catch (error) {
    check('rp_context signed', false, error instanceof Error ? error.name : 'unknown error');
    fatal('could not sign an rp_context with the staging key.');
  }
  check('rp_context signed', true, `action ${action}`);

  let request;
  try {
    request = await IDKit.request({
      app_id: appId as `app_${string}`,
      action,
      rp_context: rpContext,
      environment: EXPECTED_ENVIRONMENT,
      allow_legacy_proofs: false,
    }).preset(proofOfHuman({ signal: GATE_SIGNAL }));
  } catch (error) {
    const code = (error as { code?: string })?.code ?? (error as Error)?.message ?? 'unknown';
    check('bridge session created', false, String(code));
    fatal(`could not open a staging bridge session: ${String(code)}`);
  }

  check('bridge session created', true, 'connector URI issued');

  if (preflightOnly) {
    console.log(`\n${checks - failures}/${checks} checks passed. Preflight only -- stopping here.`);
    console.log('Proven: the staging values are well-formed and the key signs an rp_context.');
    console.log('NOT proven: that World recognises this RP id, or that this key is its');
    console.log('registered key. Both are only answered once a proof comes back (stage C).');
    process.exit(failures === 0 ? 0 : 1);
  }

  // ---- Stage C: scan in the Simulator --------------------------------------
  console.log('\nStage C  waiting for the Simulator');
  console.log('  Open https://simulator.worldcoin.org and paste this connector URI.');
  console.log('  It is single-use, staging-only and expires in ~5 minutes.\n');
  console.log(`  ${request.connectorURI}\n`);

  const outcome = await request.pollUntilCompletion();
  if (!outcome.success) {
    const code = String((outcome as { error?: unknown }).error ?? 'unknown');
    check('Simulator completed the request', false, code);
    if (code.includes('credential_unavailable')) {
      fatal(
        'The Simulator cannot issue proof_of_human (issuer_schema_id 1). ' +
          'This is the gate failing honestly -- do NOT weaken the check. Report and stop.',
      );
    }
    // These three are the first point at which World checks the RP at all.
    if (code.includes('unknown_rp')) {
      fatal(
        `World does not recognise ${rpId}. Re-copy the RP id from the Developer Portal ` +
          '(check for a dropped or extra character).',
      );
    }
    if (code.includes('inactive_rp')) {
      fatal(`${rpId} exists but is inactive. Activate it in the Developer Portal.`);
    }
    if (code.includes('invalid_rp_signature')) {
      fatal('the staging signing key is not the key registered for this RP.');
    }
    fatal(`the Simulator did not complete the request: ${code}`);
  }
  check('Simulator completed the request', true);

  // ---- Stage D: does it satisfy the Record Server? --------------------------
  console.log('\nStage D  the server\'s own validators');

  let parsed;
  try {
    parsed = parseIDKitResult(outcome.result);
    check('parseIDKitResult accepts the payload', true, `protocol 4.0, action ${parsed.action}`);
  } catch (error) {
    check('parseIDKitResult accepts the payload', false, (error as Error).message);
    describePayload(outcome.result);
    // Deliberately not fatal. The nullifier our server actually stores comes
    // from the Portal's verified response, not from this payload, so the
    // question that decides the fix is whether the Portal accepts it. Stopping
    // here would leave that unanswered and cost another scan.
    console.log('  -> continuing to the Portal anyway, to learn whether World accepts it');
  }

  if (parsed !== undefined) {
    check('action matches the one we signed', parsed.action === action, parsed.action);
    check(
      `environment is "${EXPECTED_ENVIRONMENT}"`,
      parsed.environment === EXPECTED_ENVIRONMENT,
      String(parsed.environment),
    );

    const credential = findProofOfHuman(parsed);
    check(
      `a ${PROOF_OF_HUMAN_IDENTIFIER} credential with issuer_schema_id ${PROOF_OF_HUMAN_SCHEMA_ID} is present`,
      credential !== undefined,
      credential === undefined
        ? `got: ${parsed.responses.map((r) => `${r.identifier}/schema ${r.issuer_schema_id}`).join(', ') || 'none'}`
        : 'found',
    );

    if (credential === undefined) {
      fatal(
        'The Simulator did not issue proof_of_human with issuer_schema_id 1. ' +
          'This is the gate failing. Do NOT accept a different credential or relax the check.',
      );
    }

    check('proof is bound to the signal', isBoundToReviewer(credential, GATE_SIGNAL));
    // World sends hex; the server canonicalises to decimal. Assert what the
    // server asserts -- that it is a field element in either encoding -- rather
    // than re-imposing the decimal-only rule this script helped disprove.
    check(
      'nullifier is a field element (either encoding)',
      normalizeNullifier(credential.nullifier) !== undefined,
      credential.nullifier === undefined ? 'absent' : 'present (value withheld)',
    );
  }

  // ---- Stage E: independent Portal verification -----------------------------
  console.log('\nStage E  independent verification at the Developer Portal');

  const response = await fetch(`${PORTAL_BASE}/api/v4/verify/${rpId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(outcome.result),
    signal: AbortSignal.timeout(20_000),
  });
  // The Portal returns `results`, matching verifyClient.ts's VerifySuccessResponse.
  const verified = (await response.json()) as {
    environment?: string;
    results?: { identifier?: string; success?: boolean; nullifier?: string }[];
  };

  check('Portal returned 200', response.status === 200, `HTTP ${response.status}`);
  check(
    `Portal reports environment "${EXPECTED_ENVIRONMENT}"`,
    verified.environment === undefined || verified.environment === EXPECTED_ENVIRONMENT,
    String(verified.environment),
  );
  check(
    'Portal verified the proof_of_human credential',
    (verified.results ?? []).some(
      (r) => r.identifier === PROOF_OF_HUMAN_IDENTIFIER && r.success === true,
    ),
    JSON.stringify((verified.results ?? []).map((r) => `${r.identifier}:${r.success}`)),
  );

  // The decisive detail: reviewProof.ts stores THIS nullifier, not the one in
  // the browser payload, and requires it to be decimal. If the Portal returns
  // decimal here, the hex in the IDKit payload never reaches the database.
  console.log('\n  --- Portal response shape (values withheld) ---');
  describePayload(verified);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures === 0) {
    console.log('GATE PASSED -- the Simulator issues the credential the Record Server requires.');
  } else {
    console.log('GATE FAILED -- do not proceed to Phase 2. Report the failing checks.');
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.log(`\nSTOP: unexpected error: ${error instanceof Error ? error.message : 'unknown'}`);
  process.exit(1);
});
