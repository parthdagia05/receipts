const UINT256_MAX = 2n ** 256n - 1n;

/**
 * Digits in the decimal form of uint256's maximum.
 *
 * Anything longer is out of range by construction, so it is rejected before
 * `BigInt` is asked to parse it — an unbounded digit string would otherwise make
 * the server do superlinear parsing work on a caller's behalf.
 */
const MAX_AGENT_ID_DIGITS = 78;

/** Prefix of the per-agent World ID action. */
export const ACTION_PREFIX = 'review-agent-';

/** A rejected `agentId`, naming the expectation rather than echoing a guess. */
export class InvalidAgentIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAgentIdError';
  }
}

/**
 * Parse an `agentId` supplied as a decimal string.
 *
 * A JSON number cannot carry a uint256, and a client that sends one has already
 * lost precision before the value reached us, so a number is rejected outright
 * rather than silently truncated.
 *
 * Leading zeros are rejected too. `"042"` and `"42"` would otherwise yield two
 * different action strings for one agent, and World ID derives the nullifier
 * from the action — so the same human could review that agent once under each
 * spelling. Only the canonical decimal is accepted.
 *
 * @throws InvalidAgentIdError when the value is not a positive uint256.
 */
export function parseAgentId(raw: unknown): bigint {
  if (raw === undefined || raw === null) {
    throw new InvalidAgentIdError('agentId is required');
  }
  if (typeof raw !== 'string') {
    throw new InvalidAgentIdError('agentId must be a decimal string, not a number');
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidAgentIdError('agentId must contain only decimal digits');
  }
  if (raw.length > 1 && raw.startsWith('0')) {
    throw new InvalidAgentIdError('agentId must not have leading zeros');
  }
  if (raw.length > MAX_AGENT_ID_DIGITS) {
    throw new InvalidAgentIdError('agentId must fit in uint256');
  }

  // A 78-digit value can still exceed the maximum, so the range check below
  // stays: the length bound only caps the parsing work.
  const agentId = BigInt(raw);
  if (agentId === 0n) {
    throw new InvalidAgentIdError('agentId must be greater than zero');
  }
  if (agentId > UINT256_MAX) {
    throw new InvalidAgentIdError('agentId must fit in uint256');
  }

  return agentId;
}

/**
 * The World ID action for reviewing one agent.
 *
 * Both review paths share it: personhood is per (human, agent), so a free and a
 * paid review of the same agent must yield the same nullifier. Splitting the
 * action by path would let one human post one of each.
 *
 * Built from the bigint's own decimal form, so the output is canonical whatever
 * the caller passed in.
 *
 * The action needs no prior registration: World ID 4.0 derives the nullifier
 * from (identity, rp_id, action), hashing the action into a field element, so a
 * new string is cryptographically scoped rather than looked up. What must be
 * registered is the RP itself — see `.env.example` for that prerequisite and
 * for the environment-scoping caveat.
 */
export function reviewAgentAction(agentId: bigint): string {
  return `${ACTION_PREFIX}${agentId.toString(10)}`;
}
