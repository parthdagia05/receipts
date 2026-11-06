import { Link } from 'react-router-dom';
import type { AgentSummary } from '../lib/agents';
import { shortAddress } from '../lib/format';
import { Badge, Button, Skeleton, Table } from './ui';
import { AgentsIcon } from './ui/Icons';
import styles from '../pages/pages.module.css';

const ZERO = '0x0000000000000000000000000000000000000000';

const COLUMNS = ['Agent', 'Owner', 'Feedback authors', 'Payment wallet', ''] as const;

/**
 * The agent directory, as a table.
 *
 * A table rather than a grid of cards because every agent carries the same
 * four facts and the useful operation is comparing them down a column. The
 * registry stores no on-chain name, so the id is the identity — there is no
 * title to make a card out of.
 */
export function AgentTable({ agents }: { agents: readonly AgentSummary[] }) {
  return (
    <Table columns={COLUMNS} wide>
      {agents.map((agent) => {
        const id = agent.agentId.toString(10);
        const hasWallet = agent.agentWallet !== null && agent.agentWallet !== ZERO;

        return (
          <tr key={id}>
            <td>
              <Link to={`/agents/${id}`} className={styles.agentCell}>
                <span className={styles.swatch} aria-hidden="true">
                  <AgentsIcon size={14} />
                </span>
                <span>
                  <span className={styles.agentCellId}>#{id}</span>
                  <span className={styles.agentCellSub}>
                    {agent.tokenURI === null || agent.tokenURI === ''
                      ? 'No metadata'
                      : agent.tokenURI.startsWith('ipfs://')
                        ? 'IPFS metadata'
                        : 'URI metadata'}
                  </span>
                </span>
              </Link>
            </td>
            <td className="mono">{agent.owner === null ? '—' : shortAddress(agent.owner)}</td>
            <td className={styles.tableNumeric}>{agent.clientCount ?? '—'}</td>
            <td>
              {hasWallet ? (
                <Badge tone="success">Set</Badge>
              ) : (
                <Badge tone="neutral">Not set</Badge>
              )}
            </td>
            <td>
              <div className={styles.rowAction}>
                <Link to={`/agents/${id}`}>
                  <Button variant="ghost" size="sm">
                    Details
                  </Button>
                </Link>
                <Link to={`/review/${id}`}>
                  <Button variant="secondary" size="sm">
                    Review
                  </Button>
                </Link>
              </div>
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export function AgentTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Table columns={COLUMNS} wide>
      {Array.from({ length: rows }, (_, index) => (
        <tr key={index}>
          <td>
            <div className={styles.agentCell}>
              <span className={styles.swatch} aria-hidden="true" />
              <Skeleton height={13} width="90px" />
            </div>
          </td>
          <td>
            <Skeleton height={13} width="110px" />
          </td>
          <td>
            <Skeleton height={13} width="24px" />
          </td>
          <td>
            <Skeleton height={13} width="48px" />
          </td>
          <td />
        </tr>
      ))}
    </Table>
  );
}
