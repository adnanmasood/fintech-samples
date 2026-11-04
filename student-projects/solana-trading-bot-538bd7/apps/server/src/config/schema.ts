import { z } from 'zod';
import { AGENTS, BUCKETS } from '../core/types.js';

/**
 * The runtime trading configuration.
 *
 * Everything a trader would want to tune lives here, nothing is hard-coded in
 * a strategy, and the whole object is validated on every write. It is stored
 * in the database as one JSON document and served to the dashboard.
 *
 * Secrets are NOT part of this schema. Keys and the wallet come from the
 * environment only, so nothing sensitive can ever reach the API or the UI.
 */

const pct = z.number().min(0).max(100);
const fraction = z.number().min(0).max(1);
const score = z.number().min(0).max(100);
const positive = z.number().positive();
const nonNegative = z.number().min(0);

export const bucketAllocationSchema = z.object({
  copy_trading: pct,
  hot_trading: pct,
  hidden_gems: pct,
  low_market_cap: pct,
});

export const scoringWeightsSchema = z.object({
  security: fraction,
  liquidity: fraction,
  momentum: fraction,
  volume: fraction,
  smartMoney: fraction,
  holderGrowth: fraction,
  social: fraction,
  sentiment: fraction,
  marketCap: fraction,
  trader: fraction,
});

export type ScoringWeights = z.infer<typeof scoringWeightsSchema>;

export const riskLimitsSchema = z.object({
  /** Largest single position, as a percent of the bucket's allocation. */
  maxPositionPctOfBucket: pct,
  /** Hard ceiling on one trade in USD, whatever the percentages say. */
  maxPositionUsd: positive,
  /** Smallest trade worth making. Below this the signal is dropped. */
  minPositionUsd: positive,
  /** Largest share of a bucket that may be invested at once. */
  maxBucketExposurePct: pct,
  /** Largest share of the whole portfolio that may be invested at once. */
  maxTotalExposurePct: pct,
  /** Trading halts for the rest of the day past this loss, as a percent of day-start equity. */
  maxDailyLossPct: pct,
  maxOpenPositions: z.number().int().positive(),
  maxOpenPositionsPerBucket: z.number().int().positive(),
  /** Largest acceptable loss on one trade, as a percent of its cost basis. */
  maxLossPerTradePct: pct,
  stopLossPct: pct,
  takeProfitPct: pct,
  /** Trailing stop, as a percent below the position's high water mark. Zero disables it. */
  trailingStopPct: pct,
  maxSlippageBps: z.number().int().min(1).max(5_000),
  minLiquidityUsd: nonNegative,
  /** A trade may not take more than this share of the pool's liquidity. */
  maxPoolShareBps: z.number().int().min(1).max(10_000),
  maxGasUsd: nonNegative,
  /** Ceiling on one token's share of the whole portfolio. */
  maxTokenConcentrationPct: pct,
  /** Same agent, same token, same side is refused inside this window. */
  duplicateTradeCooldownSec: z.number().int().min(0),
  /** Ceiling on trades per agent per hour. */
  maxTradesPerAgentPerHour: z.number().int().min(0),
  minSecurityScore: score,
  killSwitch: z.boolean(),
});

export type RiskLimits = z.infer<typeof riskLimitsSchema>;

export const securityConfigSchema = z.object({
  /** Any flag at or above this severity rejects the token outright. */
  rejectAtSeverity: z.enum(['low', 'medium', 'high', 'critical']),
  minLiquidityUsd: nonNegative,
  minTokenAgeMinutes: nonNegative,
  maxTopHolderPct: pct,
  maxTop10HolderPct: pct,
  maxBuyTaxBps: z.number().int().min(0).max(10_000),
  maxSellTaxBps: z.number().int().min(0).max(10_000),
  /** Reject when the pool's LP tokens are not at least this fraction locked or burned. */
  minLpLockedFraction: fraction,
  requireMintAuthorityRevoked: z.boolean(),
  requireFreezeAuthorityRevoked: z.boolean(),
  /** Wash-trading heuristic: refuse a 24h volume above this multiple of liquidity. */
  maxVolumeToLiquidityRatio: positive,
  /** Refuse a buy/sell count ratio this lopsided in either direction. */
  maxBuySellImbalance: positive,
  /** How long a passing assessment may be reused before it is recomputed. */
  cacheTtlSec: z.number().int().min(0),
  /** With no security provider reachable, refuse to trade rather than guess. */
  failClosed: z.boolean(),
});

