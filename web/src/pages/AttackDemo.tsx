import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DescriptionList,
  DescriptionRow,
  Field,
  Notice,
  Skeleton,
  Stat,
  StatGrid,
} from '../components/ui';
import { ShieldIcon } from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { describeApiError, runAttackGauntlet, simulateReputation } from '../lib/api';
import type { GauntletResponse, SimulatedReviewInput } from '../lib/api';
import styles from './pages.module.css';

/**
 * The manipulation demonstration.
 *
 * Every number on this page is computed from reviews invented for the request
 * and scored by the SAME engine the live endpoint uses — there is no demo
 * approximation of the scoring that could drift from production. Nothing here
 * reads or writes chain state, no attack is submitted anywhere, and the
 * endpoint returns no evidence hash.
 *
 * The real-chain anchor is test/AttackLab.t.sol: a mainnet-fork experiment in
 * which six fresh wallets dragged a live agent's registry mean from 50 to 77.
 * The gauntlet generalises that single incident to thousands of randomized
 * scenarios.
 */

const HONEST_VALUE = 50;
const ATTACK_VALUE = 100;

/** Animate a number from 0 to its target. Presentation only: the target is
 *  the real result before the animation starts. */
function useCountUp(target: number | null, durationMs = 1200): number | null {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    if (target === null) {
      setValue(null);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function GauntletPane({
  title,
  subtitle,
  tone,
  corrupted,
  trials,
  corruptedMinority,
  escaped,
  escapedMinority,
  withheld,
}: {
  title: string;
  subtitle: string;
  tone: 'danger' | 'success';
  corrupted: number | null;
  trials: number;
  corruptedMinority: number | null;
  escaped: number | null;
  escapedMinority: number | null;
  withheld: number | null;
}) {
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--success)';
  return (
    <Card padded>
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        <div>
          <div style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>
            {subtitle}
          </div>
        </div>
        <div>
          <span
            style={{ fontSize: 44, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums' }}
          >
            {corrupted === null ? '—' : corrupted.toLocaleString()}
          </span>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginLeft: 8 }}>
            of {trials.toLocaleString()} attacks corrupted the score
            {corrupted === null ? '' : ` (${percent(corrupted, trials)})`}
          </span>
          {corrupted !== null && corruptedMinority !== null && (
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 4 }}>
              {(corrupted - corruptedMinority).toLocaleString()} by majority gangs — unwinnable for
              any scoring rule — and {corruptedMinority.toLocaleString()} by minorities
            </div>
          )}
        </div>
        <DescriptionList>
          <DescriptionRow term="Pushed past every honest rating">
            {escaped === null ? '—' : `${escaped.toLocaleString()} (${percent(escaped, trials)})`}
          </DescriptionRow>
          <DescriptionRow term="…of those, with a minority of weight">
            {escapedMinority === null ? '—' : escapedMinority.toLocaleString()}
          </DescriptionRow>
          <DescriptionRow term="Publication withheld (under 5 humans)">
            {withheld === null
              ? '—'
              : withheld === 0
                ? 'never — always publishes'
                : `${withheld.toLocaleString()} trials`}
          </DescriptionRow>
        </DescriptionList>
      </div>
    </Card>
  );
}

