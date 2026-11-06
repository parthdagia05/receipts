import { createWalletClient, custom, getAddress, numberToHex } from 'viem';
import type { Address, EIP1193Provider, WalletClient } from 'viem';
import { chain } from './chain';
import { config } from './config';

/**
 * Browser wallet access over EIP-1193.
 *
 * Deliberately thin: this app needs an account, a chain, one typed-data
 * signature and one transaction. A connector library would add a large
 * dependency and an abstraction layer for capabilities we do not use.
 */

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

export class WalletError extends Error {
  readonly code: 'no_wallet' | 'rejected' | 'wrong_chain' | 'failed';

  constructor(code: WalletError['code'], message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** EIP-1193 user rejection. 4001 is the standard code; wallets vary in wording. */
export function isUserRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (record.code === 4001) return true;
  if (typeof record.message === 'string' && /user rejected|user denied/i.test(record.message)) {
    return true;
  }
  return record.cause !== undefined && isUserRejection(record.cause);
}

export function getProvider(): EIP1193Provider {
  const provider = window.ethereum;
  if (provider === undefined) {
    throw new WalletError(
      'no_wallet',
      'No browser wallet detected. Install MetaMask or another EIP-1193 wallet.',
    );
  }
  return provider;
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && window.ethereum !== undefined;
}

export function createClient(account: Address): WalletClient {
  return createWalletClient({ account, chain, transport: custom(getProvider()) });
}

/** Accounts already authorised for this origin. Does not prompt. */
export async function getConnectedAccounts(): Promise<Address[]> {
  if (!hasWallet()) return [];
  try {
    const accounts = (await getProvider().request({ method: 'eth_accounts' })) as string[];
    return accounts.map((address) => getAddress(address));
  } catch {
    return [];
  }
}

/** Prompts the wallet for access. Throws `WalletError('rejected')` if declined. */
export async function connect(): Promise<Address> {
  const provider = getProvider();
  try {
    const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
    const first = accounts[0];
    if (first === undefined) throw new WalletError('failed', 'The wallet returned no accounts.');
    return getAddress(first);
  } catch (error) {
    if (error instanceof WalletError) throw error;
    if (isUserRejection(error)) {
      throw new WalletError('rejected', 'Wallet connection was rejected.');
    }
    throw new WalletError('failed', 'Could not connect to the wallet.');
  }
}

export async function getChainId(): Promise<number | null> {
  if (!hasWallet()) return null;
  try {
    const hex = (await getProvider().request({ method: 'eth_chainId' })) as string;
    return Number.parseInt(hex, 16);
  } catch {
    return null;
  }
}

/**
 * Move the wallet to the configured chain.
 *
 * Only `wallet_switchEthereumChain` is attempted. Adding a chain the user has
 * not got is not something this app should do silently, and Sepolia is present
 * in every mainstream wallet by default.
 */
export async function switchChain(): Promise<void> {
  const provider = getProvider();
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(config.chainId) }],
    });
  } catch (error) {
    if (isUserRejection(error)) {
      throw new WalletError('rejected', `Declined switching to ${config.chainName}.`);
    }
    throw new WalletError('wrong_chain', `Could not switch the wallet to ${config.chainName}.`);
  }
}
