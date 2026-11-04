import { and, eq, gte } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import { roundUsd } from '../core/money.js';
import type {
  RiskCheckResult,
  RiskDecision,
  TokenMarketSnapshot,
  TradeSignal,
} from '../core/types.js';
import type { Db } from '../db/client.js';
import { trades } from '../db/schema.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';

/**
 * Risk Manager.
 *
 * The last word before anything is executed. It can reject any signal from any
 * agent, and it can shrink one that is merely too large rather than refusing
 * it outright.
 *
 * Every check is recorded whether it passed or failed, so the decision log can
 * answer "why was this approved" as precisely as "why was this rejected".
 */
export class RiskManager {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly portfolio: PortfolioManager,
    private readonly clock: Clock,
  ) {}

  evaluate(signal: TradeSignal, market: TokenMarketSnapshot | null): RiskDecision {
    const cfg = this.config.get().risk;
    const checks: RiskCheckResult[] = [];
    const reasons: string[] = [];
    const now = this.clock.now();

    // The kill switch answers first and answers alone.
    if (cfg.killSwitch) {
      return {
        approved: false,
        approvedSizeUsd: 0,
        stage: 'kill_switch',
        reasons: ['The kill switch is engaged, so no new positions may be opened.'],
        checks: [{ code: 'KILL_SWITCH', passed: false, message: 'Kill switch is engaged' }],
      };
    }
    checks.push({ code: 'KILL_SWITCH', passed: true, message: 'Kill switch is off' });

    const state = this.portfolio.getState();

    // --- Portfolio-level gates. These stop trading entirely, so they run
    // before anything that only affects sizing.

    const dailyLoss = this.portfolio.dailyLossPct(state);
    const dailyOk = dailyLoss < cfg.maxDailyLossPct;
    checks.push({
      code: 'MAX_DAILY_LOSS',
      passed: dailyOk,
      message: dailyOk
        ? `Down ${dailyLoss.toFixed(2)}% today, limit is ${cfg.maxDailyLossPct}%`
        : `Daily loss limit hit: down ${dailyLoss.toFixed(2)}% against a ${cfg.maxDailyLossPct}% limit`,
      observed: dailyLoss,
      limit: cfg.maxDailyLossPct,
    });
    if (!dailyOk) reasons.push(`Daily loss limit reached (${dailyLoss.toFixed(2)}%).`);

    const openTotal = state.openPositions;
    const openOk = openTotal < cfg.maxOpenPositions;
    checks.push({
      code: 'MAX_OPEN_POSITIONS',
      passed: openOk,
      message: `${openTotal} open positions, limit ${cfg.maxOpenPositions}`,
      observed: openTotal,
      limit: cfg.maxOpenPositions,
    });
    if (!openOk) reasons.push('Already at the maximum number of open positions.');

    const bucketState = state.buckets.find((b) => b.bucket === signal.bucket);
    const bucketOpen = bucketState?.openPositions ?? 0;
    const bucketOpenOk = bucketOpen < cfg.maxOpenPositionsPerBucket;
    checks.push({
      code: 'MAX_OPEN_POSITIONS_BUCKET',
      passed: bucketOpenOk,
      message: `${bucketOpen} open in this bucket, limit ${cfg.maxOpenPositionsPerBucket}`,
      observed: bucketOpen,
      limit: cfg.maxOpenPositionsPerBucket,
    });
    if (!bucketOpenOk) reasons.push('This bucket is already at its position limit.');

    // --- Duplicate protection and rate limiting.

    const cooldownMs = cfg.duplicateTradeCooldownSec * 1_000;
    const duplicate =
      cooldownMs > 0 &&
      Boolean(
        this.db
          .select()
          .from(trades)
          .where(
            and(
              eq(trades.agent, signal.agent),
              eq(trades.tokenAddress, signal.tokenAddress),
              eq(trades.side, 'buy'),
              gte(trades.executedAt, now - cooldownMs),
            ),
          )
          .limit(1)
          .get(),
      );
    checks.push({
      code: 'DUPLICATE_TRADE',
      passed: !duplicate,
      message: duplicate
        ? `This agent already bought this token inside the ${cfg.duplicateTradeCooldownSec}s cooldown`
        : 'No duplicate trade inside the cooldown window',
    });
    if (duplicate) reasons.push('Duplicate trade blocked by the cooldown window.');

    const hourAgo = now - 3_600_000;
    const recentCount = this.db
      .select()
      .from(trades)
      .where(and(eq(trades.agent, signal.agent), gte(trades.executedAt, hourAgo)))
      .all().length;
    const rateOk = cfg.maxTradesPerAgentPerHour === 0 || recentCount < cfg.maxTradesPerAgentPerHour;
    checks.push({
      code: 'RATE_LIMIT',
      passed: rateOk,
      message: `${recentCount} trades by this agent in the last hour, limit ${cfg.maxTradesPerAgentPerHour}`,
      observed: recentCount,
      limit: cfg.maxTradesPerAgentPerHour,
    });
    if (!rateOk) reasons.push('This agent has hit its hourly trade limit.');

    // --- Market quality gates.

    const liquidity = market?.liquidityUsd ?? 0;
    const liquidityOk = liquidity >= cfg.minLiquidityUsd;
    checks.push({
      code: 'MIN_LIQUIDITY',
      passed: liquidityOk,
      message: liquidityOk
        ? `Pool holds $${Math.round(liquidity).toLocaleString()}`
        : `Pool holds $${Math.round(liquidity).toLocaleString()}, below the $${cfg.minLiquidityUsd.toLocaleString()} floor`,
      observed: liquidity,
      limit: cfg.minLiquidityUsd,
    });
    if (!liquidityOk) reasons.push('Liquidity is below the risk floor.');

    const priceOk = (market?.priceUsd ?? 0) > 0;
    checks.push({
      code: 'PRICE_AVAILABLE',
      passed: priceOk,
      message: priceOk ? 'Token has a usable price' : 'No usable price, cannot size the position',
    });
    if (!priceOk) reasons.push('No usable price for this token.');

    // --- Sizing. Everything below shrinks the trade rather than refusing it,
    // until it shrinks below the minimum worth making.

    const requested = signal.requestedSizeUsd ?? cfg.maxPositionUsd;
    let size = requested;
    const caps: Array<{ code: string; cap: number; message: string }> = [];

    caps.push({
      code: 'MAX_POSITION_USD',
      cap: cfg.maxPositionUsd,
      message: `Hard position cap of $${cfg.maxPositionUsd}`,
    });

    const bucketAllocated = bucketState?.allocatedUsd ?? 0;
    caps.push({
      code: 'MAX_POSITION_PCT_OF_BUCKET',
      cap: (bucketAllocated * cfg.maxPositionPctOfBucket) / 100,
      message: `${cfg.maxPositionPctOfBucket}% of a $${Math.round(bucketAllocated).toLocaleString()} bucket`,
    });

    const bucketExposure = bucketState?.investedUsd ?? 0;
    const bucketRoom = (bucketAllocated * cfg.maxBucketExposurePct) / 100 - bucketExposure;
    caps.push({
      code: 'MAX_BUCKET_EXPOSURE',
      cap: Math.max(0, bucketRoom),
      message: `Bucket exposure ceiling of ${cfg.maxBucketExposurePct}%`,
    });

    const totalRoom = (state.totalValueUsd * cfg.maxTotalExposurePct) / 100 - state.investedUsd;
    caps.push({
      code: 'MAX_TOTAL_EXPOSURE',
      cap: Math.max(0, totalRoom),
      message: `Portfolio exposure ceiling of ${cfg.maxTotalExposurePct}%`,
    });

    // One token must not become the whole portfolio, even across buckets.
    const tokenExposure = this.portfolio
      .openPositions()
      .filter((p) => p.tokenAddress === signal.tokenAddress)
      .reduce((acc, p) => acc + p.costBasisUsd, 0);
    const concentrationRoom =
      (state.totalValueUsd * cfg.maxTokenConcentrationPct) / 100 - tokenExposure;
    caps.push({
      code: 'MAX_TOKEN_CONCENTRATION',
      cap: Math.max(0, concentrationRoom),
      message: `Single-token ceiling of ${cfg.maxTokenConcentrationPct}%`,
    });

    // A trade big enough to move the pool against itself is a trade that
    // cannot be exited at the price it assumed.
    const poolCap = (liquidity * cfg.maxPoolShareBps) / 10_000;
    caps.push({
      code: 'MAX_POOL_SHARE',
      cap: poolCap,
      message: `At most ${(cfg.maxPoolShareBps / 100).toFixed(2)}% of the pool`,
    });

    // Cash on hand, less the buffer that keeps exits fundable.
    const buffer = (bucketAllocated * this.config.get().portfolio.cashBufferPct) / 100;
    const spendable = (bucketState?.availableUsd ?? 0) - buffer;
    caps.push({
      code: 'AVAILABLE_CASH',
      cap: Math.max(0, spendable),
      message: `$${Math.max(0, spendable).toFixed(2)} spendable after the cash buffer`,
    });

    let binding: string | null = null;
    for (const cap of caps) {
      const capped = Math.min(size, cap.cap);
      const passed = cap.cap > 0;
      checks.push({
        code: cap.code,
        passed,
        message: `${cap.message} allows $${Math.max(0, cap.cap).toFixed(2)}`,
        observed: size,
        limit: cap.cap,
      });
      if (capped < size) binding = cap.code;
      size = capped;
    }

    size = roundUsd(Math.max(0, size));

    const sizeOk = size >= cfg.minPositionUsd;
    checks.push({
      code: 'MIN_POSITION_USD',
      passed: sizeOk,
      message: sizeOk
        ? `Approved size $${size.toFixed(2)}`
        : `Allowed size $${size.toFixed(2)} is below the $${cfg.minPositionUsd} minimum worth trading`,
      observed: size,
      limit: cfg.minPositionUsd,
    });
    if (!sizeOk) {
      reasons.push(
        binding
          ? `Position would be only $${size.toFixed(2)} once limits are applied (${binding}).`
          : `Position size of $${size.toFixed(2)} is below the minimum.`,
      );
    }

    const failed = checks.filter((c) => !c.passed);
    const approved = failed.length === 0;

    return {
      approved,
      approvedSizeUsd: approved ? size : 0,
      stage: approved ? null : 'risk',
      reasons: approved
        ? [
            `Approved at $${size.toFixed(2)}${binding ? `, limited by ${binding}` : ''}.`,
          ]
        : reasons,
      checks,
    };
  }

  /** Whether an exit is allowed. Exits are almost never blocked, by design. */
  evaluateExit(): RiskDecision {
    // The kill switch stops new positions; it must never trap an existing one.
    return {
      approved: true,
      approvedSizeUsd: 0,
      stage: null,
      reasons: ['Exits are always permitted.'],
      checks: [{ code: 'EXIT_ALLOWED', passed: true, message: 'Exits are never blocked by risk limits' }],
    };
  }
}
