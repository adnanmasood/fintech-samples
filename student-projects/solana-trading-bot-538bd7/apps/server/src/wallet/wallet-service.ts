import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { getEnv, hasWallet } from '../config/env.js';
import { SafetyError } from '../core/errors.js';
import type { SecretStore } from './key-store.js';

/** Where the loaded key came from. */
export type WalletSource = 'settings' | 'env';

export interface WalletReport {
  configured: boolean;
  /** Safe to expose: a public address is public. */
  address: string | null;
  source: WalletSource | null;
  error: string | null;
}

export const WALLET_SECRET_NAME = 'wallet_private_key';

/**
 * Wallet access.
 *
 * The only place a private key is ever decoded. The keypair is held in memory,
 * never logged, and never returned by any API. Callers can ask for the public
 * address freely and for the signer only through `withSigner`, which keeps the
 * object from leaking into a wider scope.
 *
 * A key saved from the dashboard takes precedence over `WALLET_PRIVATE_KEY` in
 * the environment, so pasting one in Settings arms live trading immediately —
 * no file edit, no restart. The environment remains a working fallback for
 * deployments that inject secrets that way.
 */
export class WalletService {
  private keypair: Keypair | null = null;
  private loadError: string | null = null;
  private source: WalletSource | null = null;

  constructor(private readonly secrets: SecretStore | null = null) {
    this.reload();
  }

  /** Re-read the key from storage, then the environment. */
  reload(): void {
    this.keypair = null;
    this.loadError = null;
    this.source = null;

    const stored = this.secrets?.get(WALLET_SECRET_NAME) ?? null;
    if (stored) {
      const result = decodeKeypair(stored);
      if (result.keypair) {
        this.keypair = result.keypair;
        this.source = 'settings';
        return;
      }
      this.loadError = `The saved wallet key could not be used: ${result.error}`;
      return;
    }

    const env = getEnv();
    if (!hasWallet(env)) return;
    const result = decodeKeypair(env.WALLET_PRIVATE_KEY!);
    if (result.keypair) {
      this.keypair = result.keypair;
      this.source = 'env';
      return;
    }
    this.loadError = `WALLET_PRIVATE_KEY could not be used: ${result.error}`;
  }

  /**
   * Validate a pasted key, persist it encrypted, and swap it in.
   * Returns the public address so the caller can confirm which wallet it is.
   * Throws a SafetyError with a reason that never echoes any part of the key.
   */
  save(rawKey: string): string {
    if (!this.secrets) {
      throw new SafetyError('No secret store is available, so a key cannot be saved.');
    }
    const trimmed = rawKey.trim();
    if (!trimmed) throw new SafetyError('Paste a private key first.');

    const result = decodeKeypair(trimmed);
    if (!result.keypair) throw new SafetyError(result.error);

    this.secrets.set(WALLET_SECRET_NAME, trimmed);
    this.keypair = result.keypair;
    this.loadError = null;
    this.source = 'settings';
    return result.keypair.publicKey.toBase58();
  }

  /** Forget the saved key. Falls back to the environment if one is set there. */
  clear(): void {
    this.secrets?.delete(WALLET_SECRET_NAME);
    this.reload();
  }

  isAvailable(): boolean {
    return this.keypair !== null;
  }

  /** Safe to expose: a public address is public. */
  publicKey(): string | null {
    return this.keypair?.publicKey.toBase58() ?? null;
  }

  /** Why the wallet failed to load. Never contains any part of the key. */
  error(): string | null {
    return this.loadError;
  }

  /** Everything the dashboard is allowed to know about the wallet. */
  describe(): WalletReport {
    return {
      configured: this.isAvailable(),
      address: this.publicKey(),
      source: this.source,
      error: this.loadError,
    };
  }

  /**
   * Run a callback with the signer. The keypair is not returned, so it cannot
   * be stored, serialised or passed on by the caller.
   */
  withSigner<T>(fn: (keypair: Keypair) => T): T {
    if (!this.keypair) {
      throw new SafetyError(
        this.loadError ?? 'No wallet is configured, so nothing can be signed.',
      );
    }
    return fn(this.keypair);
  }
}

/**
 * Decode the two formats a Solana wallet is exported in: base58, which is what
 * Phantom and Solflare copy to the clipboard, and a JSON byte array, which is
 * what `solana-keygen` writes to a file. Errors describe the shape of the
 * problem and never echo the value.
 */
function decodeKeypair(raw: string): { keypair: Keypair | null; error: string } {
  const bytes = raw.startsWith('[') ? decodeJsonArray(raw) : decodeBase58(raw);
  if (typeof bytes === 'string') return { keypair: null, error: bytes };

  // 32 bytes is the length of a public address, and pasting one of those in is
  // a far more likely mistake than exporting a bare seed. Deriving a keypair
  // from it would succeed and hand back a real-looking wallet that is not the
  // one the address belongs to, so it is refused by name rather than accepted.
  if (bytes.length === 32) {
    return {
      keypair: null,
      error:
        'That is a wallet address, not a private key. The address is the public half — ' +
        'export the private key from your wallet instead.',
    };
  }
  if (bytes.length !== 64) {
    return {
      keypair: null,
      error: `That is ${bytes.length} bytes. A Solana private key is 64 bytes.`,
    };
  }

  try {
    return { keypair: Keypair.fromSecretKey(bytes), error: '' };
  } catch {
    return { keypair: null, error: 'Those 64 bytes are not a valid Solana keypair.' };
  }
}

function decodeBase58(raw: string): Uint8Array | string {
  try {
    return bs58.decode(raw);
  } catch {
    return 'That is not valid base58. Copy the private key straight out of your wallet, with no spaces or quotes.';
  }
}

function decodeJsonArray(raw: string): Uint8Array | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'That looks like a JSON array but it will not parse.';
  }
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number' || n < 0 || n > 255)) {
    return 'A keyfile array must hold whole numbers between 0 and 255.';
  }
  return Uint8Array.from(parsed as number[]);
}
