import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import { roundUsd } from '../core/money.js';
import type { BlockchainProvider, DexProvider } from '../providers/interfaces.js';
import type { WalletService } from './wallet-service.js';

export interface WalletBalance {
  address: string | null;
  /** Native balance in whole SOL, or null when it could not be read. */
  solBalance: number | null;
  solPriceUsd: number | null;
  balanceUsd: number | null;
  fetchedAt: number | null;
  error: string | null;
}

const EMPTY: WalletBalance = {
  address: null,
  solBalance: null,
  solPriceUsd: null,
  balanceUsd: null,
  fetchedAt: null,
  error: null,
};

/** How long a reading is reused. The dashboard polls every 8 seconds. */
const CACHE_MS = 15_000;

/**
 * The real, on-chain balance of the trading wallet.
 *
 * Kept apart from PortfolioManager on purpose: that tracks the bot's own
 * ledger of what it has bought and sold, while this is simply what the chain
 * says the wallet holds right now. Cached, because the dashboard polls far
 * faster than a balance meaningfully changes and every read is an RPC call.
 */
export class WalletBalanceService {
  private cached: WalletBalance = EMPTY;
  private inFlight: Promise<WalletBalance> | null = null;

  constructor(
    private readonly wallet: WalletService,
    private readonly blockchain: BlockchainProvider,
    private readonly dex: DexProvider,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  /** Last reading without touching the network. */
  peek(): WalletBalance {
    return this.cached;
  }

  async read(force = false): Promise<WalletBalance> {
    const address = this.wallet.publicKey();
    if (!address) {
      this.cached = EMPTY;
      return this.cached;
    }

    const fresh =
      this.cached.address === address &&
      this.cached.fetchedAt != null &&
      this.clock.now() - this.cached.fetchedAt < CACHE_MS;
    if (fresh && !force) return this.cached;

    // A burst of dashboard polls must not become a burst of RPC calls.
    this.inFlight ??= this.fetch(address).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async fetch(address: string): Promise<WalletBalance> {
    try {
      const sol = await this.blockchain.getNativeBalance(address);
      // A missing price is not a failed read: the SOL figure still stands.
      const price = await this.dex
        .getPriceUsd(this.config.get().execution.quoteMint)
        .catch(() => null);
      this.cached = {
        address,
        solBalance: sol,
        solPriceUsd: price,
        balanceUsd: price != null ? roundUsd(sol * price) : null,
        fetchedAt: this.clock.now(),
        error: null,
      };
    } catch (err) {
      this.cached = {
        ...EMPTY,
        address,
        fetchedAt: this.clock.now(),
        error: err instanceof Error ? err.message : 'Could not read the wallet balance.',
      };
    }
    return this.cached;
  }
}
