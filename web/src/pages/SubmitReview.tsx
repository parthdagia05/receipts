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

      <Card className={styles.narrow} tourId="review-wizard">
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

function StepSubmit({
  attestation,
  txHash,
  confirmed,
  agentId,
}: {
  attestation: SerializedAttestation | null;
  txHash: Hex | null;
  confirmed: boolean;
  agentId: bigint;
}) {
  if (confirmed && txHash !== null) {
    return (
      <>
        <EmptyState
          icon={<CheckIcon size={20} style={{ color: 'var(--status-ok)' }} />}
          title="Review published on-chain"
          body="Written to the ERC-8004 Reputation Registry. Any client can read it, not just Receipts."
        />
        <Card nested>
          <DescriptionList>
            <DescriptionRow term="Transaction">
              <ExternalLink href={txUrl(txHash)}>{shortHash(txHash)}</ExternalLink>
            </DescriptionRow>
            <DescriptionRow term="Agent">
              <Link to={`/agents/${agentId.toString(10)}`} style={{ color: 'var(--accent)' }}>
                #{agentId.toString(10)}
              </Link>
            </DescriptionRow>
            {attestation !== null && (
              <DescriptionRow term="Evidence hash">
                <Copyable
                  value={attestation.feedbackHash}
                  display={shortHash(attestation.feedbackHash)}
                />
              </DescriptionRow>
            )}
          </DescriptionList>
        </Card>

        <PostSubmitReputation agentId={agentId} />
      </>
    );
  }

  if (txHash !== null) {
    return (
      <>
        <div>
          <h2 style={{ fontSize: 'var(--text-md)' }}>Waiting for confirmation</h2>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
            The transaction is in the mempool. Nothing is marked published until the receipt
            confirms it succeeded.
          </p>
        </div>
        <Card nested>
          <DescriptionList>
            <DescriptionRow term="Transaction">
              <ExternalLink href={txUrl(txHash)}>{shortHash(txHash)}</ExternalLink>
            </DescriptionRow>
            <DescriptionRow term="Status">
              <Badge tone="warning" dot>
                Pending
              </Badge>
            </DescriptionRow>
          </DescriptionList>
        </Card>
      </>
    );
  }

  return (
    <>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)' }}>Submit to the gateway</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 6 }}>
          The Record Server has signed your attestation. Submitting sends one transaction to the
          ReviewGateway, which verifies the signature, spends your nullifier and writes the feedback
          to ERC-8004.
        </p>
      </div>

      {attestation !== null && (
        <Card nested>
          <DescriptionList>
            <DescriptionRow term="Gateway">
              <ExternalLink href={addressUrl(config.reviewGateway)}>
                {shortAddress(config.reviewGateway)}
              </ExternalLink>
            </DescriptionRow>
            <DescriptionRow term="Rating">{attestation.value} / 100</DescriptionRow>
            <DescriptionRow term="Evidence">
              <Copyable
                value={attestation.feedbackURI}
                display={shortHash(attestation.feedbackHash)}
              />
            </DescriptionRow>
            <DescriptionRow term="Attestation expires">
              {new Date(Number(attestation.expiry) * 1000).toLocaleTimeString()}
            </DescriptionRow>
          </DescriptionList>
        </Card>
      )}

      <Notice tone="info">
        You pay gas for this transaction. The attestation is already signed, so you can submit again
        if you reject it, while it is still valid.
      </Notice>
    </>
  );
}

/* --- Step 4 (wallet): authorised ------------------------------------------ */

/**
 * The end of the wallet path.
 *
 * The attestation is a signed authorisation, not a published review, and this
 * screen says so. The gateway deployed on this network does not yet expose a
 * wallet submission entry point, so nothing is sent on-chain from here.
 */
