import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { tokenLists } from '../db/schema.js';

export type ListName = 'blacklist' | 'whitelist';

export interface ListEntry {
  tokenAddress: string;
  symbol: string;
  reason: string;
  source: string;
  createdAt: number;
}

/**
 * Blacklist and whitelist.
 *
 * Kept in the database rather than only in config so the security agent can
 * add to the blacklist itself when it catches something, and that finding
 * survives a restart. The config's own lists are seeded in at boot, so a user
 * can also declare entries declaratively.
 *
 * Reads go through an in-memory set: the blacklist is consulted on every
 * single token, and a database round trip per token would dominate a scan.
 */
export class ListService {
  private blacklist = new Set<string>();
  private whitelist = new Set<string>();

  constructor(private readonly db: Db) {
    this.reload();
  }

  reload(): void {
    const rows = this.db.select().from(tokenLists).all();
    this.blacklist = new Set(rows.filter((r) => r.list === 'blacklist').map((r) => r.tokenAddress));
    this.whitelist = new Set(rows.filter((r) => r.list === 'whitelist').map((r) => r.tokenAddress));
  }

  /** Add any config-declared entries that are not in the table yet. */
  seedFromConfig(lists: { blacklist: string[]; whitelist: string[] }): void {
    for (const address of lists.blacklist) {
      this.add('blacklist', address, { reason: 'declared in configuration', source: 'config' });
    }
    for (const address of lists.whitelist) {
      this.add('whitelist', address, { reason: 'declared in configuration', source: 'config' });
    }
  }

  isBlacklisted(address: string): boolean {
    return this.blacklist.has(address);
  }

  isWhitelisted(address: string): boolean {
    return this.whitelist.has(address);
  }

  add(
    list: ListName,
    tokenAddress: string,
    options: { symbol?: string; reason?: string; source?: string } = {},
  ): void {
    // A token cannot be on both lists. The newer intent wins, which lets the
    // security agent blacklist something a user had whitelisted earlier and
    // lets a user override the agent by whitelisting it again.
    const other: ListName = list === 'blacklist' ? 'whitelist' : 'blacklist';
    this.db.transaction((tx) => {
      tx.delete(tokenLists)
        .where(and(eq(tokenLists.list, other), eq(tokenLists.tokenAddress, tokenAddress)))
        .run();
      tx.insert(tokenLists)
        .values({
          list,
          tokenAddress,
          symbol: options.symbol ?? '',
          reason: options.reason ?? '',
          source: options.source ?? 'manual',
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
    });
    this.setFor(other).delete(tokenAddress);
    this.setFor(list).add(tokenAddress);
  }

  remove(list: ListName, tokenAddress: string): void {
    this.db
      .delete(tokenLists)
      .where(and(eq(tokenLists.list, list), eq(tokenLists.tokenAddress, tokenAddress)))
      .run();
    this.setFor(list).delete(tokenAddress);
  }

  entries(list: ListName): ListEntry[] {
    return this.db
      .select()
      .from(tokenLists)
      .where(eq(tokenLists.list, list))
      .all()
      .map((r) => ({
        tokenAddress: r.tokenAddress,
        symbol: r.symbol,
        reason: r.reason,
        source: r.source,
        createdAt: r.createdAt,
      }));
  }

  private setFor(list: ListName): Set<string> {
    return list === 'blacklist' ? this.blacklist : this.whitelist;
  }
}
