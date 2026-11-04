import { eq, sql } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import { roundUsd } from '../core/money.js';
import type {
  BucketId,
  ExecutionRequest,
  ExecutionResult,
  Position,
  TradeSignal,
} from '../core/types.js';
import type { Db } from '../db/client.js';
import { positions, trades } from '../db/schema.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { TradeExecutor } from '../providers/interfaces.js';
import { toPosition } from '../portfolio/portfolio-manager.js';

/**
 * Execution Service.
 *
 * Chooses the executor for the current mode, books the result, and keeps the
 * portfolio in step. Agents never reach this class; only the signal engine and
 * the position manager do.
 *
 * The bookkeeping is the important part. Cash leaves the bucket only after a
 * fill is reported, and a failed fill leaves the books exactly as they were.
 */
export class ExecutionService {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly portfolio: PortfolioManager,
    private readonly paper: TradeExecutor,
    private readonly live: TradeExecutor,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
  ) {}

  /** The executor the current mode selects. Paper unless live is fully armed. */
  private executor(): TradeExecutor {
    return this.config.effectiveMode() === 'live' ? this.live : this.paper;
  }

  async openPosition(
    signal: TradeSignal,
    sizeUsd: number,
    priceUsd: number,
  ): Promise<{ result: ExecutionResult; position: Position | null }> {
    const cfg = this.config.get();
    const mode = this.config.effectiveMode();

    const request: ExecutionRequest = {
      signalId: signal.id,
      agent: signal.agent,
      bucket: signal.bucket,
      chain: signal.chain,
      tokenAddress: signal.tokenAddress,
      tokenSymbol: signal.tokenSymbol,
      side: 'buy',
      amountUsd: sizeUsd,
      quantity: null,
      priceUsd,
      maxSlippageBps: cfg.risk.maxSlippageBps,
      mode,
    };

    const result = await this.executor().execute(request);

    if (!result.ok || !result.confirmed) {
      this.log.record({
        level: 'warn',
        category: 'execution',
        agent: signal.agent,
        signalId: signal.id,
        tokenAddress: signal.tokenAddress,
        message: `Buy of ${signal.tokenSymbol} did not fill: ${result.error ?? 'unconfirmed'}`,
        payload: { mode, requestedUsd: sizeUsd, txSignature: result.txSignature },
      });
      return { result, position: null };
    }

    // Total cost is what actually left the bucket: the fill plus its fees.
    const totalCostUsd = roundUsd(result.grossUsd + result.feesUsd);
    const position = this.db.transaction((tx) => {
      this.portfolio.adjustCash(signal.bucket, -totalCostUsd);

      const existing = tx
        .select()
        .from(positions)
        .where(
          sql`${positions.tokenAddress} = ${signal.tokenAddress} AND ${positions.bucket} = ${signal.bucket} AND ${positions.status} = 'open'`,
        )
        .get();

      let row;
      if (existing) {
        // Averaging into an existing position rather than opening a second one
        // keeps exposure honest and keeps the stop meaningful.
        const quantity = existing.quantity + result.filledQuantity;
        const costBasis = roundUsd(existing.costBasisUsd + totalCostUsd);
        const avgPrice = quantity > 0 ? costBasis / quantity : existing.avgEntryPriceUsd;
        tx.update(positions)
          .set({
            quantity,
            costBasisUsd: costBasis,
            avgEntryPriceUsd: avgPrice,
            feesUsd: roundUsd(existing.feesUsd + result.feesUsd),
            stopLossUsd: signal.stopLossUsd,
            takeProfitUsd: signal.targetPriceUsd,
            lastMarkPriceUsd: result.filledPriceUsd,
            highWaterPriceUsd: Math.max(existing.highWaterPriceUsd ?? 0, result.filledPriceUsd),
          })
          .where(eq(positions.id, existing.id))
          .run();
        row = tx.select().from(positions).where(eq(positions.id, existing.id)).get();
      } else {
        const inserted = tx
          .insert(positions)
          .values({
            bucket: signal.bucket,
            agent: signal.agent,
            chain: signal.chain,
            tokenAddress: signal.tokenAddress,
            tokenSymbol: signal.tokenSymbol,
            status: 'open',
            quantity: result.filledQuantity,
            avgEntryPriceUsd: result.filledPriceUsd,
            costBasisUsd: totalCostUsd,
            highWaterPriceUsd: result.filledPriceUsd,
            lastMarkPriceUsd: result.filledPriceUsd,
            stopLossUsd: signal.stopLossUsd,
            takeProfitUsd: signal.targetPriceUsd,
            feesUsd: result.feesUsd,
            openedAt: this.clock.now(),
          })
          .returning({ id: positions.id })
          .get();
        row = tx.select().from(positions).where(eq(positions.id, inserted.id)).get();
      }

      tx.insert(trades)
        .values({
          signalId: signal.id,
          positionId: row!.id,
          bucket: signal.bucket,
          agent: signal.agent,
          mode,
          chain: signal.chain,
          tokenAddress: signal.tokenAddress,
          tokenSymbol: signal.tokenSymbol,
          side: 'buy',
          quantity: result.filledQuantity,
          priceUsd: result.filledPriceUsd,
          grossUsd: result.grossUsd,
          feesUsd: result.feesUsd,
          slippageBps: result.slippageBps,
          realizedPnlUsd: 0,
          score: signal.score,
          reason: signal.reason,
          executedAt: this.clock.now(),
        })
        .run();

      return toPosition(row!);
    });

    return { result, position };
  }

  async closePosition(
    position: Position,
    priceUsd: number,
    reason: string,
    fraction = 1,
  ): Promise<{ result: ExecutionResult; realizedPnlUsd: number }> {
    const cfg = this.config.get();
    const mode = this.config.effectiveMode();
    const quantity = position.quantity * Math.min(1, Math.max(0, fraction));

    const request: ExecutionRequest = {
      signalId: `exit_${position.id}`,
      agent: position.agent,
      bucket: position.bucket,
      chain: position.chain,
      tokenAddress: position.tokenAddress,
      tokenSymbol: position.tokenSymbol,
      side: 'sell',
      amountUsd: null,
      quantity,
      priceUsd,
      // Exits get more slippage room than entries. Being unable to leave is a
      // far worse outcome than leaving a little cheaper than hoped.
      maxSlippageBps: Math.max(cfg.risk.maxSlippageBps, cfg.risk.maxSlippageBps * 2),
      mode,
    };

    const result = await this.executor().execute(request);

    if (!result.ok || !result.confirmed) {
      this.log.record({
        level: 'error',
        category: 'execution',
        agent: position.agent,
        tokenAddress: position.tokenAddress,
        message: `Exit of ${position.tokenSymbol} failed: ${result.error ?? 'unconfirmed'}. The position is still open.`,
        payload: { mode, positionId: position.id, txSignature: result.txSignature },
      });
      return { result, realizedPnlUsd: 0 };
    }

    const proceedsUsd = roundUsd(result.grossUsd - result.feesUsd);
    const costPortion = roundUsd(position.costBasisUsd * (quantity / position.quantity));
    const realizedPnlUsd = roundUsd(proceedsUsd - costPortion);

    this.db.transaction((tx) => {
      this.portfolio.adjustCash(position.bucket, proceedsUsd);
      this.portfolio.recordRealizedPnl(position.bucket, realizedPnlUsd);

      const remaining = position.quantity - quantity;
      const closed = remaining <= 1e-9;
      tx.update(positions)
        .set({
          quantity: closed ? 0 : remaining,
          costBasisUsd: closed ? 0 : roundUsd(position.costBasisUsd - costPortion),
          realizedPnlUsd: roundUsd(position.realizedPnlUsd + realizedPnlUsd),
          feesUsd: roundUsd(position.feesUsd + result.feesUsd),
          lastMarkPriceUsd: result.filledPriceUsd,
          status: closed ? 'closed' : 'open',
          closedAt: closed ? this.clock.now() : null,
        })
        .where(eq(positions.id, position.id))
        .run();

      tx.insert(trades)
        .values({
          signalId: null,
          positionId: position.id,
          bucket: position.bucket,
          agent: position.agent,
          mode,
          chain: position.chain,
          tokenAddress: position.tokenAddress,
          tokenSymbol: position.tokenSymbol,
          side: 'sell',
          quantity,
          priceUsd: result.filledPriceUsd,
          grossUsd: result.grossUsd,
          feesUsd: result.feesUsd,
          slippageBps: result.slippageBps,
          realizedPnlUsd,
          score: null,
          reason,
          executedAt: this.clock.now(),
        })
        .run();
    });

    this.log.record({
      category: 'execution',
      agent: position.agent,
      tokenAddress: position.tokenAddress,
      message:
        `Closed ${position.tokenSymbol} for ${realizedPnlUsd >= 0 ? 'a profit' : 'a loss'} of ` +
        `$${Math.abs(realizedPnlUsd).toFixed(2)}. ${reason}`,
      payload: { mode, positionId: position.id, realizedPnlUsd, txSignature: result.txSignature },
    });

    return { result, realizedPnlUsd };
  }

  bucketOf(agent: string): BucketId | null {
    const found = this.portfolio.getState().buckets.find((b) => b.bucket === agent);
    return found?.bucket ?? null;
  }
}