export type SecurityConfig = z.infer<typeof securityConfigSchema>;

const baseAgentSchema = z.object({
  enabled: z.boolean(),
  intervalSec: z.number().int().min(10),
  minScore: score,
  minConfidence: fraction,
  weights: scoringWeightsSchema,
  /** Largest notional this agent may request for one trade. */
  maxTradeUsd: positive,
  maxOpenPositions: z.number().int().min(0),
});

export const copyTradeAgentSchema = baseAgentSchema.extend({
  followedWallets: z.array(
    z.object({
      address: z.string().min(32),
      label: z.string().default(''),
      enabled: z.boolean().default(true),
    }),
  ),
  minTraderScore: score,
  /** Ignore a copied trade smaller than this, it is noise. */
  minTradeUsdToCopy: nonNegative,
  /** Refuse to copy a trade older than this; the price has moved on. */
  maxTradeAgeSec: z.number().int().min(10),
  /** Copy at most this fraction of the leader's own position size. */
  copyRatio: z.number().min(0).max(10),
  /** Close a copied position when the leader sells out of it. */
  mirrorExits: z.boolean(),
});

export const hiddenGemAgentSchema = baseAgentSchema.extend({
  minMarketCapUsd: nonNegative,
  maxMarketCapUsd: positive,
  minLiquidityUsd: nonNegative,
  minVolume24hUsd: nonNegative,
  minTokenAgeHours: nonNegative,
  maxTokenAgeDays: positive,
  minHolderCount: z.number().int().min(0),
  minVolumeGrowthPct: z.number(),
});

export const hotTradeAgentSchema = baseAgentSchema.extend({
  /**
   * Mints scanned every cycle regardless of what discovery turned up, so an
   * established token is never missed just because it did not rank into that
   * sweep. Defaulted rather than required: a config stored before this field
   * existed must still validate, or ConfigService.load would fall all the way
   * back to defaults and wipe the user's settings.
   */
  watchlist: z.array(z.string().min(32)).default([]),
  /**
   * A gentler screen for watchlist tokens only.
   *
   * The main thresholds are tuned against discovery, which is mostly unknown
   * tokens where a volume spike and a sharp move are the evidence that
   * something is happening at all. An established token with deep liquidity
   * and a known mint needs different evidence: it will never spike 2.5x its
   * own baseline, and holding it to that bar means the watchlist is scanned
   * every cycle and refused every cycle.
   *
   * This does not weaken the security, scoring or risk gates — only the
   * structural pre-filter, and only for mints the operator listed by hand.
   */
  watchlistScreen: z
    .object({
      enabled: z.boolean(),
      minLiquidityUsd: nonNegative,
      minVolume1hUsd: nonNegative,
      minVolumeSpikeMultiple: positive,
      minPriceChange1hPct: z.number(),
      maxPriceChange1hPct: z.number(),
      maxChaseGainPct: z.number(),
      minBuySellRatio: positive,
    })
    .default({
      enabled: true,
      minLiquidityUsd: 20_000,
      minVolume1hUsd: 3_000,
      // 1.0 is "no spike required", which is the point for a blue chip.
      minVolumeSpikeMultiple: 1,
      // Still has to be going up: this agent buys momentum, and a major
      // drifting down is not a setup just because it is a major.
      minPriceChange1hPct: 0.3,
      maxPriceChange1hPct: 40,
      maxChaseGainPct: 25,
      minBuySellRatio: 1,
    }),
  minLiquidityUsd: nonNegative,
  minVolume1hUsd: nonNegative,
  /** A volume spike this far above the token's own baseline counts as unusual. */
  minVolumeSpikeMultiple: positive,
  minPriceChange1hPct: z.number(),
  maxPriceChange1hPct: z.number(),
  /** Refuse to chase a token that has already run this far in an hour. */
  maxChaseGainPct: z.number(),
  minBuySellRatio: positive,
});

export const smallCapAgentSchema = baseAgentSchema.extend({
  minMarketCapUsd: nonNegative,
  maxMarketCapUsd: positive,
  minLiquidityUsd: nonNegative,
  minVolume24hUsd: nonNegative,
  maxWalletConcentrationPct: pct,
  minTokenAgeHours: nonNegative,
  /** Small caps carry more risk, so they get their own higher security floor. */
  minSecurityScore: score,
});

