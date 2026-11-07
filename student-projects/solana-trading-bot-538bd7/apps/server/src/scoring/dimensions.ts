import type { ScoringWeights } from '../config/schema.js';
import { curveScore, pctChange, sum } from '../core/money.js';
import type {
  ScoreComponent,
  SecurityAssessment,
  SocialSnapshot,
  TokenMarketSnapshot,
  TokenOnChainInfo,
  TraderScore,
} from '../core/types.js';

/**
 * The scoring dimensions.
 *
 * Every dimension is a pure function returning a 0..100 score plus the reason
 * it landed there. That reason is not decoration: it is what the decision log
 * shows when someone asks why a trade happened, so it has to name the actual
 * numbers.
 *
 * `hasData: false` means the input was missing and a neutral 50 was used. The
 * engine tracks how much of the weighted score came from real data, and the
 * agents refuse to trade on a score that is mostly guesswork.
 */

export interface DimensionInput {
  market: TokenMarketSnapshot | null;
  onChain: TokenOnChainInfo | null;
  social: SocialSnapshot | null;
  security: SecurityAssessment | null;
  trader: TraderScore | null;
  /** Previous snapshots of the same token, newest first, for growth measures. */
  history: TokenMarketSnapshot[];
  /** Swap counts by wallets the system rates highly, over the last day. */
  smartMoneyBuys?: number;
  smartMoneySells?: number;
  now: number;
}

export type DimensionKey = keyof ScoringWeights;

export type Dimension = (input: DimensionInput) => Omit<ScoreComponent, 'weight' | 'key'>;

/** The shape returned when a dimension has nothing to work with. */
function noData(label: string, what: string): Omit<ScoreComponent, 'weight' | 'key'> {
  return {
    label,
    score: 50,
    reason: `No ${what} available, scored neutral.`,
    positives: [],
    risks: [],
    hasData: false,
  };
}

export const securityDimension: Dimension = ({ security }) => {
  if (!security) return noData('Security', 'security assessment');
  const positives: string[] = [];
  const risks: string[] = [];
  if (security.score >= 85) positives.push('Contract checks came back clean');
  for (const flag of security.flags.slice(0, 4)) {
    if (flag.severity === 'info') continue;
    risks.push(flag.message);
  }
  return {
    label: 'Security',
    score: security.score,
    reason:
      security.flags.length === 0
        ? 'Every contract and liquidity check passed.'
        : `${security.flags.length} security ${security.flags.length === 1 ? 'flag' : 'flags'} raised, worst is ${security.flags[0]?.severity}.`,
    positives,
    risks,
    hasData: !security.degraded,
  };
};

export const liquidityDimension: Dimension = ({ market }) => {
  if (!market) return noData('Liquidity', 'market data');
  const usd = market.liquidityUsd;
  // Below $10k a modest position moves the price against itself; past $1M the
  // extra depth stops mattering for the sizes this bot trades.
  const score = curveScore(usd, [
    [0, 0],
    [10_000, 20],
    [50_000, 55],
    [150_000, 75],
    [500_000, 90],
    [1_000_000, 100],
  ]);
  const positives: string[] = [];
  const risks: string[] = [];
  if (usd >= 250_000) positives.push(`Deep pool at $${Math.round(usd).toLocaleString()}`);
  if (usd < 30_000) risks.push(`Thin pool at $${Math.round(usd).toLocaleString()}, exits will cost slippage`);
  return {
    label: 'Liquidity',
    score,
    reason: `Pool holds $${Math.round(usd).toLocaleString()}.`,
    positives,
    risks,
    hasData: true,
  };
};

export const momentumDimension: Dimension = ({ market }) => {
  if (!market) return noData('Momentum', 'market data');
  const h1 = market.priceChange1h;
  const h6 = market.priceChange6h;
  const h24 = market.priceChange24h;
  if (h1 == null && h6 == null && h24 == null) return noData('Momentum', 'price history');

  // Reward a steady climb, punish a parabolic spike. A token already up 200%
  // in an hour is where a buyer becomes the exit liquidity.
  const shortScore = curveScore(h1 ?? 0, [
    [-40, 5],
    [-10, 30],
    [0, 45],
    [5, 70],
    [20, 88],
    [60, 75],
    [120, 40],
    [300, 10],
  ]);
  const mediumScore = curveScore(h6 ?? h24 ?? 0, [
    [-50, 5],
    [-15, 30],
    [0, 50],
    [15, 78],
    [60, 88],
    [200, 55],
    [500, 20],
  ]);
  const score = shortScore * 0.6 + mediumScore * 0.4;

  const positives: string[] = [];
  const risks: string[] = [];
  if ((h1 ?? 0) > 5 && (h6 ?? 0) > 0) positives.push(`Up ${(h1 ?? 0).toFixed(1)}% in the last hour`);
  if ((h1 ?? 0) > 100) risks.push(`Already up ${(h1 ?? 0).toFixed(0)}% in an hour, late entry risk`);
  if ((h1 ?? 0) < -15) risks.push(`Down ${Math.abs(h1 ?? 0).toFixed(1)}% in the last hour`);

  return {
    label: 'Momentum',
    score,
    reason: `1h ${fmtPct(h1)}, 6h ${fmtPct(h6)}, 24h ${fmtPct(h24)}.`,
    positives,
    risks,
    hasData: true,
  };
};

