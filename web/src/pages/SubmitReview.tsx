import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Address, Hex } from 'viem';
import { QrCode } from '../components/QrCode';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Copyable,
  DescriptionList,
  DescriptionRow,
  EmptyState,
  ExternalLink,
  Field,
  Notice,
  Skeleton,
  TextArea,
} from '../components/ui';
import {
  AlertIcon,
  ArrowLeftIcon,
  CheckIcon,
  ExternalIcon,
  ShieldIcon,
  WalletIcon,
} from '../components/ui/Icons';
import { useAsync } from '../hooks/useAsync';
import { reviewGatewayAbi } from '../lib/abi';
import {
  attestReview,
  describeApiError,
  fetchReputation,
  fetchWalletReviewsEnabled,
  parseSubmitFunction,
  prepareReview,
  prepareWalletReview,
  requestWorldId,
  verifyProof,
} from '../lib/api';
import type { ReviewPrepareResponse, SerializedAttestation } from '../lib/api';
import { isSelfReview, loadAgentDetail } from '../lib/agents';
import { publicClient } from '../lib/chain';
import { addressUrl, config, txUrl } from '../lib/config';
import { shortAddress, shortHash } from '../lib/format';
import { availableMethods } from '../lib/features';
import { REVIEW_TYPE, WALLET_TOOLTIP } from '../lib/reviews';
import { VerificationBadge } from '../components/VerificationBadge';
import { prepareTypedData, toAttestationArgs } from '../lib/typedData';
import { createClient, isUserRejection } from '../lib/wallet';
import { describeWorldIdError, startVerification } from '../lib/worldId';
import { useWallet } from '../wallet/WalletProvider';
import styles from './pages.module.css';

/**
 * The free-review journey, in five steps.
 *
 * The protocol decides the order, not the interface: a World ID proof must
 * exist before a challenge can be prepared, the challenge must be signed by
 * the reviewer before the Record Server will attest, and only an attestation
 * the gateway recognises can be submitted. Each step therefore gates the next,
 * and nothing is faked forward.
 *
 * Only the free path is built. The paid path needs a settled USDC receipt,
 * and there is no client for `ReceiptSettler.settle` yet — offering a paid tab
 * that cannot complete would be worse than offering none.
 */

type Method = 'world_id' | 'wallet';

/**
 * Step labels per method. Indices are shared between methods so the state
 * machine stays one thing: the wallet path simply has no World ID step (1) and
 * ends at an authorisation (4) rather than an on-chain submission.
 */
const STEP_LABELS: Record<Method, readonly (readonly [number, string])[]> = {
  world_id: [
    [0, 'Agent'],
    [1, 'Verify'],
    [2, 'Review'],
    [3, 'Sign'],
    [4, 'Submit'],
  ],
  wallet: [
    [0, 'Agent'],
    [2, 'Review'],
    [3, 'Sign'],
    [4, 'Authorised'],
  ],
};
type StepIndex = 0 | 1 | 2 | 3 | 4;

const MAX_CONTENT_BYTES = 16_384;
const DEFAULT_RATING = 80;

interface VerifiedProof {
  readonly nullifier: string;
  readonly requestNonce: string;
}

function StepBar({ current, method }: { current: StepIndex; method: Method }) {
  const steps = STEP_LABELS[method];
  return (
    <div className={styles.steps}>
      {steps.map(([stepIndex, label], index) => {
        const done = stepIndex < current;
        const active = stepIndex === current;
        return (
          <div key={label} style={{ display: 'contents' }}>
            <div
              className={[
                styles.step,
                active ? styles.stepActive : '',
                done ? styles.stepDone : '',
              ].join(' ')}
            >
              <span
                className={[styles.stepNumber, done ? styles.stepNumberFilled : ''].join(' ')}
                style={done ? { color: 'var(--success)' } : undefined}
              >
                {done ? (
                  <CheckIcon size={11} style={{ color: 'var(--surface-base)' }} />
                ) : (
                  index + 1
                )}
              </span>
              {label}
            </div>
            {index < steps.length - 1 && <span className={styles.stepBar} />}
          </div>
        );
      })}
    </div>
  );
}

