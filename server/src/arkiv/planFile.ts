import { addr, bool, dec, i32, key, str, u256, u64 } from '@arkiv-network/sdk/schema';
import { bytesToHex, hexToBytes, keccak256, toBytes } from 'viem';
import type { Address, Hex } from 'viem';
import { canonicalJson } from '../reputation/evidence.js';
import type { PlannedCreate, PlannedExtension, PublicationPlan } from './publisher.js';

/**
 * The plan as a file: what a dry run writes and `--execute` sends.
 *
 * Approval is of this file. Its hash is printed by the dry run, and execute
 * refuses unless the file still hashes to the confirmed value, so nothing is
 * recomputed between "this is what will be written" and writing it. (A
 * recomputed plan would differ anyway: snapshots name the Sepolia block they
 * were taken at.)
 */
export interface PlanFile {
  readonly version: 1;
  readonly publisher: Address;
  readonly arkivChainId: number;
  readonly creates: readonly {
    kind: PlannedCreate['kind'];
    id: string;
    values: Record<string, unknown>;
  }[];
  readonly extensions: readonly PlannedExtension[];
}

type Encoded = string | number | boolean | { type: string; value: string } | { bytes: Hex };

function encodeValue(value: unknown): Encoded {
  if (value instanceof Uint8Array) return { bytes: bytesToHex(value) };
  if (typeof value === 'object' && value !== null && 'type' in value && 'value' in value) {
    const tagged = value as { type: string; value: unknown };
    return { type: tagged.type, value: String(tagged.value) };
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  throw new Error(`plan file: cannot encode a ${typeof value}`);
}

const CONSTRUCTORS: Record<string, (raw: string) => unknown> = {
  u64: (raw) => u64(BigInt(raw)),
  u256: (raw) => u256(BigInt(raw)),
  i32: (raw) => i32(Number(raw)),
  addr: (raw) => addr(raw),
  str: (raw) => str(raw),
  dec: (raw) => dec(raw),
  key: (raw) => key(raw as Hex),
  bool: (raw) => bool(raw === 'true'),
};

function decodeValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null) {
    if ('bytes' in value) return hexToBytes((value as { bytes: Hex }).bytes);
    const { type, value: raw } = value as { type: string; value: string };
    const make = CONSTRUCTORS[type];
    if (make === undefined) throw new Error(`plan file: unknown value type ${type}`);
    return make(raw);
  }
  return value;
}

export function toPlanFile(
  plan: PublicationPlan,
  publisher: Address,
  arkivChainId: number,
): PlanFile {
  return {
    version: 1,
    publisher,
    arkivChainId,
    creates: plan.creates.map((c) => ({
      kind: c.kind,
      id: c.id,
      values: Object.fromEntries(
        Object.entries(c.values as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, encodeValue(v)]),
      ),
    })),
    extensions: plan.extensions,
  };
}

/** keccak256 over the canonical JSON of the file: the value an approver confirms. */
export function planFileHash(file: PlanFile): Hex {
  return keccak256(toBytes(canonicalJson(file)));
}

/** Rebuild the SDK-typed plan. Values go back through the SDK constructors,
 *  so a hand-edited file is validated again rather than trusted. */
export function fromPlanFile(file: PlanFile): PublicationPlan {
  if (file.version !== 1) throw new Error('plan file: unsupported version');
  return {
    creates: file.creates.map(
      (c) =>
        ({
          kind: c.kind,
          id: c.id,
          values: Object.fromEntries(Object.entries(c.values).map(([k, v]) => [k, decodeValue(v)])),
        }) as PlannedCreate,
    ),
    extensions: file.extensions,
    unchanged: [],
    refused: [],
  };
}