export const socialAgentSchema = z.object({
  enabled: z.boolean(),
  intervalSec: z.number().int().min(30),
  /** Ignore a token discussed fewer times than this; the sample is too thin. */
  minMentions24h: z.number().int().min(0),
  /** A mention count this many times its own baseline is a spike. */
  spikeMultiple: positive,
  /** Above this share of spam-looking posts the social score is discarded. */
  maxSpamRatio: fraction,
  /** How long a social snapshot may be reused. */
  cacheTtlSec: z.number().int().min(0),
  sources: z.array(z.string()),
});

export const executionConfigSchema = z.object({
  /** Fee charged by the venue, in basis points. Used by the paper executor. */
  takerFeeBps: z.number().int().min(0).max(1_000),
  /** Flat network cost per transaction in USD. Used by the paper executor. */
  networkFeeUsd: nonNegative,
  /** Slippage the paper executor applies at the pool sizes it sees. */
  paperBaseSlippageBps: z.number().int().min(0).max(2_000),
  /** Extra paper slippage per percent of the pool a trade consumes. */
  paperImpactBpsPerPoolPct: nonNegative,
  /** Share of live transactions to retry once on a recoverable failure. */
  liveMaxRetries: z.number().int().min(0).max(5),
  /** How long to wait for a live transaction to confirm before calling it failed. */
  liveConfirmTimeoutSec: z.number().int().min(5).max(300),
  /** Quote token used for pricing and for live swaps. */
  quoteMint: z.string().min(32),
});

export const portfolioConfigSchema = z.object({
  /** Starting equity for paper mode, in USD. */
  paperStartingBalanceUsd: positive,
  allocations: bucketAllocationSchema,
  /** Keep this share of each bucket in cash so exits are never blocked. */
  cashBufferPct: pct,
  /** Mark positions to market on this cadence. */
  markToMarketSec: z.number().int().min(10),
});

export const tradingConfigSchema = z
  .object({
    version: z.number().int().min(1),
    mode: z.enum(['paper', 'live']),
    portfolio: portfolioConfigSchema,
    risk: riskLimitsSchema,
    security: securityConfigSchema,
    execution: executionConfigSchema,
    agents: z.object({
      copy_trade: copyTradeAgentSchema,
      hidden_gem: hiddenGemAgentSchema,
      hot_trade: hotTradeAgentSchema,
      small_market_cap: smallCapAgentSchema,
      social: socialAgentSchema,
    }),
    lists: z.object({
      blacklist: z.array(z.string()),
      whitelist: z.array(z.string()),
    }),
    discovery: z.object({
      /** Token pairs pulled per discovery sweep. */
      maxTokensPerScan: z.number().int().min(1).max(500),
      /** Search terms handed to the market provider to find candidates. */
      searchTerms: z.array(z.string()),
      /** Skip any pair below this liquidity before it reaches an agent. */
      minLiquidityUsd: nonNegative,
    }),
  })
  .superRefine((cfg, ctx) => {
    const total = BUCKETS.reduce((acc, b) => acc + cfg.portfolio.allocations[b], 0);
    // Allocations are user-entered percentages, so allow a cent of float slop.
    if (Math.abs(total - 100) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['portfolio', 'allocations'],
        message: `Bucket allocations must total 100%, got ${total.toFixed(2)}%`,
      });
    }
    for (const [agent, cfgAgent] of Object.entries(cfg.agents)) {
      if (!('weights' in cfgAgent)) continue;
      const weights = cfgAgent.weights as ScoringWeights;
      const wsum = Object.values(weights).reduce((a, b) => a + b, 0);
      if (Math.abs(wsum - 1) > 0.001) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agents', agent, 'weights'],
          message: `Scoring weights must total 1.0, got ${wsum.toFixed(3)}`,
        });
      }
    }
    if (cfg.risk.minPositionUsd > cfg.risk.maxPositionUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['risk', 'minPositionUsd'],
        message: 'minPositionUsd cannot exceed maxPositionUsd',
      });
    }
  });

export type TradingConfig = z.infer<typeof tradingConfigSchema>;
export type AgentKey = keyof TradingConfig['agents'];

export const AGENT_KEYS = AGENTS.filter((a) => a !== 'security') as AgentKey[];