export function SubmitReview() {
  const { agentId: rawAgentId } = useParams<{ agentId: string }>();
  const wallet = useWallet();

  const valid = rawAgentId !== undefined && /^\d+$/.test(rawAgentId) && rawAgentId !== '0';
  const agentId = valid ? BigInt(rawAgentId) : 0n;

  const [step, setStep] = useState<StepIndex>(0);
  const [error, setError] = useState<string | null>(null);

  // The wallet flow is offered only while the server says it is enabled. A
  // failed or pending lookup counts as disabled.
  const walletStatus = useAsync(() => fetchWalletReviewsEnabled(), []);
  const methods = availableMethods(walletStatus.loading ? null : walletStatus.data);
  const [chosenMethod, setMethod] = useState<Method>('world_id');
  const method: Method = methods.includes(chosenMethod) ? chosenMethod : 'world_id';

  const [proof, setProof] = useState<VerifiedProof | null>(null);
  const [content, setContent] = useState('');
  const [rating, setRating] = useState(DEFAULT_RATING);
  const [challenge, setChallenge] = useState<ReviewPrepareResponse | null>(null);
  const [attestation, setAttestation] = useState<SerializedAttestation | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const agent = useAsync(() => loadAgentDetail(agentId), [agentId], { enabled: valid });

  const selfReview = useAsync(
    () =>
      wallet.address === null ? Promise.resolve(false) : isSelfReview(agentId, wallet.address),
    [agentId, wallet.address],
    { enabled: valid && wallet.address !== null },
  );

  if (!valid) {
    return (
      <Card>
        <EmptyState
          title="Invalid agent ID"
          body="Agent IDs are positive whole numbers."
          action={
            <Link to="/agents">
              <Button variant="secondary" size="sm">
                Browse agents
              </Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const reviewer = wallet.address;
  const blocked =
    reviewer === null
      ? 'wallet'
      : !wallet.isCorrectChain
        ? 'chain'
        : selfReview.data === true
          ? 'self'
          : null;

  return (
    <>
      <Link to={`/agents/${agentId.toString(10)}`} className={styles.backLink}>
        <ArrowLeftIcon size={14} />
        Agent #{agentId.toString(10)}
      </Link>

      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Submit a review{' '}
            <span className={styles.pageTitleMuted}>· Agent #{agentId.toString(10)}</span>
          </h1>
          <p className={styles.pageSubtitle}>
            {method === 'wallet'
              ? 'Your wallet signs the review. This does not prove you are one person.'
              : 'World ID proves you are a unique person, your wallet signs the review, and the gateway writes it to ERC-8004.'}
          </p>
        </div>
      </div>

      <Card className={styles.narrow}>
        <StepBar current={step} method={method} />

        <div className={styles.wizardBody}>
          {error !== null && <Notice tone="danger">{error}</Notice>}

          {step === 0 && (
            <StepSelectAgent
              agentId={agentId}
              loading={agent.loading}
              owner={agent.data?.owner ?? null}
              found={agent.data !== null}
              blocked={blocked}
              wallet={wallet}
              method={method}
              methods={methods}
              onMethod={(next) => {
                setMethod(next);
                setError(null);
              }}
            />
          )}

          {step === 1 && reviewer !== null && (
            <StepVerify
              agentId={agentId}
              reviewer={reviewer}
              onVerified={(result) => {
                setProof(result);
                setError(null);
                setStep(2);
              }}
              onError={setError}
            />
          )}

          {step === 2 && (
            <StepWrite
              method={method}
              content={content}
              rating={rating}
              onContent={setContent}
              onRating={setRating}
            />
          )}

          {step === 3 && challenge !== null && (
            <StepSign challenge={challenge} rating={rating} agentId={agentId} />
          )}

          {step === 4 && method === 'wallet' && (
            <StepAuthorised attestation={attestation} agentId={agentId} />
          )}

          {step === 4 && method === 'world_id' && (
            <StepSubmit
              attestation={attestation}
              txHash={txHash}
              confirmed={confirmed}
              agentId={agentId}
            />
          )}
        </div>

        <WizardFooter
          method={method}
          step={step}
          blocked={blocked}
          wallet={wallet}
          content={content}
          proof={proof}
          challenge={challenge}
          attestation={attestation}
          txHash={txHash}
          confirmed={confirmed}
          agentId={agentId}
          rating={rating}
          setStep={setStep}
          setError={setError}
          setChallenge={setChallenge}
          setAttestation={setAttestation}
          setTxHash={setTxHash}
          setConfirmed={setConfirmed}
        />
      </Card>
    </>
  );
}

/* --- Step 1: agent ------------------------------------------------------- */

export function StepSelectAgent({
  agentId,
  loading,
  owner,
  found,
  blocked,
  wallet,
  method,
  methods,
  onMethod,
}: {
  agentId: bigint;
  loading: boolean;
  owner: Address | null;
  found: boolean;
  blocked: string | null;
  wallet: ReturnType<typeof useWallet>;
  method: Method;
  methods: readonly Method[];
  onMethod: (method: Method) => void;
}) {
  if (loading) return <Skeleton height={120} />;

  if (!found) {
    return (
      <EmptyState
        title="Agent not found"
        body={`No agent with ID ${agentId.toString(10)} exists in the Identity Registry on ${config.chainName}.`}
        action={
          <Link to="/agents">
            <Button variant="secondary" size="sm">
              Browse agents
            </Button>
          </Link>
        }
      />
    );
  }

  return (
    <>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)' }}>Confirm the agent</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
          {method === 'wallet'
            ? 'Your review is bound to this agent ID and to your wallet address, so this wallet can review it once.'
            : 'Your review is bound to this agent ID. World ID scopes your nullifier to it, so you can review it once.'}
        </p>
      </div>

      {methods.length > 1 && (
        <div role="radiogroup" aria-label="Verification method" className={styles.methodChoice}>
          <button
            type="button"
            role="radio"
            aria-checked={method === 'world_id'}
            className={[styles.methodOption, method === 'world_id' ? styles.methodActive : ''].join(
              ' ',
            )}
            onClick={() => onMethod('world_id')}
          >
            <strong>World ID</strong>
            <span>Proves one unique person. Counted in the reputation score.</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={method === 'wallet'}
            className={[styles.methodOption, method === 'wallet' ? styles.methodActive : ''].join(
              ' ',
            )}
            onClick={() => onMethod('wallet')}
          >
            <strong>Wallet only</strong>
            <span>No World ID needed. Not proof of one person and not scored.</span>
          </button>
        </div>
      )}

      <Card>
        <DescriptionList>
          <DescriptionRow term="Agent">
            <span className="mono">#{agentId.toString(10)}</span>
          </DescriptionRow>
          <DescriptionRow term="Owner">
            {owner === null ? (
              '—'
            ) : (
              <ExternalLink href={addressUrl(owner)}>{shortAddress(owner)}</ExternalLink>
            )}
          </DescriptionRow>
          <DescriptionRow term="Review type">
            <VerificationBadge
              verification={method === 'wallet' ? 'wallet_only' : 'world_id_human'}
            />
          </DescriptionRow>
          <DescriptionRow term="Reviewing as">
            {wallet.address === null ? (
              <span style={{ color: 'var(--text-muted)' }}>Not connected</span>
            ) : (
              <Copyable value={wallet.address} display={shortAddress(wallet.address)} />
            )}
          </DescriptionRow>
        </DescriptionList>
      </Card>

      {blocked === 'wallet' && (
        <Notice tone="warning">
          Connect a wallet to continue. It signs your review and receives the on-chain attribution.
        </Notice>
      )}
      {blocked === 'chain' && (
        <Notice tone="warning">
          Your wallet is on another network. Receipts is deployed on {config.chainName}.
        </Notice>
      )}
      {blocked === 'self' && (
        <Notice tone="danger">
          This wallet is the agent&rsquo;s owner or an approved operator. The gateway rejects
          self-reviews, so this submission would revert on-chain.
        </Notice>
      )}
    </>
  );
}

/* --- Step 2: World ID ---------------------------------------------------- */

function StepVerify({
  agentId,
  reviewer,
  onVerified,
  onError,
}: {
  agentId: bigint;
  reviewer: Address;
  onVerified: (proof: VerifiedProof) => void;
  onError: (message: string) => void;
}) {
  const [connectorUri, setConnectorUri] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'opening' | 'waiting' | 'verifying'>('idle');
  const started = useRef(false);

  const begin = useCallback(async () => {
    setStatus('opening');
    onError('');
    try {
      const request = await requestWorldId(agentId.toString(10));
      const session = await startVerification(request, reviewer);

      setConnectorUri(session.connectorURI);
      setStatus('waiting');

      const result = await session.completion;

      setStatus('verifying');
      // Forwarded unchanged: the server validates it and relays the whole
      // payload to the Developer Portal, which is what actually verifies it.
      const verified = await verifyProof({
        agentId: agentId.toString(10),
        reviewer,
        proof: result,
      });

      onVerified({
        nullifier: verified.nullifier,
        requestNonce: request.rp_context.nonce,
      });
    } catch (err) {
      setStatus('idle');
      setConnectorUri(null);
      onError(
        err instanceof Error && err.name === 'ApiError'
          ? describeApiError(err)
          : describeWorldIdError(err) !== 'World ID verification failed.'
            ? describeWorldIdError(err)
            : describeApiError(err),
      );
    }
  }, [agentId, reviewer, onVerified, onError]);

  // Opened once on entry: the user already chose to come here, and making
  // them press a second button to see a QR code is friction without purpose.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void begin();
  }, [begin]);

  return (
    <>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)' }}>Verify you are a unique human</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
          Scan with World App. The proof is bound to your wallet address and scoped to this agent,
          so it cannot be reused for another wallet or another agent.
        </p>
      </div>

      <div className={styles.qrPanel}>
        {status === 'verifying' ? (
          <>
            <Skeleton height={208} width="208px" />
            <div className={styles.qrHint}>Verifying your proof with World ID…</div>
          </>
        ) : connectorUri === null ? (
          <>
            <Skeleton height={208} width="208px" />
            <div className={styles.qrHint}>Preparing a signed verification request…</div>
          </>
        ) : (
          <>
            <div className={styles.qrFrame}>
              <QrCode value={connectorUri} />
            </div>
            <div className={styles.qrHint}>
              Waiting for World App. Keep this tab open; the page updates as soon as you approve.
            </div>
            <a href={connectorUri} target="_blank" rel="noreferrer noopener">
              <Button variant="secondary" size="sm" icon={<ExternalIcon size={13} />}>
                Open in World App
              </Button>
            </a>
          </>
        )}
      </div>

      {status === 'idle' && (
        <Button variant="secondary" onClick={() => void begin()}>
          Restart verification
        </Button>
      )}
    </>
  );
}

