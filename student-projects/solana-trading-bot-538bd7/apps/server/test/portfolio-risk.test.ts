import { describe, expect, it } from 'vitest';
import { TEST_NOW, makeMarket, makeOnChain, makeTestApp } from './helpers.js';
import { BUCKETS } from '../src/core/types.js';
import type { TradeSignal } from '../src/core/types.js';

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig_test_1',
    agent: 'hot_trade',
    bucket: 'hot_trading',
    chain: 'solana',
    tokenAddress: 'Tok1111111111111111111111111111111111111111',
    tokenSymbol: 'TEST',
    action: 'BUY',
    score: 80,
    confidence: 0.8,
    entryPriceUsd: 1,
    targetPriceUsd: 1.4,
    stopLossUsd: 0.85,
    requestedSizeUsd: 250,
    reason: 'test signal',
    riskFlags: [],
    metadata: {},
    createdAt: TEST_NOW,
    ...overrides,
  };
}

describe('portfolio buckets', () => {
  it('splits the starting balance across the four buckets by allocation', async () => {
    const app = makeTestApp();
    try {
      const state = app.portfolio.getState();
      expect(state.buckets).toHaveLength(4);
      // 10,000 at 30/30/25/15.
      expect(app.portfolio.getBucketCash('copy_trading')).toBeCloseTo(3_000, 2);
      expect(app.portfolio.getBucketCash('hot_trading')).toBeCloseTo(3_000, 2);
      expect(app.portfolio.getBucketCash('hidden_gems')).toBeCloseTo(2_500, 2);
      expect(app.portfolio.getBucketCash('low_market_cap')).toBeCloseTo(1_500, 2);
      expect(state.totalValueUsd).toBeCloseTo(10_000, 2);
    } finally {
      await app.shutdown();
    }
  });

  it('holds back the cash buffer from what is reported as spendable', async () => {
    const app = makeTestApp();
    try {
      // Default cashBufferPct is 10, so 10% of each bucket's cash is a real,
      // counted part of equity but not offered up as available to spend.
      const state = app.portfolio.getState();
      const copyTrading = state.buckets.find((b) => b.bucket === 'copy_trading')!;
      expect(copyTrading.availableUsd).toBeCloseTo(3_000, 2);
      expect(copyTrading.reservedUsd).toBeCloseTo(300, 2);
      expect(copyTrading.spendableUsd).toBeCloseTo(2_700, 2);

      expect(state.cashUsd).toBeCloseTo(10_000, 2);
      expect(state.reservedUsd).toBeCloseTo(1_000, 2);
      expect(state.spendableUsd).toBeCloseTo(9_000, 2);
      // The buffer never shrinks reported equity, only what looks spendable.
      expect(state.totalValueUsd).toBeCloseTo(10_000, 2);
    } finally {
      await app.shutdown();
    }
  });

  it('refuses an allocation set that does not total 100', async () => {
    const app = makeTestApp();
    try {
      expect(() =>
        app.portfolio.applyAllocations({
          copy_trading: 50, hot_trading: 30, hidden_gems: 25, low_market_cap: 15,
        }),
      ).toThrow(/must total 100/);
    } finally {
      await app.shutdown();
    }
  });

  it('redistributes uninvested cash when allocations change', async () => {
    const app = makeTestApp();
    try {
      app.portfolio.applyAllocations({
        copy_trading: 10, hot_trading: 10, hidden_gems: 40, low_market_cap: 40,
      });
      expect(app.portfolio.getBucketCash('hidden_gems')).toBeCloseTo(4_000, 2);
      expect(app.portfolio.getBucketCash('copy_trading')).toBeCloseTo(1_000, 2);
      // The total is conserved, not created.
      const total = BUCKETS.reduce((acc, b) => acc + app.portfolio.getBucketCash(b), 0);
      expect(total).toBeCloseTo(10_000, 2);
    } finally {
      await app.shutdown();
    }
  });

  it('refuses to let a bucket overdraw', async () => {
    const app = makeTestApp();
    try {
      expect(() => app.portfolio.adjustCash('hot_trading', -5_000)).toThrow(/cannot spend/);
      // The failed attempt left the balance untouched.
      expect(app.portfolio.getBucketCash('hot_trading')).toBeCloseTo(3_000, 2);
    } finally {
      await app.shutdown();
    }
  });
});

describe('risk manager', () => {
  it('rejects everything while the kill switch is engaged', async () => {
    const app = makeTestApp();
    try {
      app.config.setKillSwitch(true);
      const decision = app.risk.evaluate(makeSignal(), makeMarket());
      expect(decision.approved).toBe(false);
      expect(decision.stage).toBe('kill_switch');
    } finally {
      await app.shutdown();
    }
  });

  it('approves a reasonable trade and records why', async () => {
    const app = makeTestApp();
    try {
      const decision = app.risk.evaluate(makeSignal(), makeMarket());
      expect(decision.approved).toBe(true);
      expect(decision.approvedSizeUsd).toBeGreaterThan(0);
      expect(decision.checks.every((c) => c.passed)).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('shrinks an oversized request rather than refusing it', async () => {
    const app = makeTestApp();
    try {
      const decision = app.risk.evaluate(makeSignal({ requestedSizeUsd: 99_999 }), makeMarket());
      expect(decision.approved).toBe(true);
      // Capped by maxPositionUsd of 500.
      expect(decision.approvedSizeUsd).toBeLessThanOrEqual(500);
    } finally {
      await app.shutdown();
    }
  });

  it('caps a trade to a small share of the pool', async () => {
    const app = makeTestApp();
    try {
      // A $20k pool at 100bps allows $200.
      const decision = app.risk.evaluate(
        makeSignal({ requestedSizeUsd: 500 }),
        makeMarket({ liquidityUsd: 200_000 }),
      );
      const poolCheck = decision.checks.find((c) => c.code === 'MAX_POOL_SHARE');
      expect(poolCheck?.limit).toBeCloseTo(2_000, 0);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects a token below the liquidity floor', async () => {
    const app = makeTestApp();
    try {
      const decision = app.risk.evaluate(makeSignal(), makeMarket({ liquidityUsd: 500 }));
      expect(decision.approved).toBe(false);
      expect(decision.checks.find((c) => c.code === 'MIN_LIQUIDITY')?.passed).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects when no usable price exists', async () => {
    const app = makeTestApp();
    try {
      const decision = app.risk.evaluate(makeSignal(), makeMarket({ priceUsd: 0 }));
      expect(decision.approved).toBe(false);
      expect(decision.checks.find((c) => c.code === 'PRICE_AVAILABLE')?.passed).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('halts trading once the daily loss limit is breached', async () => {
    const app = makeTestApp();
    try {
      // Open the day at 10,000, then mark equity far lower.
      app.portfolio.snapshotDaily(app.portfolio.getState());
      app.portfolio.adjustCash('hot_trading', -2_500);
      app.portfolio.adjustCash('copy_trading', -2_500);
      const decision = app.risk.evaluate(makeSignal(), makeMarket());
      expect(decision.approved).toBe(false);
      expect(decision.checks.find((c) => c.code === 'MAX_DAILY_LOSS')?.passed).toBe(false);
    } finally {
      await app.shutdown();
    }
  });

  it('never blocks an exit', async () => {
    const app = makeTestApp();
    try {
      app.config.setKillSwitch(true);
      expect(app.risk.evaluateExit().approved).toBe(true);
    } finally {
      await app.shutdown();
    }
  });
});