export const volumeDimension: Dimension = ({ market, history }) => {
  if (!market) return noData('Volume', 'market data');
  const vol24 = market.volume24hUsd;
  const absolute = curveScore(vol24, [
    [0, 0],
    [10_000, 25],
    [100_000, 55],
    [500_000, 75],
    [2_000_000, 90],
    [10_000_000, 100],
  ]);

  // Growth against this token's own recent baseline, which is a far better
  // read than an absolute number that only says "this token is popular".
  const baseline = history.length > 0 ? median(history.map((h) => h.volume24hUsd)) : null;
  const growth = baseline && baseline > 0 ? pctChange(baseline, vol24) : null;
  const growthScore = growth == null ? 50 : curveScore(growth, [
    [-70, 10],
    [-20, 35],
    [0, 50],
    [50, 72],
    [200, 90],
    [800, 95],
  ]);

  const score = growth == null ? absolute : absolute * 0.55 + growthScore * 0.45;
  const positives: string[] = [];
  const risks: string[] = [];
  if (growth != null && growth > 100) positives.push(`Volume up ${growth.toFixed(0)}% against its own baseline`);
  if (vol24 >= 1_000_000) positives.push(`$${Math.round(vol24).toLocaleString()} traded in 24h`);
  if (vol24 < 20_000) risks.push('Very little real trading activity');

  return {
    label: 'Volume',
    score,
    reason:
      growth == null
        ? `$${Math.round(vol24).toLocaleString()} traded in 24h.`
        : `$${Math.round(vol24).toLocaleString()} in 24h, ${growth >= 0 ? 'up' : 'down'} ${Math.abs(growth).toFixed(0)}% on its baseline.`,
    positives,
    risks,
    hasData: true,
  };
};

export const smartMoneyDimension: Dimension = ({ smartMoneyBuys, smartMoneySells }) => {
  if (smartMoneyBuys == null && smartMoneySells == null) {
    return noData('Smart Money', 'tracked-wallet activity');
  }
  const buys = smartMoneyBuys ?? 0;
  const sells = smartMoneySells ?? 0;
  if (buys + sells === 0) {
    return {
      label: 'Smart Money',
      score: 45,
      reason: 'No wallets we track have touched this token.',
      positives: [],
      risks: [],
      // We did look, so this counts as real data; it is just a quiet answer.
      hasData: true,
    };
  }
  const net = buys - sells;
  const score = curveScore(net, [
    [-5, 5],
    [-2, 22],
    [0, 45],
    [1, 62],
    [3, 80],
    [6, 92],
    [12, 100],
  ]);
  const positives: string[] = [];
  const risks: string[] = [];
  if (net >= 2) positives.push(`${buys} tracked ${buys === 1 ? 'wallet has' : 'wallets have'} bought in`);
  if (net <= -2) risks.push(`${sells} tracked wallets are selling out`);
  return {
    label: 'Smart Money',
    score,
    reason: `Tracked wallets: ${buys} buying, ${sells} selling.`,
    positives,
    risks,
    hasData: true,
  };
};

export const holderGrowthDimension: Dimension = ({ market, onChain, history }) => {
  const holders = onChain?.holderCount ?? null;
  // Transaction counts are the best free proxy for holder growth when a
  // holder-count provider is not wired in.
  const txNow = market ? (market.buys24h ?? 0) + (market.sells24h ?? 0) : null;
  const txBefore =
    history.length > 0
      ? median(history.map((h) => (h.buys24h ?? 0) + (h.sells24h ?? 0)).filter((n) => n > 0))
      : null;

  if (holders == null && txNow == null) return noData('Holder Growth', 'holder data');

  const positives: string[] = [];
  const risks: string[] = [];
  let score = 50;
  let reason = '';

  if (holders != null) {
    score = curveScore(holders, [
      [0, 5],
      [100, 30],
      [500, 55],
      [2_000, 75],
      [10_000, 90],
      [50_000, 100],
    ]);
    reason = `${holders.toLocaleString()} holders.`;
    if (holders < 150) risks.push(`Only ${holders} holders`);
    if (holders > 5_000) positives.push(`${holders.toLocaleString()} holders`);
  }

  if (txNow != null && txBefore != null && txBefore > 0) {
    const growth = pctChange(txBefore, txNow) ?? 0;
    const growthScore = curveScore(growth, [
      [-60, 15],
      [-20, 38],
      [0, 50],
      [40, 70],
      [150, 88],
      [500, 95],
    ]);
    score = holders != null ? score * 0.5 + growthScore * 0.5 : growthScore;
    reason = `${reason} Transactions ${growth >= 0 ? 'up' : 'down'} ${Math.abs(growth).toFixed(0)}% on baseline.`.trim();
    if (growth > 80) positives.push(`Transaction count up ${growth.toFixed(0)}%`);
  } else if (holders == null && txNow != null) {
    score = curveScore(txNow, [
      [0, 5],
      [50, 30],
      [500, 60],
      [3_000, 85],
      [20_000, 100],
    ]);
    reason = `${txNow.toLocaleString()} transactions in 24h.`;
  }

  return { label: 'Holder Growth', score, reason, positives, risks, hasData: true };
};

