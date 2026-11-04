import { clamp, curveScore, normaliseScore } from '../../core/money.js';
import type { RiskFlag, TraderScore, WalletTrade } from '../../core/types.js';

/**
 * Trader scoring.
 *
 * Turns a wallet's observed trade history into a rating, and just as
 * importantly into a set of reasons not to trust it.
 *
 * The whole function is pure: given the same trades it gives the same score,
 * which is what makes the copy-trade decisions reproducible and testable.
 */

export interface TraderStats {
  tradeCount: number;
  closedCount: number;
  winRate: number | null;
  avgReturnPct: number | null;
  maxDrawdownPct: number | null;
  consistency: number | null;
  automationLikelihood: number | null;
  medianHoldMinutes: number | null;
  totalVolumeUsd: number;
}

/**
 * Pair buys with later sells of the same token, FIFO, to get realised returns.
 * Anything still open at the end is ignored rather than marked to market: an
 * open position is not yet a result.
 */
export function computeTraderStats(trades: WalletTrade[]): TraderStats {
  const ordered = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const lots = new Map<string, Array<{ qty: number; price: number; at: number }>>();
  const returns: number[] = [];
  const holdMinutes: number[] = [];
  const gaps: number[] = [];
  let totalVolumeUsd = 0;
  let lastAt: number | null = null;

  for (const trade of ordered) {
    totalVolumeUsd += trade.amountUsd;
    if (lastAt !== null) gaps.push(trade.timestamp - lastAt);
    lastAt = trade.timestamp;

    const price = trade.priceUsd ?? (trade.amountTokens > 0 ? trade.amountUsd / trade.amountTokens : 0);
    if (price <= 0 || trade.amountTokens <= 0) continue;

    const queue = lots.get(trade.tokenAddress) ?? [];
    if (trade.side === 'buy') {
      queue.push({ qty: trade.amountTokens, price, at: trade.timestamp });
      lots.set(trade.tokenAddress, queue);
      continue;
    }

    let remaining = trade.amountTokens;
    while (remaining > 0 && queue.length > 0) {
      const lot = queue[0]!;
      const matched = Math.min(remaining, lot.qty);
      returns.push(((price - lot.price) / lot.price) * 100);
      holdMinutes.push((trade.timestamp - lot.at) / 60_000);
      lot.qty -= matched;
      remaining -= matched;
      if (lot.qty <= 1e-12) queue.shift();
    }
    lots.set(trade.tokenAddress, queue);
  }

  const closedCount = returns.length;
  const winRate = closedCount > 0 ? returns.filter((r) => r > 0).length / closedCount : null;
  const avgReturnPct = closedCount > 0 ? returns.reduce((a, b) => a + b, 0) / closedCount : null;

  // Drawdown across the equity curve implied by sequential returns.
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity *= 1 + r / 100;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }
  const maxDrawdownPct = closedCount > 0 ? maxDrawdown * 100 : null;

  // Consistency: how tightly the returns cluster. A wallet that makes steady
  // small gains is worth more to copy than one carried by a single lottery win.
  let consistency: number | null = null;
  if (closedCount >= 3 && avgReturnPct !== null) {
    const variance =
      returns.reduce((acc, r) => acc + (r - avgReturnPct) ** 2, 0) / closedCount;
    const stdDev = Math.sqrt(variance);
    consistency = clamp(1 - stdDev / (Math.abs(avgReturnPct) + stdDev + 1e-9), 0, 1);
  }

  return {
    tradeCount: ordered.length,
    closedCount,
    winRate,
    avgReturnPct,
    maxDrawdownPct,
    consistency,
    automationLikelihood: automationScore(gaps, holdMinutes),
    medianHoldMinutes: medianOf(holdMinutes),
    totalVolumeUsd,
  };
}

/**
 * How machine-like the wallet looks.
 *
 * Two tells: gaps between trades that are suspiciously uniform, and holds that
 * are all the same length. Humans are irregular; bots are not. This is not
 * automatically disqualifying, but a bot's edge usually does not survive being
 * copied a block late, so it costs score.
 */
function automationScore(gaps: number[], holdMinutes: number[]): number | null {
  if (gaps.length < 5) return null;
  const gapRegularity = 1 - coefficientOfVariation(gaps);
  const holdRegularity = holdMinutes.length >= 5 ? 1 - coefficientOfVariation(holdMinutes) : 0;
  // Very fast repeated trading is the third tell.
  const fastFraction = gaps.filter((g) => g < 30_000).length / gaps.length;
  return clamp(gapRegularity * 0.45 + holdRegularity * 0.25 + fastFraction * 0.3, 0, 1);
}

