import { describe, expect, it } from 'vitest';
import { computeTraderStats, scoreTrader } from '../src/agents/copy-trade/trader-scoring.js';
import type { WalletTrade } from '../src/core/types.js';
import { TEST_NOW } from './helpers.js';

let seq = 0;
function trade(
  side: 'buy' | 'sell',
  price: number,
  qty: number,
  offsetMinutes: number,
  token = 'TokA',
): WalletTrade {
  seq += 1;
  return {
    signature: `sig${seq}`,
    wallet: 'W1',
    tokenAddress: token,
    side,
    amountTokens: qty,
    amountUsd: price * qty,
    priceUsd: price,
    timestamp: TEST_NOW + offsetMinutes * 60_000,
  };
}

describe('trader statistics', () => {
  it('pairs buys with later sells to compute realised returns', () => {
    const stats = computeTraderStats([
      trade('buy', 1, 100, 0),
      trade('sell', 2, 100, 60),
      trade('buy', 1, 100, 120),
      trade('sell', 0.5, 100, 180),
    ]);
    expect(stats.closedCount).toBe(2);
    expect(stats.winRate).toBe(0.5);
    // +100% and -50% average to +25%.
    expect(stats.avgReturnPct).toBeCloseTo(25, 5);
  });

  it('ignores positions that are still open', () => {
    const stats = computeTraderStats([trade('buy', 1, 100, 0), trade('buy', 1, 50, 30)]);
    expect(stats.closedCount).toBe(0);
    expect(stats.winRate).toBeNull();
  });

  it('measures drawdown across the sequence of results', () => {
    const stats = computeTraderStats([
      trade('buy', 1, 10, 0), trade('sell', 2, 10, 10),
      trade('buy', 1, 10, 20), trade('sell', 0.2, 10, 30),
    ]);
    expect(stats.maxDrawdownPct).toBeGreaterThan(50);
  });

  it('spots a bot by the regularity of its timing', () => {
    const trades: WalletTrade[] = [];
    // Perfectly even ten-minute spacing and identical holds.
    for (let i = 0; i < 12; i += 1) {
      trades.push(trade('buy', 1, 10, i * 20, `Tok${i}`));
      trades.push(trade('sell', 1.1, 10, i * 20 + 10, `Tok${i}`));
    }
    const stats = computeTraderStats(trades);
    expect(stats.automationLikelihood).toBeGreaterThan(0.6);
  });

  it('does not call an irregular human a bot', () => {
    const trades: WalletTrade[] = [];
    const gaps = [7, 340, 22, 1_900, 65, 480, 15, 2_600, 130, 45, 900, 38];
    let at = 0;
    gaps.forEach((gap, i) => {
      at += gap;
      trades.push(trade('buy', 1, 10, at, `Tok${i}`));
      at += gap * (0.3 + i * 0.17);
      trades.push(trade('sell', 1.2, 10, at, `Tok${i}`));
    });
    const stats = computeTraderStats(trades);
    expect(stats.automationLikelihood).toBeLessThan(0.6);
  });
});

describe('trader scoring', () => {
  it('pulls an unproven wallet toward neutral instead of trusting a lucky streak', () => {
    const lucky = scoreTrader('W1', [
      trade('buy', 1, 10, 0), trade('sell', 5, 10, 10),
      trade('buy', 1, 10, 20), trade('sell', 6, 10, 30),
    ], { now: TEST_NOW });
    expect(lucky.overall).toBeLessThan(75);
    expect(lucky.flags.some((f) => f.code === 'INSUFFICIENT_HISTORY')).toBe(true);
  });

  it('scores a long consistent winner highly', () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 15; i += 1) {
      trades.push(trade('buy', 1, 10, i * 500 + (i % 4) * 37, `Tok${i}`));
      trades.push(trade('sell', i % 5 === 0 ? 0.94 : 1.18, 10, i * 500 + 200 + (i % 3) * 61, `Tok${i}`));
    }
    const score = scoreTrader('W1', trades, { now: TEST_NOW });
    expect(score.overall).toBeGreaterThan(60);
    expect(score.winRate).toBeGreaterThan(0.7);
  });

  it('penalises a wallet whose holds are too short to copy', () => {
    const trades: WalletTrade[] = [];
    for (let i = 0; i < 12; i += 1) {
      trades.push(trade('buy', 1, 10, i * 5, `Tok${i}`));
      // Held for well under a minute.
      trades.push(trade('sell', 1.05, 10, i * 5 + 0.5, `Tok${i}`));
    }
    const score = scoreTrader('W1', trades, { now: TEST_NOW });
    expect(score.flags.some((f) => f.code === 'HOLD_TOO_SHORT_TO_COPY')).toBe(true);
  });

  it('always explains itself', () => {
    const score = scoreTrader('W1', [trade('buy', 1, 10, 0), trade('sell', 1.5, 10, 60)], { now: TEST_NOW });
    expect(score.reason).toMatch(/completed trades/);
  });

  it('handles a wallet with no trades at all', () => {
    const score = scoreTrader('W1', [], { now: TEST_NOW });
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.reason).toContain('No completed trades');
  });
});