/* --- Step 3: write ------------------------------------------------------- */

function StepWrite({
  method,
  content,
  rating,
  onContent,
  onRating,
}: {
  method: Method;
  content: string;
  rating: number;
  onContent: (value: string) => void;
  onRating: (value: number) => void;
}) {
  const bytes = new TextEncoder().encode(content).length;
  const tooLong = bytes > MAX_CONTENT_BYTES;

  return (
    <>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)' }}>Write your review</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
          The text is stored by the Record Server and committed on-chain by its keccak256 hash, so
          it cannot be swapped afterwards.
        </p>
      </div>

      <Field
        label="Rating"
        hint="A whole number from 0 to 100. Written to ERC-8004 with valueDecimals = 0."
      >
        <div className={styles.ratingRow}>
          <div className={styles.ratingValue}>{rating}</div>
          <input
            type="range"
            className={styles.slider}
            min={0}
            max={100}
            step={1}
            value={rating}
            onChange={(event) => onRating(Number(event.target.value))}
            aria-label="Rating out of 100"
          />
        </div>
      </Field>

      <Field
        label="What happened?"
        htmlFor="review-content"
        hint={
          <span style={{ color: tooLong ? 'var(--danger)' : undefined }}>
            {bytes.toLocaleString()} / {MAX_CONTENT_BYTES.toLocaleString()} bytes
          </span>
        }
      >
        <TextArea
          id="review-content"
          value={content}
          invalid={tooLong}
          onChange={(event) => onContent(event.target.value)}
          placeholder="What did you ask the agent to do, and how did it go? This gets published."
        />
      </Field>

      {method === 'wallet' ? (
        <Notice tone="warning">
          This is a <strong>wallet-verified</strong> review. {WALLET_TOOLTIP}
        </Notice>
      ) : (
        <Notice tone="info">
          This is a <strong>free, human-verified</strong> review. It is tagged{' '}
          <code>human-verified</code> in the Reputation Registry. Paid reviews additionally consume
          a settled USDC receipt and are not available in this app yet.
        </Notice>
      )}
    </>
  );
}