export const socialDimension: Dimension = ({ social }) => {
  if (!social || social.mentions24h == null) return noData('Social', 'social data');
  const mentions = social.mentions24h;
  const base = curveScore(mentions, [
    [0, 5],
    [10, 25],
    [100, 55],
    [1_000, 78],
    [10_000, 92],
    [100_000, 100],
  ]);

  // Loud is not the same as good. A high spam ratio pulls the score back
  // toward neutral rather than letting bought hype read as demand.
  const spam = social.spamRatio ?? 0;
  const quality = social.sourceQuality ?? 0.6;
  const score = base * (1 - spam * 0.6) * (0.6 + quality * 0.4);

  const positives: string[] = [];
  const risks: string[] = [];
  if (mentions > 500) positives.push(`${mentions.toLocaleString()} mentions in 24h`);
  if (spam > 0.4) risks.push(`${(spam * 100).toFixed(0)}% of posts look automated`);
  if (mentions < 20) risks.push('Almost nobody is discussing this token');

  return {
    label: 'Social',
    score,
    reason: `${mentions.toLocaleString()} mentions in 24h from ${social.sources.join(', ') || 'unknown sources'}.`,
    positives,
    risks,
    hasData: true,
  };
};

export const sentimentDimension: Dimension = ({ social }) => {
  if (!social || social.sentiment == null) return noData('Sentiment', 'sentiment data');
  const s = social.sentiment; // -1 .. 1
  const score = curveScore(s, [
    [-1, 5],
    [-0.4, 28],
    [0, 50],
    [0.3, 72],
    [0.7, 88],
    [1, 96],
  ]);
  const positives: string[] = [];
  const risks: string[] = [];
  if (s > 0.4) positives.push('Discussion is clearly positive');
  if (s < -0.2) risks.push('Discussion is turning negative');
  return {
    label: 'Sentiment',
    score,
    reason: `Sentiment reads ${s >= 0 ? '+' : ''}${(s * 100).toFixed(0)} on a -100 to +100 scale.`,
    positives,
    risks,
    hasData: true,
  };
};

export const marketCapDimension: Dimension = ({ market }) => {
  const mc = market?.marketCapUsd ?? market?.fdvUsd ?? null;
  if (mc == null || mc <= 0) return noData('Market Cap', 'market cap data');
  // The sweet spot for this bot is a few hundred thousand to a few tens of
  // millions: big enough to be real, small enough to still move.
  const score = curveScore(mc, [
    [0, 10],
    [50_000, 40],
    [500_000, 80],
    [5_000_000, 95],
    [50_000_000, 70],
    [500_000_000, 40],
    [5_000_000_000, 20],
  ]);
  const positives: string[] = [];
  const risks: string[] = [];
  if (mc < 100_000) risks.push(`Market cap of $${Math.round(mc).toLocaleString()} is tiny`);
  if (mc >= 500_000 && mc <= 20_000_000) positives.push('Market cap is in the range where moves are still possible');
  return {
    label: 'Market Cap',
    score,
    reason: `Market cap around $${Math.round(mc).toLocaleString()}.`,
    positives,
    risks,
    hasData: true,
  };
};

export const traderDimension: Dimension = ({ trader }) => {
  if (!trader) return noData('Trader', 'trader score');
  const positives: string[] = [];
  const risks: string[] = [];
  if ((trader.winRate ?? 0) > 0.6) positives.push(`Leader wins ${((trader.winRate ?? 0) * 100).toFixed(0)}% of trades`);
  if ((trader.automationLikelihood ?? 0) > 0.7) risks.push('Leader wallet looks automated');
  for (const flag of trader.flags.slice(0, 2)) risks.push(flag.message);
  return {
    label: 'Trader',
    score: trader.overall,
    reason: trader.reason,
    positives,
    risks,
    hasData: true,
  };
};

export const DIMENSIONS: Record<DimensionKey, Dimension> = {
  security: securityDimension,
  liquidity: liquidityDimension,
  momentum: momentumDimension,
  volume: volumeDimension,
  smartMoney: smartMoneyDimension,
  holderGrowth: holderGrowthDimension,
  social: socialDimension,
  sentiment: sentimentDimension,
  marketCap: marketCapDimension,
  trader: traderDimension,
};

function fmtPct(value: number | null): string {
  if (value == null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid]! : ((clean[mid - 1]! + clean[mid]!) / 2);
}

export { median, sum };
