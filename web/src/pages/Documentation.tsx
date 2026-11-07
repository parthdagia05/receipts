import {
  Card,
  CardHeader,
  Copyable,
  DescriptionList,
  DescriptionRow,
  Notice,
} from '../components/ui';
import { ExternalLink } from '../components/ui';
import { addressUrl, config } from '../lib/config';
import { shortAddress } from '../lib/format';
import styles from './pages.module.css';

/**
 * What Receipts is and how to integrate with it.
 *
 * Deliberately factual: addresses come from configuration and are rendered as
 * explorer links so a reader can check every claim on-chain rather than trust
 * this page.
 */
export function Documentation() {
  return (
    <>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>
            Documentation <span className={styles.pageTitleMuted}>· Protocol</span>
          </h1>
          <p className={styles.pageSubtitle}>
            How a review is produced, what it guarantees, and where everything is deployed.
          </p>
        </div>
      </div>

      <div className={styles.split}>
        <div className={styles.prose}>
          <Card padded tourId="docs-guarantees">
            <h3>What a Receipts review proves</h3>
            <p>
              An ordinary on-chain review proves only that someone paid gas. A Receipts review adds
              two guarantees, both enforced by the contract rather than by this interface:
            </p>
            <ul>
              <li>
                <strong>One human, one review, per agent.</strong> World ID 4.0 derives a nullifier
                from (identity, relying party, action), and the action is scoped to the agent. The
                gateway spends that nullifier in a shared <code>NullifierRegistry</code>, so the
                same person cannot review the same agent twice, even across a gateway upgrade.
              </li>
              <li>
                <strong>The text cannot be swapped.</strong> The reviewer&rsquo;s wallet signs the
                keccak256 hash of the review, and the Record Server signs an attestation that
                carries both that hash and the URI it resolves to. Changing either invalidates the
                signature the gateway recovers.
              </li>
            </ul>
          </Card>

          <Card padded>
            <h3>The free-review flow</h3>
            <p>Five steps, each gated by the one before it:</p>
            <ol>
              <li>
                <code>POST /api/world-id/request</code> mints an RP-signed request. The action is
                derived from the agent ID server-side, so a client cannot choose its own nullifier
                scope.
              </li>
              <li>
                World App produces a proof. <code>POST /api/reviews/verify</code> forwards it to the
                Developer Portal unchanged and stores the nullifier the Portal returns, never the
                one the client claimed.
              </li>
              <li>
                <code>POST /api/reviews/prepare</code> hashes the review text and returns EIP-712
                typed data for the wallet to sign. The hash is computed by the server, not supplied.
              </li>
              <li>
                <code>POST /api/reviews/attest</code> verifies the wallet signature against typed
                data rebuilt from storage, spends the challenge, then signs the gateway attestation.
              </li>
              <li>
                <code>ReviewGateway.submitFreeReview</code> verifies the attestation, rejects owner
                and operator self-reviews, consumes the nullifier and writes one ERC-8004 feedback
                entry.
              </li>
            </ol>
            <p>
              The Record Server never sends a transaction. It signs; the reviewer submits. That is
              why the attest response always reports <code>submitted: false</code>.
            </p>
          </Card>

          <Card padded>
            <h3>Reading reviews without this app</h3>
            <p>
              Reviews are written to the shared ERC-8004 Reputation Registry, so any client can read
              them. Note that the registry attributes feedback to its immediate caller, the gateway,
              not to the human reviewer. To recover who wrote what, read the gateway&rsquo;s own{' '}
              <code>ReviewSubmitted</code> event, which carries the agent, reviewer, nullifier,
              review type, receipt ID and evidence hash on a single log.
            </p>
            <p>
              Review text is served by the Record Server at{' '}
              <code>/reviews/&lt;feedbackHash&gt;</code>. It is content-addressed: hash what you
              receive and compare it against the hash on-chain.
            </p>
          </Card>

          <Card padded tourId="docs-paid-reviews">
            <h3>Paid reviews</h3>
            <p>
              The protocol supports a second review type bound to a settled USDC payment:{' '}
              <code>ReceiptSettler</code> records a receipt from an EIP-3009 authorization, and{' '}
              <code>submitPaidReview</code> consumes it, enforcing a minimum payment and a 30-day
              review window. The contracts are deployed and tested.
            </p>
            <Notice tone="warning">
              This interface implements the free path only. Settling a receipt needs an EIP-3009
              client that does not exist yet, so a paid review cannot be completed here.
            </Notice>
          </Card>
        </div>

        <div className={styles.splitAside}>
          <Card>
            <CardHeader
              title="Deployment"
              description={`${config.chainName} · chain ${config.chainId}`}
            />
            <DescriptionList>
              <DescriptionRow term="ReviewGateway">
                <ExternalLink href={addressUrl(config.reviewGateway)}>
                  {shortAddress(config.reviewGateway)}
                </ExternalLink>
              </DescriptionRow>
              <DescriptionRow term="ReceiptSettler">
                <ExternalLink href={addressUrl(config.receiptSettler)}>
                  {shortAddress(config.receiptSettler)}
                </ExternalLink>
              </DescriptionRow>
              <DescriptionRow term="NullifierRegistry">
                <ExternalLink href={addressUrl(config.nullifierRegistry)}>
                  {shortAddress(config.nullifierRegistry)}
                </ExternalLink>
              </DescriptionRow>
              <DescriptionRow term="ERC-8004 Identity">
                <ExternalLink href={addressUrl(config.identityRegistry)}>
                  {shortAddress(config.identityRegistry)}
                </ExternalLink>
              </DescriptionRow>
              <DescriptionRow term="ERC-8004 Reputation">
                <ExternalLink href={addressUrl(config.reputationRegistry)}>
                  {shortAddress(config.reputationRegistry)}
                </ExternalLink>
              </DescriptionRow>
            </DescriptionList>
          </Card>

          <Card>
            <CardHeader title="Review tags" bare />
            <DescriptionList>
              <DescriptionRow term="tag1">
                <Copyable value="quality" />
              </DescriptionRow>
              <DescriptionRow term="tag2 (free)">
                <Copyable value="human-verified" />
              </DescriptionRow>
              <DescriptionRow term="tag2 (paid)">
                <Copyable value="receipt-verified" />
              </DescriptionRow>
              <DescriptionRow term="valueDecimals">0</DescriptionRow>
              <DescriptionRow term="Rating range">0 – 100</DescriptionRow>
            </DescriptionList>
          </Card>
        </div>
      </div>
    </>
  );
}
