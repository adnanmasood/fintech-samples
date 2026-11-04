import { desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Chain, TokenMarketSnapshot } from '../core/types.js';
import type { Db } from '../db/client.js';
import { tokens } from '../db/schema.js';
import { checkMarketSnapshot } from './sanity.js';

/**
 * Token storage and history.
 *
 * The history matters more than it looks: nearly every growth measure in the
 * scoring engine compares a token against its own recent baseline rather than
 * against an absolute threshold. Without a stored series there is no baseline,
 * so every snapshot is kept.
 */

export interface StoredSnapshot extends TokenMarketSnapshot {
  storedAt: number;
}

export class TokenRepository {
  /** Recent snapshots per token, newest first. Kept in memory for scoring. */
  private readonly history = new Map<string, TokenMarketSnapshot[]>();
  private readonly maxHistoryPerToken = 24;

  constructor(private readonly db: Db) {}

  upsert(snapshot: TokenMarketSnapshot): void {
    const now = Date.now();
    this.db
      .insert(tokens)
      .values({
        address: snapshot.address,
        chain: snapshot.chain,
        symbol: snapshot.symbol,
        name: snapshot.name,
        firstSeenAt: now,
        lastSeenAt: now,
        marketSnapshot: snapshot as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: tokens.address,
        set: {
          symbol: snapshot.symbol,
          name: snapshot.name,
          lastSeenAt: now,
          marketSnapshot: snapshot as unknown as Record<string, unknown>,
        },
      })
      .run();
    this.pushHistory(snapshot);
  }

  upsertMany(snapshots: TokenMarketSnapshot[]): void {
    if (snapshots.length === 0) return;
    // One transaction for a whole scan: a 60-token sweep should be one fsync,
    // not sixty.
    this.db.transaction(() => {
      for (const snapshot of snapshots) this.upsert(snapshot);
    });
  }

  private pushHistory(snapshot: TokenMarketSnapshot): void {
    const list = this.history.get(snapshot.address) ?? [];
    // Only keep a new point when the data has actually moved on, so a burst of
    // reads inside one scan does not flood the baseline with identical rows.
    const newest = list[0];
    const age = newest ? snapshot.fetchedAt - newest.fetchedAt : Number.POSITIVE_INFINITY;
    if (newest && age >= 0 && age < 60_000) {
      // Same minute: refresh the head rather than flooding the baseline with
      // near-identical rows from one scan.
      list[0] = snapshot;
    } else if (age < 0) {
      // An older snapshot arriving late is backfill. It belongs in the series
      // in time order, never on top of a newer reading.
      const at = list.findIndex((s) => s.fetchedAt <= snapshot.fetchedAt);
      if (at === -1) list.push(snapshot);
      else list.splice(at, 0, snapshot);
    } else {
      list.unshift(snapshot);
    }
    if (list.length > this.maxHistoryPerToken) list.length = this.maxHistoryPerToken;
    this.history.set(snapshot.address, list);
  }

  /** Past snapshots, newest first, excluding the current one. */
  getHistory(address: string): TokenMarketSnapshot[] {
    return (this.history.get(address) ?? []).slice(1);
  }

  get(address: string): TokenMarketSnapshot | null {
    const row = this.db.select().from(tokens).where(eq(tokens.address, address)).get();
    return (row?.marketSnapshot as TokenMarketSnapshot | null) ?? null;
  }

  /**
   * Resolve a bare ticker to a tracked token's address, case-insensitively.
   * Used to turn a trending symbol (all a social or news feed can name) into
   * something the rest of the system can actually look up. Several tokens can
   * share a symbol; the most recently seen one is the reasonable guess.
   */
  findBySymbol(symbol: string): string | null {
    if (!symbol) return null;
    const row = this.db
      .select({ address: tokens.address })
      .from(tokens)
      .where(sql`lower(${tokens.symbol}) = lower(${symbol})`)
      .orderBy(desc(tokens.lastSeenAt))
      .limit(1)
      .get();
    return row?.address ?? null;
  }

  getMany(addresses: string[]): Map<string, TokenMarketSnapshot> {
    if (addresses.length === 0) return new Map();
    const rows = this.db.select().from(tokens).where(inArray(tokens.address, addresses)).all();
    const out = new Map<string, TokenMarketSnapshot>();
    for (const row of rows) {
      const snapshot = row.marketSnapshot as TokenMarketSnapshot | null;
      if (snapshot) out.set(row.address, snapshot);
    }
    return out;
  }

  /** Tokens seen recently, most recent first. Backs the dashboard scanner. */
  recent(limit = 100, sinceMs?: number) {
    const where = sinceMs ? gte(tokens.lastSeenAt, sinceMs) : undefined;
    return this.db
      .select()
      .from(tokens)
      .where(where)
      .orderBy(desc(tokens.lastSeenAt))
      .limit(limit)
      .all();
  }

  count(): number {
    const row = this.db.select({ n: sql<number>`count(*)` }).from(tokens).get();
    return row?.n ?? 0;
  }

  /** Drop tokens nothing has looked at in a long time. */
  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const result = this.db.run(sql`DELETE FROM tokens WHERE last_seen_at < ${cutoff}`);
    return Number(result.changes ?? 0);
  }

  /**
   * Sweep out rows that fail the ingestion sanity checks.
   *
   * `discover()` keeps new garbage from ever being written, but it cannot
   * touch what is already sitting in the table from before that check
   * existed (or from a row nothing has refreshed since). This is that
   * cleanup, safe to call repeatedly - housekeeping runs it on its own
   * schedule so the table self-heals rather than needing a one-off fix.
   */
  removeImplausible(): number {
    const rows = this.db.select({ address: tokens.address, marketSnapshot: tokens.marketSnapshot }).from(tokens).all();
    const bad = rows
      .filter((row) => checkMarketSnapshot(row.marketSnapshot as unknown as TokenMarketSnapshot) != null)
      .map((row) => row.address);
    if (bad.length === 0) return 0;
    this.db.run(sql`DELETE FROM tokens WHERE address IN (${sql.join(bad.map((a) => sql`${a}`), sql`, `)})`);
    for (const address of bad) this.history.delete(address);
    return bad.length;
  }

  /** Chain of the tokens this repository tracks. Single-chain for now. */
  readonly chain: Chain = 'solana';
}