function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return clamp(Math.sqrt(variance) / Math.abs(mean), 0, 1);
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface TraderScoringOptions {
  /** Below this many closed trades the record is treated as unproven. */
  minClosedTrades?: number;
  now: number;
}

export function scoreTrader(
  wallet: string,
  trades: WalletTrade[],
  options: TraderScoringOptions,
): TraderScore {
  const stats = computeTraderStats(trades);
  const minClosed = options.minClosedTrades ?? 8;
  const flags: RiskFlag[] = [];

  // Too small a sample is not a bad trader, it is an unknown one, and an
  // unknown one is not worth following with real money.
  if (stats.closedCount < minClosed) {
    flags.push({
      code: 'INSUFFICIENT_HISTORY',
      severity: 'medium',
      message: `Only ${stats.closedCount} completed trades observed, too few to judge.`,
      evidence: { closedCount: stats.closedCount, required: minClosed },
    });
  }

  const winScore = stats.winRate == null ? 40 : curveScore(stats.winRate * 100, [
    [0, 0],
    [35, 20],
    [50, 45],
    [60, 68],
    [75, 88],
    [90, 96],
  ]);
  const returnScore = stats.avgReturnPct == null ? 40 : curveScore(stats.avgReturnPct, [
    [-50, 0],
    [-10, 20],
    [0, 42],
    [10, 68],
    [40, 88],
    [150, 96],
  ]);
  const drawdownScore = stats.maxDrawdownPct == null ? 45 : curveScore(stats.maxDrawdownPct, [
    [0, 100],
    [15, 85],
    [35, 60],
    [60, 30],
    [85, 8],
  ]);
  const consistencyScore = stats.consistency == null ? 45 : stats.consistency * 100;

  let overall =
    winScore * 0.3 + returnScore * 0.3 + drawdownScore * 0.2 + consistencyScore * 0.2;

  // An unproven wallet is pulled hard toward neutral rather than allowed to
  // post a high score off three lucky trades.
  if (stats.closedCount < minClosed) {
    const proven = stats.closedCount / minClosed;
    overall = 50 + (overall - 50) * proven;
  }

  if ((stats.automationLikelihood ?? 0) > 0.7) {
    flags.push({
      code: 'LIKELY_AUTOMATED',
      severity: 'medium',
      message: 'Trade timing is very regular, so this wallet is probably a bot.',
      evidence: { automationLikelihood: stats.automationLikelihood },
    });
    // A bot's edge is usually latency, which a copier cannot have.
    overall *= 0.85;
  }

  if ((stats.medianHoldMinutes ?? Number.POSITIVE_INFINITY) < 2) {
    flags.push({
      code: 'HOLD_TOO_SHORT_TO_COPY',
      severity: 'high',
      message: 'Positions are held for under two minutes, far too fast to copy safely.',
      evidence: { medianHoldMinutes: stats.medianHoldMinutes },
    });
    overall *= 0.6;
  }

  if ((stats.maxDrawdownPct ?? 0) > 70) {
    flags.push({
      code: 'SEVERE_DRAWDOWN',
      severity: 'high',
      message: `This wallet has been down ${stats.maxDrawdownPct?.toFixed(0)}% from its peak.`,
    });
  }

  const reason = stats.closedCount === 0
    ? 'No completed trades observed for this wallet yet.'
    : `${stats.closedCount} completed trades, ${((stats.winRate ?? 0) * 100).toFixed(0)}% win rate, ` +
      `${(stats.avgReturnPct ?? 0) >= 0 ? '+' : ''}${(stats.avgReturnPct ?? 0).toFixed(1)}% average return, ` +
      `worst drawdown ${(stats.maxDrawdownPct ?? 0).toFixed(0)}%.`;

  return {
    wallet,
    overall: normaliseScore(overall),
    winRate: stats.winRate,
    avgReturnPct: stats.avgReturnPct,
    maxDrawdownPct: stats.maxDrawdownPct,
    consistency: stats.consistency,
    tradeCount: stats.tradeCount,
    automationLikelihood: stats.automationLikelihood,
    flags,
    reason,
    scoredAt: options.now,
  };
}
