import { useState } from 'react';
import type { ReputationResponse } from '../lib/api';
import { Badge, Button, Copyable, Modal, Notice } from './ui';
import styles from '../pages/pages.module.css';

/**
 * The evidence behind a published score, in full.
 *
 * A reputation number that cannot be audited is an assertion, not evidence.
 * This shows the whole manifest: the snapshot block, the contracts read,
 * every eligible review with its weight, every exclusion with a reason, and
 * every record the retrieval layer could not attribute.
 *
 * The JSON shown is pretty-printed for reading. The hash is taken over the
 * canonical form (sorted keys, no whitespace), which is stated below the
 * document so nobody tries to reproduce the digest from what is on screen.
 */
export function EvidenceViewer({ reputation }: { reputation: ReputationResponse }) {
  const [open, setOpen] = useState(false);
  const pretty = JSON.stringify(reputation.evidence, null, 2);

  const download = () => {
    const blob = new Blob([pretty], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `receipts-evidence-agent-${reputation.agent_id}-block-${reputation.snapshot_block}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        View evidence
      </Button>

      <Modal open={open} title="Evidence manifest" onClose={() => setOpen(false)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Badge>Block {reputation.snapshot_block}</Badge>
            <Badge>{reputation.evidence.eligible.length} eligible</Badge>
            <Badge>{reputation.evidence.excluded.length} excluded</Badge>
            {reputation.evidence.unattributable.length > 0 && (
              <Badge tone="warning" dot>
                {reputation.evidence.unattributable.length} unattributable
              </Badge>
            )}
          </div>

          {reputation.evidence.unattributable.length > 0 && (
            <Notice tone="warning">
              Some on-chain records could not be attributed to a review. The score was computed
              without them, and they are listed in the manifest below.
            </Notice>
          )}

          <div>
            <div
              style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 6 }}
            >
              keccak256 of the canonical form
            </div>
            <Copyable value={reputation.evidence_hash} />
          </div>

          <div className={styles.codeBlock} style={{ maxHeight: 320, overflowY: 'auto' }}>
            {pretty}
          </div>

          <Notice tone="info">
            Shown pretty-printed. The hash above is over the canonical serialisation — keys sorted,
            no whitespace — so it will not match a digest of this text.
          </Notice>

          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <Button variant="primary" size="sm" onClick={download}>
              Download JSON
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
