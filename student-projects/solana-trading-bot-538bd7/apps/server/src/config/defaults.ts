import type { ScoringWeights, TradingConfig } from './schema.js';

/** The house weights from the brief. Every agent starts here and may deviate. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  security: 0.25,
  liquidity: 0.15,
  momentum: 0.1,
  volume: 0.1,
  smartMoney: 0.1,
  holderGrowth: 0.1,
  social: 0.1,
  sentiment: 0.05,
  marketCap: 0.05,
  trader: 0,
};

/** Rebalance a weight map so it totals exactly 1. */
export function normaliseWeights(weights: ScoringWeights): ScoringWeights {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) return { ...DEFAULT_WEIGHTS };
  const out = {} as ScoringWeights;
  for (const [key, value] of Object.entries(weights) as Array<[keyof ScoringWeights, number]>) {
    out[key] = value / total;
  }
  return out;
}

function weights(overrides: Partial<ScoringWeights>): ScoringWeights {
  return normaliseWeights({ ...DEFAULT_WEIGHTS, ...overrides });
}

/** Wrapped SOL. The quote asset for pricing and for live swaps. */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Established Solana tokens the hot-trade agent watches every cycle.
 *
 * Every mint here was resolved against Jupiter's verified list rather than
 * typed from memory, because a symbol lookup is not safe on Solana: searching
 * "BONK" returns an unverified impostor with more liquidity than the real
 * token, and searching "WIF" does not return dogwifhat at all. A wrong mint
 * here would not error — it would quietly trade someone else's coin.
 *
 * WSOL is deliberately absent. It is the quote asset, so a buy would be a
 * swap from SOL into SOL; `HotTradeAgent` filters it out defensively too.
 */
