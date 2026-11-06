import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { getAddress } from 'viem';
import type { Address } from 'viem';
import { config } from '../lib/config';
import {
  WalletError,
  connect as connectWallet,
  getChainId,
  getConnectedAccounts,
  getProvider,
  hasWallet,
  switchChain as switchWalletChain,
} from '../lib/wallet';

/**
 * Wallet connection state, shared across the app.
 *
 * Reconnects silently on load via `eth_accounts`, which reports accounts the
 * user has already authorised without prompting — so a refresh does not throw
 * a wallet dialog at someone who never asked for one.
 */

export interface WalletState {
  readonly address: Address | null;
  readonly chainId: number | null;
  readonly available: boolean;
  /** True while a connection prompt is open. */
  readonly connecting: boolean;
  /** Null unless the last action failed. */
  readonly error: string | null;
  readonly isCorrectChain: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
}

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = hasWallet();

  useEffect(() => {
    if (!available) return;
    let cancelled = false;

    void (async () => {
      const [accounts, currentChain] = await Promise.all([getConnectedAccounts(), getChainId()]);
      if (cancelled) return;
      setAddress(accounts[0] ?? null);
      setChainId(currentChain);
    })();

    // The wallet is the source of truth for both: the user can change account
    // or network from inside it at any moment, including mid-flow.
    const provider = getProvider();
    const onAccountsChanged = (...args: unknown[]) => {
      const accounts = (args[0] ?? []) as string[];
      const first = accounts[0];
      setAddress(first === undefined ? null : getAddress(first));
    };
    const onChainChanged = (...args: unknown[]) => {
      setChainId(Number.parseInt(args[0] as string, 16));
    };

    provider.on('accountsChanged', onAccountsChanged);
    provider.on('chainChanged', onChainChanged);

    return () => {
      cancelled = true;
      provider.removeListener('accountsChanged', onAccountsChanged);
      provider.removeListener('chainChanged', onChainChanged);
    };
  }, [available]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const account = await connectWallet();
      setAddress(account);
      setChainId(await getChainId());
    } catch (err) {
      setError(err instanceof WalletError ? err.message : 'Could not connect to the wallet.');
    } finally {
      setConnecting(false);
    }
  }, []);

  /**
   * Forget the account locally.
   *
   * EIP-1193 has no revoke, so this clears app state only; the wallet still
   * considers the origin authorised and `connect` will not re-prompt. That is
   * the standard behaviour, and pretending otherwise would be misleading.
   */
  const disconnect = useCallback(() => {
    setAddress(null);
    setError(null);
  }, []);

  const switchChain = useCallback(async () => {
    setError(null);
    try {
      await switchWalletChain();
      setChainId(await getChainId());
    } catch (err) {
      setError(err instanceof WalletError ? err.message : 'Could not switch network.');
    }
  }, []);

  const value = useMemo<WalletState>(
    () => ({
      address,
      chainId,
      available,
      connecting,
      error,
      isCorrectChain: chainId === config.chainId,
      connect,
      disconnect,
      switchChain,
    }),
    [address, chainId, available, connecting, error, connect, disconnect, switchChain],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (context === null) throw new Error('useWallet must be used inside a WalletProvider');
  return context;
}