function StepAuthorised({
  attestation,
  agentId,
}: {
  attestation: SerializedAttestation | null;
  agentId: bigint;
}) {
  return (
    <>
      <EmptyState
        icon={<CheckIcon size={20} style={{ color: 'var(--status-ok)' }} />}
        title="Wallet authorisation signed"
        body="The Record Server attested to your signed review. It is not yet written on-chain."
      />
      <Card nested>
        <DescriptionList>
          <DescriptionRow term="Agent">
            <Link to={`/agents/${agentId.toString(10)}`} style={{ color: 'var(--accent)' }}>
              #{agentId.toString(10)}
            </Link>
          </DescriptionRow>
          <DescriptionRow term="Verification">
            <VerificationBadge verification="wallet_only" />
          </DescriptionRow>
          {attestation !== null && (
            <>
              <DescriptionRow term="Rating">{attestation.value} / 100</DescriptionRow>
              <DescriptionRow term="Evidence hash">
                <Copyable
                  value={attestation.feedbackHash}
                  display={shortHash(attestation.feedbackHash)}
                />
              </DescriptionRow>
              <DescriptionRow term="Attestation expires">
                {new Date(Number(attestation.expiry) * 1000).toLocaleTimeString()}
              </DescriptionRow>
            </>
          )}
        </DescriptionList>
      </Card>
      <Notice tone="warning">{WALLET_TOOLTIP}</Notice>
    </>
  );
}

/* --- Footer: the actions that move between steps ------------------------- */