/* --- Step 4: sign -------------------------------------------------------- */

function StepSign({
  challenge,
  rating,
  agentId,
}: {
  challenge: ReviewPrepareResponse;
  rating: number;
  agentId: bigint;
}) {
  return (
    <>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)' }}>Sign your review</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
          Your wallet will show an EIP-712 message. Signing costs nothing and sends no transaction.
          It authorises the Record Server to attest to these values and nothing else.
        </p>
      </div>

      <Card>
        <DescriptionList>
          <DescriptionRow term="Agent">
            <span className="mono">#{agentId.toString(10)}</span>
          </DescriptionRow>
          <DescriptionRow term="Rating">{rating} / 100</DescriptionRow>
          <DescriptionRow term="Content hash">
            <Copyable
              value={challenge.feedback_hash}
              display={shortHash(challenge.feedback_hash)}
            />
          </DescriptionRow>
          <DescriptionRow term="Signing window">
            closes {new Date(challenge.deadline * 1000).toLocaleTimeString()}
          </DescriptionRow>
        </DescriptionList>
      </Card>

      <div className={styles.codeBlock}>
        {`${challenge.typed_data.primaryType} (EIP-712)
  domain.name              ${String(challenge.typed_data.domain['name'])}
  domain.chainId           ${String(challenge.typed_data.domain['chainId'])}
  domain.verifyingContract ${String(challenge.typed_data.domain['verifyingContract'])}`}
      </div>

      <Notice tone="info">
        Every field above comes from the challenge the server stored. Nothing in this form is sent
        back: the server rebuilds the message from its own database and verifies your signature
        against that, so there is no field a client could restate differently.
      </Notice>
    </>
  );
}

