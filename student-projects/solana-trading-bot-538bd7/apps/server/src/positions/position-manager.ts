import { eq } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import type { Position } from '../core/types.js';
import type { Db } from '../db/client.js';
import { positions } from '../db/schema.js';
import type { ExecutionService } from '../execution/execution-service.js';
import type { MarketService } from '../market/market-service.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';

/**
 * Position Manager.
 *
 * Marks open positions to market and enforces the exits: stop loss, take
 * profit, trailing stop, the per-trade loss ceiling, and mirrored exits when a
 * followed wallet leaves a copied position.
 *
 * Exits are never blocked by the risk limits or the kill switch. Being unable
 * to leave is worse than any limit those rules protect.
 */
export interface MarkResult {
  marked: number;
  closed: number;
  marks: Map<string, number>;
}

export class PositionManager {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly portfolio: PortfolioManager,
    private readonly market: MarketService,
    private readonly execution: ExecutionService,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
  ) {}

  async markAndManage(leaderExits: Set<string> = new Set()): Promise<MarkResult> {
    const open = this.portfolio.openPositions();
    if (open.length === 0) return { marked: 0, closed: 0, marks: new Map() };

    const addresses = [...new Set(open.map((p) => p.tokenAddress))];
    const snapshots = await this.market.refresh(addresses);
    const marks = new Map<string, number>();
    let closed = 0;

    for (const position of open) {
      const snapshot = snapshots.get(position.tokenAddress);
      const price = snapshot?.priceUsd ?? position.lastMarkPriceUsd ?? 0;
      if (price <= 0) {
        // A position we cannot price is a position we cannot manage. Say so
        // rather than silently leaving the stop unenforced.
        this.log.record({
          level: 'warn',
          category: 'portfolio',
          agent: position.agent,
          tokenAddress: position.tokenAddress,
          message: `No price for ${position.tokenSymbol}, so its stop and target could not be checked this cycle.`,
        });
        continue;
      }
      marks.set(position.tokenAddress, price);

      const highWater = this.updateMark(position, price);
      const exit = this.exitFor(position, price, highWater, leaderExits);
      if (!exit) continue;

      const { result } = await this.execution.closePosition(position, price, exit.reason);
      if (result.ok && result.confirmed) closed += 1;
    }

    return { marked: marks.size, closed, marks };
  }

  /** Store the latest mark and raise the high water mark. */
  private updateMark(position: Position, price: number): number {
    const row = this.db.select().from(positions).where(eq(positions.id, position.id)).get();
    const highWater = Math.max(row?.highWaterPriceUsd ?? 0, price);
    this.db
      .update(positions)
      .set({ lastMarkPriceUsd: price, highWaterPriceUsd: highWater })
      .where(eq(positions.id, position.id))
      .run();
    return highWater;
  }

  /** Which exit rule fires, if any. Pure enough to test directly. */
  exitFor(
    position: Position,
    price: number,
    highWaterPriceUsd: number,
    leaderExits: Set<string>,
  ): { reason: string; rule: string } | null {
    const risk = this.config.get().risk;
    const pnlPct =
      position.avgEntryPriceUsd > 0
        ? ((price - position.avgEntryPriceUsd) / position.avgEntryPriceUsd) * 100
        : 0;

    if (position.stopLossUsd != null && price <= position.stopLossUsd) {
      return {
        rule: 'stop_loss',
        reason: `Stop loss hit at $${price.toPrecision(4)}, down ${Math.abs(pnlPct).toFixed(1)}% from entry.`,
      };
    }

    if (position.takeProfitUsd != null && price >= position.takeProfitUsd) {
      return {
        rule: 'take_profit',
        reason: `Take profit hit at $${price.toPrecision(4)}, up ${pnlPct.toFixed(1)}% from entry.`,
      };
    }

    // A hard ceiling on how much one trade may lose, independent of where the
    // stop was originally placed.
    if (pnlPct <= -risk.maxLossPerTradePct) {
      return {
        rule: 'max_loss',
        reason: `Loss of ${Math.abs(pnlPct).toFixed(1)}% passed the ${risk.maxLossPerTradePct}% per-trade ceiling.`,
      };
    }

    if (risk.trailingStopPct > 0 && highWaterPriceUsd > 0) {
      const dropPct = ((highWaterPriceUsd - price) / highWaterPriceUsd) * 100;
      // Only trail once the position has actually been in profit; otherwise
      // the trailing stop just duplicates the fixed stop at a worse price.
      if (highWaterPriceUsd > position.avgEntryPriceUsd && dropPct >= risk.trailingStopPct) {
        return {
          rule: 'trailing_stop',
          reason: `Trailing stop hit: down ${dropPct.toFixed(1)}% from a high of $${highWaterPriceUsd.toPrecision(4)}.`,
        };
      }
    }

    if (
      position.agent === 'copy_trade' &&
      this.config.get().agents.copy_trade.mirrorExits &&
      leaderExits.has(position.tokenAddress)
    ) {
      return {
        rule: 'mirror_exit',
        reason: 'The followed wallet sold out of this token, so the copied position was closed too.',
      };
    }

    return null;
  }

  /** Close everything. Backs the emergency control in the dashboard. */
  async closeAll(reason: string): Promise<number> {
    const open = this.portfolio.openPositions();
    if (open.length === 0) return 0;
    const snapshots = await this.market.refresh([...new Set(open.map((p) => p.tokenAddress))]);
    let closed = 0;
    for (const position of open) {
      const price = snapshots.get(position.tokenAddress)?.priceUsd ?? 0;
      if (price <= 0) continue;
      const { result } = await this.execution.closePosition(position, price, reason);
      if (result.ok && result.confirmed) closed += 1;
    }
    return closed;
  }
}