function GauntletSection() {
  const [result, setResult] = useState<GauntletResponse | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const meanCorrupted = useCountUp(result === null ? null : result.mean.corrupted);
  const medianCorrupted = useCountUp(result === null ? null : result.median.corrupted);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await runAttackGauntlet());
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="The gauntlet"
        description="10,000 randomized attack scenarios, each scored twice over the identical reviews: once with the registry's arithmetic mean, once with the Receipts weighted median. Scoring runs through the production engine, not a demo copy."
      />
      <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-5)' }}>
        <div style={{ display: 'grid', justifyItems: 'center', gap: 'var(--space-3)' }}>
          <Button variant="primary" size="md" onClick={() => void run()} disabled={running}>
            {running
              ? 'Scoring 10,000 scenarios…'
              : result === null
                ? 'Run 10,000 simulated attacks'
                : 'Run again (same seed, same result)'}
          </Button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Random honest crowds (3–20 humans rating 40–60) vs attacker gangs (1–25, all rating 100
            or all 0). Deterministic seed — anyone re-running gets these exact numbers.
          </span>
        </div>

        {error !== null && <Notice tone="danger">{error}</Notice>}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 'var(--space-4)',
          }}
        >
          <GauntletPane
            title="ERC-8004 registry mean"
            subtitle="The scoring rule deployed on mainnet today: a plain average anyone can write into."
            tone="danger"
            corrupted={meanCorrupted}
            trials={result?.trials ?? 10_000}
            corruptedMinority={result?.mean.corrupted_below_half_weight ?? null}
            escaped={result?.mean.escaped ?? null}
            escapedMinority={result?.mean.escaped_below_half_weight ?? null}
            withheld={result?.mean.withheld ?? null}
          />
          <GauntletPane
            title="Receipts weighted median"
            subtitle="Verified humans only, scored by the weighted median with a five-human floor."
            tone="success"
            corrupted={medianCorrupted}
            trials={result?.trials ?? 10_000}
            corruptedMinority={result?.median.corrupted_below_half_weight ?? null}
            escaped={result?.median.escaped ?? null}
            escapedMinority={result?.median.escaped_below_half_weight ?? null}
            withheld={result?.median.withheld ?? null}
          />
        </div>

        {result !== null && (
          <>
            <Notice tone={result.median.escaped_below_half_weight === 0 ? 'info' : 'danger'}>
              In {result.minority_trials.toLocaleString()} of these trials the attackers held under
              half the weight — the region where a defense is even possible (a majority defeats any
              aggregation rule). There, the mean was pushed past every honest rating{' '}
              {result.mean.escaped_below_half_weight.toLocaleString()} times — the median{' '}
              {result.median.escaped_below_half_weight.toLocaleString()} times. That zero is the
              median&rsquo;s breakdown-point guarantee, not luck: a minority can shift it between
              honest opinions (counted above as corrupted when it moved {result.success_threshold}+
              points), but can never push it beyond what some honest reviewer actually said.
            </Notice>

            <DescriptionList>
              <DescriptionRow term="Attack counted as corruption">
                published score moved ≥ {result.success_threshold} points, or a score was minted
                where honest reviews alone published none
              </DescriptionRow>
              <DescriptionRow term="Withheld">
                under {5} distinct verified humans — the engine publishes nothing; never counted as
                a defense
              </DescriptionRow>
              <DescriptionRow term="Reproduce it">
                <span className="mono">
                  POST /api/reputation/simulate/gauntlet {JSON.stringify({ seed: result.seed })}
                </span>
              </DescriptionRow>
            </DescriptionList>
          </>
        )}
      </div>
    </Card>
  );
}