export const SOLANA_MAJORS: ReadonlyArray<{ mint: string; symbol: string }> = [
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'JitoSOL' },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', symbol: 'JUP' },
  { mint: 'BNso1VUJnh4zcfpZa6986Ea66P6TCp59hvtNJ8b1X85', symbol: 'BNSOL' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF' },
  { mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof', symbol: 'RENDER' },
  { mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'POPCAT' },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE', symbol: 'ORCA' },
];

export const SOLANA_MAJOR_MINTS = SOLANA_MAJORS.map((t) => t.mint);

export const DEFAULT_CONFIG: TradingConfig = {
  version: 1,
  // Paper is the only safe default. Live needs an explicit config change AND
  // the environment confirmation phrase.
  mode: 'paper',
  portfolio: {
    paperStartingBalanceUsd: 10_000,
    allocations: {
      copy_trading: 30,
      hot_trading: 30,
      hidden_gems: 25,
      low_market_cap: 15,
    },
    cashBufferPct: 10,
    markToMarketSec: 60,
  },
  risk: {
    maxPositionPctOfBucket: 20,
    maxPositionUsd: 500,
    minPositionUsd: 10,
    maxBucketExposurePct: 80,
    maxTotalExposurePct: 70,
    maxDailyLossPct: 10,
    maxOpenPositions: 20,
    maxOpenPositionsPerBucket: 6,
    maxLossPerTradePct: 25,
    stopLossPct: 15,
    takeProfitPct: 40,
    trailingStopPct: 0,
    maxSlippageBps: 150,
    minLiquidityUsd: 25_000,
    maxPoolShareBps: 100,
    maxGasUsd: 1,
    maxTokenConcentrationPct: 15,
    duplicateTradeCooldownSec: 900,
    maxTradesPerAgentPerHour: 12,
    minSecurityScore: 60,
    killSwitch: false,
  },
  security: {
    rejectAtSeverity: 'high',
    minLiquidityUsd: 15_000,
    minTokenAgeMinutes: 30,
    maxTopHolderPct: 25,
    maxTop10HolderPct: 55,
    maxBuyTaxBps: 500,
    maxSellTaxBps: 500,
    minLpLockedFraction: 0,
    requireMintAuthorityRevoked: true,
    requireFreezeAuthorityRevoked: true,
    maxVolumeToLiquidityRatio: 40,
    maxBuySellImbalance: 12,
    cacheTtlSec: 600,
    // Live mode ignores this and always fails closed (see security-agent.ts).
    // Paper mode honours it, and defaults to false so an unreachable provider
    // degrades the score instead of silently rejecting every token.
    failClosed: false,
  },
  execution: {
    takerFeeBps: 30,
    networkFeeUsd: 0.02,
    paperBaseSlippageBps: 30,
    paperImpactBpsPerPoolPct: 60,
    liveMaxRetries: 1,
    liveConfirmTimeoutSec: 60,
    quoteMint: WSOL_MINT,
  },
  agents: {
    copy_trade: {
      enabled: true,
      // Fifteen minutes. Polling a wallet list harder than this burns the
      // provider's free tier without finding much: a leader's entry is still
      // worth copying minutes later, and maxTradeAgeSec is what actually
      // decides whether a trade is too stale to follow.
      intervalSec: 900,
      minScore: 65,
      minConfidence: 0.55,
      // A copy trade lives or dies on the leader's record, so the trader
      // dimension carries real weight here and momentum matters less.
      weights: weights({ trader: 0.25, security: 0.25, liquidity: 0.15, momentum: 0.05, social: 0.05 }),
      maxTradeUsd: 250,
      maxOpenPositions: 6,
      followedWallets: [],
      minTraderScore: 65,
      minTradeUsdToCopy: 250,
      maxTradeAgeSec: 300,
      copyRatio: 0.05,
      mirrorExits: true,
    },
    hidden_gem: {
      enabled: true,
      intervalSec: 900,
      minScore: 72,
      minConfidence: 0.6,
      weights: weights({ holderGrowth: 0.15, smartMoney: 0.15, social: 0.1, momentum: 0.05 }),
      maxTradeUsd: 200,
      maxOpenPositions: 6,
      minMarketCapUsd: 100_000,
      maxMarketCapUsd: 10_000_000,
      minLiquidityUsd: 40_000,
      minVolume24hUsd: 50_000,
      minTokenAgeHours: 12,
      maxTokenAgeDays: 120,
      minHolderCount: 300,
      minVolumeGrowthPct: 40,
    },
    hot_trade: {
      enabled: true,
      // Three minutes. The interval only starts a scan; it never implies a
      // trade, so tightening it raises how often the watchlist is re-checked
      // rather than how often anything is bought.
      intervalSec: 180,
      watchlist: SOLANA_MAJOR_MINTS,
      watchlistScreen: {
        enabled: true,
        minLiquidityUsd: 20_000,
        minVolume1hUsd: 3_000,
        minVolumeSpikeMultiple: 1,
        minPriceChange1hPct: 0.3,
        maxPriceChange1hPct: 40,
        maxChaseGainPct: 25,
        minBuySellRatio: 1,
      },
      minScore: 70,
      minConfidence: 0.6,
      weights: weights({ momentum: 0.2, volume: 0.18, liquidity: 0.15, holderGrowth: 0.02, marketCap: 0.02 }),
      maxTradeUsd: 250,
      maxOpenPositions: 6,
      minLiquidityUsd: 50_000,
      minVolume1hUsd: 25_000,
      minVolumeSpikeMultiple: 2.5,
      minPriceChange1hPct: 3,
      maxPriceChange1hPct: 120,
      maxChaseGainPct: 60,
      minBuySellRatio: 1.1,
    },
    small_market_cap: {
      enabled: true,
      intervalSec: 1_800,
      minScore: 75,
      minConfidence: 0.65,
      // Small caps die of thin liquidity and bad contracts far more often than
      // they die of weak momentum, so those two dimensions dominate.
      weights: weights({ security: 0.3, liquidity: 0.2, holderGrowth: 0.12, momentum: 0.05, marketCap: 0.08 }),
      maxTradeUsd: 100,
      maxOpenPositions: 4,
      minMarketCapUsd: 50_000,
      maxMarketCapUsd: 2_000_000,
      minLiquidityUsd: 30_000,
      minVolume24hUsd: 25_000,
      maxWalletConcentrationPct: 40,
      minTokenAgeHours: 24,
      minSecurityScore: 75,
    },
    social: {
      enabled: true,
      intervalSec: 900,
      minMentions24h: 25,
      spikeMultiple: 3,
      maxSpamRatio: 0.5,
      cacheTtlSec: 1_800,
      // LunarCrush layers on top of the news feed when LUNARCRUSH_API_KEY is
      // set; the news feed itself needs no key and is always active.
      sources: ['lunarcrush', 'news-feed'],
    },
  },
  lists: {
    blacklist: [],
    whitelist: [],
  },
  discovery: {
    maxTokensPerScan: 180,
    // Each term is a separate provider search, so this widens the funnel
    // rather than deepening one query. The majors are included by name so
    // discovery surfaces their pairs alongside the watchlist's direct lookup.
    searchTerms: [
      'SOL', 'USDC', 'USDT', 'BONK', 'WIF', 'JUP', 'RAY', 'ORCA', 'RENDER',
      'POPCAT', 'JitoSOL', 'BNSOL', 'PYTH', 'JTO', 'MEW', 'WEN',
    ],
    minLiquidityUsd: 20_000,
  },
};
