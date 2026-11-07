import { and, gte, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { traderTrades } from '../../db/schema.js';

/**
 * Smart-money activity.
 *
 * Counts how many wallets the system rates highly have bought or sold a token
 * recently. Shared by every agent, because "wallets with a record are buying
 * this" is a signal regardless of which strategy is asking.
 *
 * Backed by an in-memory index that is rebuilt from the database, because it
 * is consulted once per token per scan and a query per token would dominate.
 */
export interface SmartMoneyCounts {
  buys: number;
  sells: number;
}

export class SmartMoneyIndex {
  /** token -> wallet -> latest side and timestamp. */
  private index = new Map<string, Map<string, { side: 'buy' | 'sell'; at: number }>>();
  private lastBuiltAt = 0;

  constructor(
    private readonly db: Db,
    /** Wallets whose trades count. Supplied by the copy-trade agent's scoring. */
    private ratedWallets: Set<string> = new Set(),
  ) {}

  setRatedWallets(wallets: Iterable<string>): void {
    this.ratedWallets = new Set(wallets);
    // The rated set changed, so the cached counts no longer mean anything.
    this.lastBuiltAt = 0;
  }

  /** Rebuild from stored trades. Cheap enough to run once per scheduler tick. */
  rebuild(sinceMs: number): void {
    const rows = this.db
      .select()
      .from(traderTrades)
      .where(gte(traderTrades.timestamp, sinceMs))
      .all();

    const next = new Map<string, Map<string, { side: 'buy' | 'sell'; at: number }>>();
    for (const row of rows) {
      if (this.ratedWallets.size > 0 && !this.ratedWallets.has(row.wallet)) continue;
      const perToken = next.get(row.tokenAddress) ?? new Map();
      const existing = perToken.get(row.wallet);
      // One wallet counts once per token: its most recent action. Otherwise a
      // wallet churning in and out would look like a crowd.
      if (!existing || row.timestamp > existing.at) {
        perToken.set(row.wallet, { side: row.side as 'buy' | 'sell', at: row.timestamp });
      }
      next.set(row.tokenAddress, perToken);
    }
    this.index = next;
    this.lastBuiltAt = Date.now();
  }

  countsFor(tokenAddress: string, sinceMs: number): SmartMoneyCounts {
    const perToken = this.index.get(tokenAddress);
    if (!perToken) return { buys: 0, sells: 0 };
    let buys = 0;
    let sells = 0;
    for (const entry of perToken.values()) {
      if (entry.at < sinceMs) continue;
      if (entry.side === 'buy') buys += 1;
      else sells += 1;
    }
    return { buys, sells };
  }

  /** True when the index has not been rebuilt inside the window. */
  isStale(maxAgeMs: number): boolean {
    return Date.now() - this.lastBuiltAt > maxAgeMs;
  }

  hasTradeFor(wallet: string, tokenAddress: string): boolean {
    return Boolean(
      this.db
        .select()
        .from(traderTrades)
        .where(and(eq(traderTrades.wallet, wallet), eq(traderTrades.tokenAddress, tokenAddress)))
        .limit(1)
        .get(),
    );
  }
}