/* --- Step 5: submit ------------------------------------------------------ */

/**
 * The recomputed score, fetched only after the receipt confirmed.
 *
 * This is the point of the whole journey: the review is on-chain, so the
 * reputation endpoint should now see it. Fetching here rather than waiting
 * for the agent page makes the consequence of the submission visible
 * immediately, and shows honestly when the agent is still short of the
 * five-human threshold.
 */
function PostSubmitReputation({ agentId }: { agentId: bigint }) {
  const reputation = useAsync(() => fetchReputation(agentId.toString(10)), [agentId]);

  if (reputation.loading) {
    return (
      <Card>
        <CardHeader title="Recomputing reputation" />
        <div style={{ padding: 'var(--space-5)' }}>
          <Skeleton height={20} width="50%" />
        </div>
      </Card>
    );
  }

  if (reputation.error !== null || reputation.data == null) {
    return (
      <Notice tone="warning">
        Your review is on-chain, but the reputation service did not answer just now. Open the agent
        page to retry; nothing about the submission is affected.
      </Notice>
    );
  }

  const data = reputation.data;
  return (
    <Card>
      <CardHeader
        title="Reputation after your review"
        action={
          <Button variant="ghost" size="sm" onClick={reputation.reload}>
            Refresh
          </Button>
        }
      />
      <DescriptionList>
        <DescriptionRow term="Receipts Reputation">
          {data.status === 'published' ? (
            <strong>{data.score}</strong>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>
              not published ({data.distinct_humans}/{data.threshold} verified humans)
            </span>
          )}
        </DescriptionRow>
        <DescriptionRow term="Verified humans">{data.distinct_humans}</DescriptionRow>
        <DescriptionRow term="Snapshot block">
          <span className="mono">{data.snapshot_block}</span>
        </DescriptionRow>
        <DescriptionRow term="Evidence">
          <Copyable value={data.evidence_hash} display={shortHash(data.evidence_hash)} />
        </DescriptionRow>
      </DescriptionList>
    </Card>
  );
}