export function AttackDemo() {
  const [honestCount, setHonestCount] = useState(5);
  const [attackerCount, setAttackerCount] = useState(4);

  const reviews = useMemo<SimulatedReviewInput[]>(
    () => [
      ...Array.from({ length: honestCount }, () => ({
        value: HONEST_VALUE,
        reviewType: 0,
      })),
      ...Array.from({ length: attackerCount }, () => ({
        value: ATTACK_VALUE,
        reviewType: 0,
      })),
    ],
    [honestCount, attackerCount],
  );

  const result = useAsync(() => simulateReputation(reviews), [reviews]);

  const total = honestCount + attackerCount;
  const attackerShare = total === 0 ? 0 : Math.round((attackerCount / total) * 100);
  const majority = attackerCount * 2 >= total;

  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Attack demo <span className={styles.pageTitleMuted}>· Simulated</span>
          </h1>
          <p className={styles.pageSubtitle}>
            Why Receipts uses a weighted median instead of the registry average.
          </p>
        </div>
        <Badge tone="warning" dot>
          Synthetic data
        </Badge>
      </div>

      <Notice tone="warning">
        Nothing on this page is real and no attack is submitted to mainnet or any other chain. These
        reviews exist only inside each request, no agent&rsquo;s reputation is affected, and no
        chain state is read or written. The calculation is the same engine the live endpoint uses,
        so what you see here is how the real scoring behaves. The one real-chain experiment is the
        mainnet-fork AttackLab (<span className="mono">test/AttackLab.t.sol</span>), where six fresh
        wallets dragged a live agent&rsquo;s registry mean from 50 to 77 — see{' '}
        <Link to="/docs">Documentation</Link>.
      </Notice>

      <GauntletSection />

      <Card>
        <CardHeader
          title="Explore one scenario"
          description={`${honestCount} honest reviewers rating ${HONEST_VALUE}, ${attackerCount} attackers rating ${ATTACK_VALUE}`}
        />
        <div style={{ padding: 'var(--space-5)', display: 'grid', gap: 'var(--space-5)' }}>
          <Field label={`Honest reviewers: ${honestCount}`}>
            <input
              type="range"
              className={styles.slider}
              min={1}
              max={20}
              value={honestCount}
              onChange={(e) => setHonestCount(Number(e.target.value))}
              aria-label="Honest reviewers"
            />
          </Field>
          <Field
            label={`Attackers: ${attackerCount}`}
            hint={`${attackerShare}% of reviewers${majority ? ' — at or above half the weight, outside the guarantee' : ''}`}
          >
            <input
              type="range"
              className={styles.slider}
              min={0}
              max={20}
              value={attackerCount}
              onChange={(e) => setAttackerCount(Number(e.target.value))}
              aria-label="Attackers"
            />
          </Field>
        </div>
      </Card>

      {result.loading ? (
        <StatGrid>
          {[0, 1, 2].map((i) => (
            <Card key={i} padded>
              <Skeleton height={48} />
            </Card>
          ))}
        </StatGrid>
      ) : result.error !== null || result.data == null ? (
        <Notice tone="danger">
          The simulation endpoint did not answer. The Record Server must be running for this page.
        </Notice>
      ) : (
        <>
          <StatGrid>
            <Stat
              label="Receipts Reputation"
              value={result.data.status === 'published' ? String(result.data.score) : null}
              icon={<ShieldIcon size={15} />}
              hint={
                result.data.status === 'published'
                  ? 'Weighted median — unmoved while attackers hold under half the weight'
                  : `Needs ${result.data.threshold} verified humans; ${result.data.distinct_humans} here`
              }
            />
            <Stat
              label="ERC-8004 registry mean"
              value={
                result.data.unweighted_mean === null ? null : String(result.data.unweighted_mean)
              }
              hint="The plain average every attacker moves"
            />
            <Stat
              label="Attacker weight share"
              value={`${attackerShare}%`}
              hint={
                majority ? 'At or above 50%: no guarantee applies' : 'Below 50%: the bound holds'
              }
              status={
                majority ? (
                  <Badge tone="danger" dot>
                    Outside bound
                  </Badge>
                ) : (
                  <Badge tone="success" dot>
                    Protected
                  </Badge>
                )
              }
            />
          </StatGrid>

          <Card>
            <CardHeader title="What this shows" />
            <DescriptionList>
              <DescriptionRow term="Honest rating">{HONEST_VALUE}</DescriptionRow>
              <DescriptionRow term="Attacker rating">{ATTACK_VALUE}</DescriptionRow>
              <DescriptionRow term="Median moved by">
                {result.data.status === 'published' && result.data.score !== null
                  ? `${result.data.score - HONEST_VALUE} points`
                  : 'no score published'}
              </DescriptionRow>
              <DescriptionRow term="Mean moved by">
                {result.data.unweighted_mean === null
                  ? '—'
                  : `${result.data.unweighted_mean - HONEST_VALUE} points`}
              </DescriptionRow>
            </DescriptionList>
          </Card>

          <Notice tone="info">
            In Receipts each of these reviewers would need a distinct World ID nullifier, which the
            on-chain NullifierRegistry enforces as one per human per agent. The attack above costs
            one address per vote against a mean, and one <em>human</em> per vote against this score.
          </Notice>
        </>
      )}

      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setHonestCount(5);
            setAttackerCount(4);
          }}
        >
          Reset scenario
        </Button>
      </div>
    </>
  );
}
