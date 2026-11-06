import { Hono } from 'hono';
import { computeReputation } from '../reputation/engine.js';
import type { ReviewInput } from '../reputation/engine.js';
import {
  DEFAULT_SEED,
  GENERATOR,
  MAX_TRIALS,
  SUCCESS_THRESHOLD,
  runGauntlet,
} from '../reputation/gauntlet.js';
import {
  REVIEW_TYPE_FREE,
  REVIEW_TYPE_PAID,
  REVIEW_TYPE_WALLET,
  walletNullifier,
} from '../reputation/spec.js';
import { serializeTiers } from './reputation.js';

/**
 * `POST /api/reputation/simulate` — run the scoring engine on made-up data.
 *
 * Exists so the manipulation-resistance claim can be demonstrated rather than
 * asserted: feed it honest reviews plus attackers and watch the weighted
 * median hold while the mean moves. It runs the SAME `computeReputation` the
 * live endpoint uses, so the demo cannot drift away from the real behaviour.
 *
 * Deliberately separate from `GET /api/agents/:id/reputation`:
 *
 *   - It reads no chain state and writes none.
 *   - It accepts client-supplied reviews, which the live endpoint must never
 *     do; that is exactly why it is a different route with a different name.
 *   - Its response carries `simulated: true` and no evidence hash. A manifest
 *     hash over invented reviews would be a real-looking digest for data that
 *     never existed, which is the one thing this must not produce.
 */

const MAX_SIMULATED_REVIEWS = 500;

interface SimulatedReview {
  readonly value: number;
  readonly reviewType: number;
  readonly paymentAmount?: string;
  readonly revoked?: boolean;
}

function parseReviews(raw: unknown): SimulatedReview[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SIMULATED_REVIEWS) return null;

  const parsed: SimulatedReview[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;

    const value = record['value'];
    if (typeof value !== 'number' || !Number.isInteger(value)) return null;

    const reviewType = record['reviewType'];
    if (
      reviewType !== REVIEW_TYPE_FREE &&
      reviewType !== REVIEW_TYPE_PAID &&
      reviewType !== REVIEW_TYPE_WALLET
    ) {
      return null;
    }

    const paymentAmount = record['paymentAmount'];
    if (paymentAmount !== undefined && !/^\d+$/.test(String(paymentAmount))) return null;

    const revoked = record['revoked'];
    if (revoked !== undefined && typeof revoked !== 'boolean') return null;

    parsed.push({
      value,
      reviewType,
      ...(paymentAmount === undefined ? {} : { paymentAmount: String(paymentAmount) }),
      ...(revoked === undefined ? {} : { revoked }),
    });
  }
  return parsed;
}

export function reputationSimulateRoute(): Hono {
  const app = new Hono();

  /**
   * `POST /api/reputation/simulate/gauntlet` — the Monte Carlo attack batch.
   *
   * Same footing as the single-scenario endpoint above: synthetic data only,
   * scored by the production engine, no chain reads or writes, `simulated:
   * true`, no evidence hash. Deterministic for a given (seed, trials), so a
   * reported result can be reproduced by anyone running the same request.
   */
  app.post('/api/reputation/simulate/gauntlet', async (c) => {
    let body: unknown = {};
    const text = await c.req.text();
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const input = body as Record<string, unknown>;

    const rawTrials = input['trials'] ?? MAX_TRIALS;
    if (
      typeof rawTrials !== 'number' ||
      !Number.isInteger(rawTrials) ||
      rawTrials < 1 ||
      rawTrials > MAX_TRIALS
    ) {
      return c.json(
        { error: 'invalid_trials', message: `trials must be an integer 1..${MAX_TRIALS}` },
        400,
      );
    }

    const rawSeed = input['seed'] ?? DEFAULT_SEED;
    if (
      typeof rawSeed !== 'number' ||
      !Number.isInteger(rawSeed) ||
      rawSeed < 0 ||
      rawSeed > 0xffffffff
    ) {
      return c.json({ error: 'invalid_seed', message: 'seed must be a uint32' }, 400);
    }

    const result = runGauntlet(rawTrials, rawSeed);

    return c.json(
      {
        simulated: true,
        trials: result.trials,
        seed: result.seed,
        success_threshold: SUCCESS_THRESHOLD,
        minority_trials: result.minorityTrials,
        generator: {
          honest_min: GENERATOR.honestMin,
          honest_max: GENERATOR.honestMax,
          honest_rating_min: GENERATOR.honestRatingMin,
          honest_rating_max: GENERATOR.honestRatingMax,
          attackers_min: GENERATOR.attackersMin,
          attackers_max: GENERATOR.attackersMax,
          attack_ratings: GENERATOR.attackRatings,
        },
        mean: {
          corrupted: result.mean.corrupted,
          protected: result.mean.protected,
          withheld: result.mean.withheld,
          corrupted_below_half_weight: result.mean.corruptedBelowHalfWeight,
          escaped: result.mean.escaped,
          escaped_below_half_weight: result.mean.escapedBelowHalfWeight,
        },
        median: {
          corrupted: result.median.corrupted,
          protected: result.median.protected,
          withheld: result.median.withheld,
          corrupted_below_half_weight: result.median.corruptedBelowHalfWeight,
          escaped: result.median.escaped,
          escaped_below_half_weight: result.median.escapedBelowHalfWeight,
        },
      },
      200,
    );
  });

