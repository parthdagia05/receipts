import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addressUrl, config } from '../../lib/config';
import { shortAddress } from '../../lib/format';
import { useWallet } from '../../wallet/WalletProvider';
import { Button } from '../ui';
import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  PanelIcon,
  SearchIcon,
  WalletIcon,
} from '../ui/Icons';
import styles from './layout.module.css';

/**
 * Search jumps straight to an agent by id.
 *
 * The registry has no name index and no search API, so free-text search would
 * be a box that cannot answer. Accepting an agent id — with or without a
 * leading `#` — is a real capability, and the placeholder says exactly that.
 */
function AgentSearch() {
  const [value, setValue] = useState('');
  const navigate = useNavigate();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const id = value.trim().replace(/^#/, '');
    if (!/^\d+$/.test(id) || id === '0') return;
    navigate(`/agents/${id}`);
    setValue('');
  };

  return (
    <form className={styles.search} onSubmit={submit} role="search">
      <SearchIcon size={15} className={styles.searchIcon} />
      <input
        className={styles.searchInput}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Go to agent by ID…"
        inputMode="numeric"
        aria-label="Go to agent by ID"
      />
    </form>
  );
}

function WalletMenu() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (wrapRef.current !== null && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (wallet.address === null) {
    return (
      <Button
        variant="primary"
        size="sm"
        icon={<WalletIcon size={14} />}
        loading={wallet.connecting}
        onClick={() => void wallet.connect()}
        disabled={!wallet.available}
        title={wallet.available ? undefined : 'No browser wallet detected'}
      >
        {wallet.available ? 'Connect Wallet' : 'No Wallet'}
      </Button>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.address ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* Clipboard unavailable on insecure origins. */
    }
  };

  return (
    <div className={styles.walletMenuWrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.walletTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <WalletIcon size={14} />
        <span className="mono">{shortAddress(wallet.address, 5, 4)}</span>
      </button>

      {open && (
        <div className={styles.walletMenu} role="menu">
          <div className={styles.walletMenuHead}>
            <div className={styles.walletMenuLabel}>Connected wallet</div>
            <div className="mono" style={{ fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>
              {wallet.address}
            </div>
          </div>

          <button type="button" className={styles.walletMenuItem} onClick={() => void copy()}>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? 'Copied' : 'Copy address'}
          </button>

          <a
            className={styles.walletMenuItem}
            href={addressUrl(wallet.address)}
            target="_blank"
            rel="noreferrer noopener"
          >
            <ExternalIcon size={14} />
            View on explorer
          </a>

          {!wallet.isCorrectChain && (
            <button
              type="button"
              className={styles.walletMenuItem}
              onClick={() => void wallet.switchChain()}
            >
              <AlertIcon size={14} />
              Switch to {config.chainName}
            </button>
          )}

          <button
            type="button"
            className={styles.walletMenuItem}
            onClick={() => {
              wallet.disconnect();
              setOpen(false);
            }}
          >
            <WalletIcon size={14} />
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Shown under the top bar while no wallet is attached.
 *
 * Reviewing, and the My Agents page, both need an address. Saying so once here
 * is clearer than letting the reader find out from a disabled button.
 */
export function ConnectPrompt() {
  const wallet = useWallet();
  if (wallet.address !== null) return null;

  return (
    <div className={styles.connectStrip}>
      <WalletIcon size={13} />
      Connect a wallet to submit reviews and see the agents you own.
    </div>
  );
}

export function Topbar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const wallet = useWallet();
  const wrongChain = wallet.address !== null && !wallet.isCorrectChain;

  return (
    <header className={styles.topbar}>
      <button
        type="button"
        className={styles.menuButton}
        onClick={onOpenMenu}
        aria-label="Open navigation"
      >
        <PanelIcon size={18} />
      </button>

      <AgentSearch />

      <div className={styles.topbarRight}>
        <div
          className={styles.network}
          title={
            wrongChain
              ? `Your wallet is on another network. Receipts is deployed on ${config.chainName}.`
              : `Reading from ${config.chainName}`
          }
        >
          <span
            className={[styles.networkDot, wrongChain ? styles.networkDotWarn : ''].join(' ')}
          />
          <span>{wrongChain ? 'Wrong network' : config.chainName}</span>
        </div>
        <WalletMenu />
      </div>
    </header>
  );
}