function WizardFooter(props: {
  method: Method;
  step: StepIndex;
  blocked: string | null;
  wallet: ReturnType<typeof useWallet>;
  content: string;
  proof: VerifiedProof | null;
  challenge: ReviewPrepareResponse | null;
  attestation: SerializedAttestation | null;
  txHash: Hex | null;
  confirmed: boolean;
  agentId: bigint;
  rating: number;
  setStep: (step: StepIndex) => void;
  setError: (message: string | null) => void;
  setChallenge: (challenge: ReviewPrepareResponse) => void;
  setAttestation: (attestation: SerializedAttestation) => void;
  setTxHash: (hash: Hex) => void;
  setConfirmed: (value: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { wallet, step } = props;

  const fail = (err: unknown) => {
    props.setError(
      isUserRejection(err) ? 'You rejected the request in your wallet.' : describeApiError(err),
    );
  };

  /** Step 3 → 4: hash the content server-side and get typed data back. */
  const doPrepare = async () => {
    if (wallet.address === null) return;
    if (props.method === 'world_id' && props.proof === null) return;
    setBusy(true);
    props.setError(null);
    try {
      if (props.method === 'wallet') {
        // No reviewType, receiptId, nullifier or requestNonce: the server
        // fixes the type and derives the nullifier from the address.
        const walletChallenge = await prepareWalletReview({
          agentId: props.agentId.toString(10),
          reviewer: wallet.address,
          value: props.rating,
          valueDecimals: 0,
          content: props.content,
        });
        if (
          (walletChallenge.verification !== undefined &&
            walletChallenge.verification !== 'wallet_only') ||
          (walletChallenge.review_type !== undefined &&
            walletChallenge.review_type !== REVIEW_TYPE.WALLET)
        ) {
          throw new Error('The server returned a challenge that is not a wallet-verified review.');
        }
        props.setChallenge(walletChallenge);
        props.setStep(3);
        return;
      }
      if (props.proof === null) return;
      const challenge = await prepareReview({
        agentId: props.agentId.toString(10),
        reviewer: wallet.address,
        value: props.rating,
        valueDecimals: 0,
        reviewType: REVIEW_TYPE.FREE,
        content: props.content,
        requestNonce: props.proof.requestNonce,
      });
      props.setChallenge(challenge);
      props.setStep(3);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Step 4 → 5: wallet signature, then exchange it for an attestation. */
  const doSign = async () => {
    if (wallet.address === null || props.challenge === null) return;
    setBusy(true);
    props.setError(null);
    try {
      const typed = prepareTypedData(props.challenge.typed_data);
      const client = createClient(wallet.address);

      // The schema is only known at runtime — it comes from the server — so
      // viem's compile-time typed-data generics cannot describe it. The cast is
      // confined to this one call; `prepareTypedData` is what actually
      // guarantees the shape, field by field, against the declared types.
      const signature = await client.signTypedData({
        account: wallet.address,
        domain: typed.domain,
        types: typed.types,
        primaryType: typed.primaryType,
        message: typed.message,
      } as unknown as Parameters<typeof client.signTypedData>[0]);

      const attested = await attestReview({
        challengeId: props.challenge.challenge_id,
        signature,
      });
      // Fail closed on the function the server names: an unknown value, or one
      // that does not belong to this flow, is an error rather than a guess.
      const expected = props.method === 'wallet' ? 'submitWalletReview' : 'submitFreeReview';
      const named = parseSubmitFunction(attested.submit_function);
      if (named !== expected) {
        throw new Error(
          `The server asked for ${named}, but this flow submits with ${expected}. Nothing was sent.`,
        );
      }
      props.setAttestation(attested.attestation);
      props.setStep(4);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  /** Step 5: one transaction, then wait for the receipt before claiming success. */
  const doSubmit = async () => {
    if (wallet.address === null || props.attestation === null) return;
    setBusy(true);
    props.setError(null);
    try {
      const client = createClient(wallet.address);
      const hash = await client.writeContract({
        account: wallet.address,
        chain: null,
        address: config.reviewGateway,
        abi: reviewGatewayAbi,
        functionName: 'submitFreeReview',
        args: [toAttestationArgs(props.attestation)],
      });
      props.setTxHash(hash);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        props.setConfirmed(true);
      } else {
        // A reverted transaction is still mined. Reporting it as published
        // because a hash exists would be exactly the wrong answer.
        props.setError('The transaction was mined but reverted. The review was not written.');
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  if (props.confirmed || (props.method === 'wallet' && step === 4)) {
    return (
      <div className={styles.wizardFoot}>
        <Link to="/reviews">
          <Button variant="ghost">All reviews</Button>
        </Link>
        <Link to={`/agents/${props.agentId.toString(10)}`}>
          <Button variant="primary">View the agent</Button>
        </Link>
      </div>
    );
  }

  const contentBytes = new TextEncoder().encode(props.content).length;

  return (
    <div className={styles.wizardFoot}>
      <Button
        variant="ghost"
        disabled={step === 0 || step === 4 || busy}
        onClick={() =>
          props.setStep(
            (props.method === 'wallet' && step === 2 ? 0 : Math.max(0, step - 1)) as StepIndex,
          )
        }
      >
        Back
      </Button>

      {step === 0 &&
        (props.blocked === 'wallet' ? (
          <Button
            variant="primary"
            icon={<WalletIcon size={14} />}
            loading={wallet.connecting}
            disabled={!wallet.available}
            onClick={() => void wallet.connect()}
          >
            {wallet.available ? 'Connect Wallet' : 'No wallet detected'}
          </Button>
        ) : props.blocked === 'chain' ? (
          <Button
            variant="primary"
            icon={<AlertIcon size={14} />}
            onClick={() => void wallet.switchChain()}
          >
            Switch to {config.chainName}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={<ShieldIcon size={14} />}
            disabled={props.blocked !== null}
            onClick={() => props.setStep(props.method === 'wallet' ? 2 : 1)}
          >
            {props.method === 'wallet' ? 'Continue with wallet' : 'Verify with World ID'}
          </Button>
        ))}

      {step === 1 && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }} />}

      {step === 2 && (
        <Button
          variant="primary"
          loading={busy}
          disabled={props.content.trim().length === 0 || contentBytes > MAX_CONTENT_BYTES}
          onClick={() => void doPrepare()}
        >
          Continue to signing
        </Button>
      )}

      {step === 3 && (
        <Button variant="primary" loading={busy} onClick={() => void doSign()}>
          Sign review
        </Button>
      )}

      {step === 4 && (
        <Button
          variant="primary"
          loading={busy}
          disabled={props.attestation === null || props.txHash !== null}
          onClick={() => void doSubmit()}
        >
          {props.txHash === null ? 'Submit on-chain' : 'Waiting for confirmation…'}
        </Button>
      )}
    </div>
  );
}
