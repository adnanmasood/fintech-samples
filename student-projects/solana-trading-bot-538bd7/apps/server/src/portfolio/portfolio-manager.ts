import { and, eq, sql } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import { roundUsd } from '../core/money.js';
import { AppError } from '../core/errors.js';
import type { BucketId, BucketState, PortfolioState, Position } from '../core/types.js';
import { BUCKETS, BUCKET_LABELS } from '../core/types.js';
import type { Db } from '../db/client.js';
import { pnlSnapshots, portfolioBuckets, positions, trades } from '../db/schema.js';

/**
 * Portfolio Manager.
 *
 * The wallet is one wallet on chain. The four buckets are a logical division
 * of it, each with its own cash, its own exposure and its own P&L, so a
 * runaway strategy can only ever spend its own allocation.
 *
 * Cash is held per bucket rather than derived, because deriving it from trade
 * history would make every sizing decision an O(all trades) query and would
 * drift as soon as one write failed.
 */
export class PortfolioManager {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  /** Create the four buckets on first boot and fund them for paper mode. */
  initialise(): void {
    const cfg = this.config.get();
    const existing = this.db.select().from(portfolioBuckets).all();
    if (existing.length === BUCKETS.length) {
      this.applyAllocations(cfg.portfolio.allocations);
      return;
    }
    const total = cfg.portfolio.paperStartingBalanceUsd;
    this.db.transaction((tx) => {
      for (const bucket of BUCKETS) {
        const pct = cfg.portfolio.allocations[bucket];
        tx.insert(portfolioBuckets)
          .values({
            id: bucket,
            label: BUCKET_LABELS[bucket],
            allocationPct: pct,
            cashUsd: roundUsd((total * pct) / 100),
            realizedPnlUsd: 0,
            updatedAt: this.clock.now(),
          })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  /**
   * Apply new allocation percentages.
   *
   * Only uninvested cash is redistributed. Open positions keep their bucket,
   * because forcibly rebalancing them would mean selling into the market on a
   * settings change, which nobody asked for.
   */
  applyAllocations(allocations: Record<BucketId, number>): void {
    const total = BUCKETS.reduce((acc, b) => acc + allocations[b], 0);
    if (Math.abs(total - 100) > 0.01) {
      throw new AppError(
        `Bucket allocations must total 100%, got ${total.toFixed(2)}%`,
        'ALLOCATION_INVALID',
        400,
      );
    }
    const rows = this.db.select().from(portfolioBuckets).all();
    const totalCash = rows.reduce((acc, r) => acc + r.cashUsd, 0);
    this.db.transaction((tx) => {
      for (const bucket of BUCKETS) {
        tx.update(portfolioBuckets)
          .set({
            allocationPct: allocations[bucket],
            cashUsd: roundUsd((totalCash * allocations[bucket]) / 100),
            updatedAt: this.clock.now(),
          })
          .where(eq(portfolioBuckets.id, bucket))
          .run();
      }
    });
  }

  getBucketCash(bucket: BucketId): number {
    const row = this.db.select().from(portfolioBuckets).where(eq(portfolioBuckets.id, bucket)).get();
    return row?.cashUsd ?? 0;
  }

  /**
   * Move cash in or out of a bucket.
   * Throws rather than going negative: a bucket that can overdraw is a bucket
   * that is not really a limit.
   */
  adjustCash(bucket: BucketId, deltaUsd: number): number {
    const current = this.getBucketCash(bucket);
    const next = roundUsd(current + deltaUsd);
    if (next < -0.005) {
      throw new AppError(
        `${BUCKET_LABELS[bucket]} has $${current.toFixed(2)} and cannot spend $${Math.abs(deltaUsd).toFixed(2)}`,
        'INSUFFICIENT_BUCKET_CASH',
        400,
        { bucket, available: current, requested: Math.abs(deltaUsd) },
      );
    }
    this.db
      .update(portfolioBuckets)
      .set({ cashUsd: Math.max(0, next), updatedAt: this.clock.now() })
      .where(eq(portfolioBuckets.id, bucket))
      .run();
    return Math.max(0, next);
  }

  recordRealizedPnl(bucket: BucketId, pnlUsd: number): void {
    this.db
      .update(portfolioBuckets)
      .set({
        realizedPnlUsd: sql`${portfolioBuckets.realizedPnlUsd} + ${pnlUsd}`,
        updatedAt: this.clock.now(),
      })
      .where(eq(portfolioBuckets.id, bucket))
      .run();
  }

  openPositions(bucket?: BucketId): Position[] {
    const where = bucket
      ? and(eq(positions.status, 'open'), eq(positions.bucket, bucket))
      : eq(positions.status, 'open');
    return this.db
      .select()
      .from(positions)
      .where(where)
      .all()
      .map(toPosition);
  }

  /** Exposure is measured at cost, so it cannot be inflated by an unrealised gain. */
  bucketExposureUsd(bucket: BucketId): number {
    const rows = this.openPositions(bucket);
    return roundUsd(rows.reduce((acc, p) => acc + p.costBasisUsd, 0));
  }

  totalExposureUsd(): number {
    return roundUsd(this.openPositions().reduce((acc, p) => acc + p.costBasisUsd, 0));
  }

  /**
   * Realised P&L per bucket for one mode, read back from the trades that
   * produced it.
   *
   * The running tally on `portfolio_buckets` cannot answer this: it is one
   * number covering both books, so in live mode it reports profits that were
   * made on paper. The trades table already records which mode each fill
   * happened in, so it is the only source that can separate them.
   */
  private realizedByBucket(mode: 'paper' | 'live'): Map<string, number> {
    const rows = this.db
      .select({
        bucket: trades.bucket,
        realized: sql<number>`COALESCE(SUM(${trades.realizedPnlUsd}), 0)`,
      })
      .from(trades)
      .where(eq(trades.mode, mode))
      .groupBy(trades.bucket)
      .all();
    return new Map(rows.map((r) => [r.bucket, Number(r.realized)]));
  }

  /** Full state, with positions marked against the supplied prices. */
  getState(marks: Map<string, number> = new Map()): PortfolioState {
    const cfg = this.config.get();
    const bucketRows = this.db.select().from(portfolioBuckets).all();
    const open = this.openPositions();
    const realized = this.realizedByBucket(this.config.effectiveMode());

    const buckets: BucketState[] = [];
    let totalCash = 0;
    let totalReserved = 0;
    let totalInvested = 0;
    let totalUnrealized = 0;
    let totalRealized = 0;

    for (const row of bucketRows) {
      const bucket = row.id as BucketId;
      const bucketPositions = open.filter((p) => p.bucket === bucket);
      const invested = roundUsd(bucketPositions.reduce((acc, p) => acc + p.costBasisUsd, 0));
      const unrealized = roundUsd(
        bucketPositions.reduce((acc, p) => {
          const mark = marks.get(p.tokenAddress);
          if (mark == null) return acc;
          return acc + (mark * p.quantity - p.costBasisUsd);
        }, 0),
      );
      // What this bucket is entitled to overall, cash plus what it has out.
      const allocatedUsd = roundUsd(row.cashUsd + invested);
      // The same cash buffer the risk manager holds back from new trades
      // (risk-manager.ts), surfaced here so "available" on the dashboard
      // means what it says rather than overstating what can actually be
      // spent.
      const reserved = roundUsd(
        Math.min(row.cashUsd, (allocatedUsd * cfg.portfolio.cashBufferPct) / 100),
      );
      const bucketRealized = realized.get(bucket) ?? 0;
      totalCash += row.cashUsd;
      totalReserved += reserved;
      totalInvested += invested;
      totalUnrealized += unrealized;
      totalRealized += bucketRealized;

      buckets.push({
        bucket,
        allocationPct: row.allocationPct,
        allocatedUsd,
        availableUsd: roundUsd(row.cashUsd),
        reservedUsd: reserved,
        spendableUsd: roundUsd(Math.max(0, row.cashUsd - reserved)),
        investedUsd: invested,
        unrealizedPnlUsd: unrealized,
        realizedPnlUsd: roundUsd(bucketRealized),
        openPositions: bucketPositions.length,
      });
    }

    const totalValue = roundUsd(totalCash + totalInvested + totalUnrealized);
    const today = this.dayKey();
    const daily = this.db
      .select()
      .from(pnlSnapshots)
      .where(and(eq(pnlSnapshots.day, today), sql`${pnlSnapshots.bucket} IS NULL`))
      .get();
    const startEquity = daily?.startEquityUsd ?? totalValue;
    const peak = Math.max(daily?.peakEquityUsd ?? totalValue, totalValue);

    return {
      mode: this.config.effectiveMode(),
      totalValueUsd: totalValue,
      cashUsd: roundUsd(totalCash),
      reservedUsd: roundUsd(totalReserved),
      spendableUsd: roundUsd(Math.max(0, totalCash - totalReserved)),
      investedUsd: roundUsd(totalInvested),
      unrealizedPnlUsd: roundUsd(totalUnrealized),
      realizedPnlUsd: roundUsd(totalRealized),
      dailyPnlUsd: roundUsd(totalValue - startEquity),
      drawdownPct: peak > 0 ? roundUsd(((peak - totalValue) / peak) * 100) : 0,
      openPositions: open.length,
      buckets,
      asOf: this.clock.now(),
    };
  }

  /**
   * Write today's equity mark. The daily-loss limit reads the start figure, so
   * the first call of a new UTC day is what sets the day's baseline.
   */
  snapshotDaily(state: PortfolioState): void {
    const day = this.dayKey();
    const existing = this.db
      .select()
      .from(pnlSnapshots)
      .where(and(eq(pnlSnapshots.day, day), sql`${pnlSnapshots.bucket} IS NULL`))
      .get();

    if (!existing) {
      // Carry yesterday's peak forward so drawdown is measured from the real
      // high water mark, not from midnight.
      const previousPeak = this.db
        .select()
        .from(pnlSnapshots)
        .where(sql`${pnlSnapshots.bucket} IS NULL`)
        .orderBy(sql`${pnlSnapshots.day} DESC`)
        .limit(1)
        .get();
      this.db
        .insert(pnlSnapshots)
        .values({
          day,
          bucket: null,
          startEquityUsd: state.totalValueUsd,
          equityUsd: state.totalValueUsd,
          realizedPnlUsd: state.realizedPnlUsd,
          unrealizedPnlUsd: state.unrealizedPnlUsd,
          peakEquityUsd: Math.max(previousPeak?.peakEquityUsd ?? 0, state.totalValueUsd),
          updatedAt: this.clock.now(),
        })
        .run();
      return;
    }

    this.db
      .update(pnlSnapshots)
      .set({
        equityUsd: state.totalValueUsd,
        realizedPnlUsd: state.realizedPnlUsd,
        unrealizedPnlUsd: state.unrealizedPnlUsd,
        peakEquityUsd: Math.max(existing.peakEquityUsd, state.totalValueUsd),
        updatedAt: this.clock.now(),
      })
      .where(eq(pnlSnapshots.id, existing.id))
      .run();
  }

  /** Loss so far today as a percent of the day's opening equity. */
  dailyLossPct(state: PortfolioState): number {
    const day = this.dayKey();
    const row = this.db
      .select()
      .from(pnlSnapshots)
      .where(and(eq(pnlSnapshots.day, day), sql`${pnlSnapshots.bucket} IS NULL`))
      .get();
    const start = row?.startEquityUsd ?? state.totalValueUsd;
    if (start <= 0) return 0;
    const change = ((state.totalValueUsd - start) / start) * 100;
    return change < 0 ? Math.abs(change) : 0;
  }

  /**
   * Open a fresh set of books at a new starting total.
   *
   * Paper and live share one ledger, so switching between them has to move
   * the cash and the day's baseline together. Leaving the snapshot alone
   * means "today" is still measured from the previous book — which is how a
   * $10,000 simulated balance against a $9 wallet became a 99.91% daily loss.
   *
   * Realised P&L is not touched here: it is derived per mode in `getState`,
   * so each book keeps its own record across a switch rather than being
   * wiped. Open positions are left alone — their cost basis is already out of
   * cash — and the caller refuses the reset while any are open.
   */
  resetBooks(totalUsd: number): void {
    const allocations = this.config.get().portfolio.allocations;
    const total = roundUsd(Math.max(0, totalUsd));
    const now = this.clock.now();

    this.db.transaction((tx) => {
      for (const bucket of BUCKETS) {
        tx.update(portfolioBuckets)
          .set({
            cashUsd: roundUsd((total * allocations[bucket]) / 100),
            updatedAt: now,
          })
          .where(eq(portfolioBuckets.id, bucket))
          .run();
      }
    });

    // Rebaseline today so the daily figure and the drawdown start from this
    // book rather than the one before it. Written explicitly rather than left
    // absent: snapshotDaily() carries the previous peak forward when today's
    // row is missing, which would reinstate the old high water mark.
    this.rebaselineDay(total, now);
  }

  private rebaselineDay(equityUsd: number, now: number): void {
    const day = this.dayKey(now);
    const existing = this.db
      .select()
      .from(pnlSnapshots)
      .where(and(eq(pnlSnapshots.day, day), sql`${pnlSnapshots.bucket} IS NULL`))
      .get();

    const values = {
      startEquityUsd: equityUsd,
      equityUsd,
      peakEquityUsd: equityUsd,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
      updatedAt: now,
    };

    if (existing) {
      this.db.update(pnlSnapshots).set(values).where(eq(pnlSnapshots.id, existing.id)).run();
      return;
    }
    this.db.insert(pnlSnapshots).values({ day, bucket: null, ...values }).run();
  }

  /** Deposit or withdraw, split across buckets by their allocations. */
  fund(amountUsd: number): void {
    const allocations = this.config.get().portfolio.allocations;
    this.db.transaction(() => {
      for (const bucket of BUCKETS) {
        this.adjustCash(bucket, (amountUsd * allocations[bucket]) / 100);
      }
    });
  }

  private dayKey(now = this.clock.now()): string {
    return new Date(now).toISOString().slice(0, 10);
  }
}

function toPosition(row: typeof positions.$inferSelect): Position {
  return {
    id: row.id,
    bucket: row.bucket as BucketId,
    agent: row.agent as Position['agent'],
    chain: row.chain as Position['chain'],
    tokenAddress: row.tokenAddress,
    tokenSymbol: row.tokenSymbol,
    status: row.status as 'open' | 'closed',
    quantity: row.quantity,
    avgEntryPriceUsd: row.avgEntryPriceUsd,
    costBasisUsd: row.costBasisUsd,
    lastMarkPriceUsd: row.lastMarkPriceUsd,
    highWaterPriceUsd: row.highWaterPriceUsd,
    stopLossUsd: row.stopLossUsd,
    takeProfitUsd: row.takeProfitUsd,
    realizedPnlUsd: row.realizedPnlUsd,
    feesUsd: row.feesUsd,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
  };
}

export { toPosition };
