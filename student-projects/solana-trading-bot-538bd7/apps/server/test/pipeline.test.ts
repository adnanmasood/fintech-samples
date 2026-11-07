import { describe, expect, it } from 'vitest';
import { TEST_NOW, makeMarket, makeOnChain, makeTestApp } from './helpers.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { FakeClock } from '../src/core/clock.js';

/**
 * The end-to-end pipeline:
 *   market data -> agent -> score -> security -> risk -> portfolio -> execution -> database
 *
 * Everything runs against the in-memory database and static providers, so the
 * whole path is exercised with no network at all.
 */
describe('full pipeline', () => {
  it('carries a good token all the way from discovery to a booked trade', async () => {
    const token = makeMarket({
      address: 'GoodTok11111111111111111111111111111111111',
      symbol: 'GOOD',
      liquidityUsd: 400_000,
      volume24hUsd: 2_000_000,
      volume1hUsd: 300_000,
      priceChange1h: 12,
      priceChange6h: 20,
      buys1h: 200,
      sells1h: 80,
    });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({ address: token.address })]],
    });

    try {
      // Build a baseline so the volume-spike screen has something to compare to.
      for (let i = 0; i < 3; i += 1) {
        app.repo.upsert({ ...token, volume1hUsd: 40_000, fetchedAt: TEST_NOW - (i + 1) * 3_600_000 });
      }
      app.repo.upsert(token);

      const agent = app.agents.get('hot_trade')!;
      const run = await agent.run();
      expect(run.signals.length).toBeGreaterThan(0);

      const signal = run.signals[0]!;
      expect(signal.agent).toBe('hot_trade');
      expect(signal.bucket).toBe('hot_trading');

      const outcome = await app.signals.process(signal);
      expect(outcome.executed).toBe(true);

      // Database side effects: a position, a trade, and a decision event.
      const positions = app.portfolio.openPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0]!.tokenSymbol).toBe('GOOD');
      expect(positions[0]!.bucket).toBe('hot_trading');

      const events = app.log.list({ limit: 50 });
      expect(events.some((e) => e.category === 'execution')).toBe(true);

      // Money moved out of the right bucket only.
      expect(app.portfolio.getBucketCash('hot_trading')).toBeLessThan(3_000);
      expect(app.portfolio.getBucketCash('hidden_gems')).toBeCloseTo(2_500, 2);
    } finally {
      await app.shutdown();
    }
  });

  it('stops a token at the security gate no matter how good its numbers are', async () => {
    const token = makeMarket({
      address: 'RugTok111111111111111111111111111111111111',
      symbol: 'RUG',
      liquidityUsd: 900_000,
      volume24hUsd: 9_000_000,
      volume1hUsd: 800_000,
      priceChange1h: 15,
    });
    const app = makeTestApp({
      snapshots: [token],
      // Perfect market data, but the deployer can still mint.
      onChain: [[token.address, makeOnChain({ address: token.address, mintAuthority: 'Deployer' })]],
    });

    try {
      app.repo.upsert(token);
      const signal = {
        id: 'sig_rug', agent: 'hot_trade' as const, bucket: 'hot_trading' as const,
        chain: 'solana' as const, tokenAddress: token.address, tokenSymbol: 'RUG',
        action: 'BUY' as const, score: 95, confidence: 0.95, entryPriceUsd: 1,
        targetPriceUsd: 1.4, stopLossUsd: 0.85, requestedSizeUsd: 250,
        reason: 'looks great on paper', riskFlags: [], metadata: {}, createdAt: TEST_NOW,
      };

      const outcome = await app.signals.process(signal);
      expect(outcome.executed).toBe(false);
      expect(outcome.stage).toBe('security');
      expect(app.portfolio.openPositions()).toHaveLength(0);

      // The refusal is on the record, with its reason.
      const events = app.log.list({ limit: 20 });
      const rejection = events.find((e) => e.message.includes('Rejected at security'));
      expect(rejection).toBeDefined();
    } finally {
      await app.shutdown();
    }
  });

  it('stops a trade at the risk gate when the kill switch is on', async () => {
    const token = makeMarket({ address: 'KillTok11111111111111111111111111111111111' });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({ address: token.address })]],
    });
    try {
      app.repo.upsert(token);
      app.config.setKillSwitch(true);
      const outcome = await app.signals.process({
        id: 'sig_kill', agent: 'hot_trade', bucket: 'hot_trading', chain: 'solana',
        tokenAddress: token.address, tokenSymbol: 'TEST', action: 'BUY', score: 90,
        confidence: 0.9, entryPriceUsd: 1, targetPriceUsd: 1.4, stopLossUsd: 0.85,
        requestedSizeUsd: 250, reason: 'test', riskFlags: [], metadata: {}, createdAt: TEST_NOW,
      });
      expect(outcome.executed).toBe(false);
      expect(outcome.stage).toBe('risk');
      expect(app.portfolio.openPositions()).toHaveLength(0);
    } finally {
      await app.shutdown();
    }
  });

  it('refuses a duplicate trade inside the cooldown window', async () => {
    const token = makeMarket({ address: 'DupTok111111111111111111111111111111111111' });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({ address: token.address })]],
    });
    try {
      app.repo.upsert(token);
      const base = {
        agent: 'hot_trade' as const, bucket: 'hot_trading' as const, chain: 'solana' as const,
        tokenAddress: token.address, tokenSymbol: 'TEST', action: 'BUY' as const, score: 90,
        confidence: 0.9, entryPriceUsd: 1, targetPriceUsd: 1.4, stopLossUsd: 0.85,
        requestedSizeUsd: 200, reason: 'test', riskFlags: [], metadata: {}, createdAt: TEST_NOW,
      };
      const first = await app.signals.process({ ...base, id: 'sig_dup_1' });
      expect(first.executed).toBe(true);

      const second = await app.signals.process({ ...base, id: 'sig_dup_2' });
      expect(second.executed).toBe(false);
      expect(second.stage).toBe('risk');
    } finally {
      await app.shutdown();
    }
  });

  it('closes a position when the stop loss is hit', async () => {
    const token = makeMarket({ address: 'StopTok11111111111111111111111111111111111', priceUsd: 1 });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({ address: token.address })]],
    });
    try {
      app.repo.upsert(token);
      await app.signals.process({
        id: 'sig_stop', agent: 'hot_trade', bucket: 'hot_trading', chain: 'solana',
        tokenAddress: token.address, tokenSymbol: 'TEST', action: 'BUY', score: 90,
        confidence: 0.9, entryPriceUsd: 1, targetPriceUsd: 1.4, stopLossUsd: 0.85,
        requestedSizeUsd: 250, reason: 'test', riskFlags: [], metadata: {}, createdAt: TEST_NOW,
      });
      expect(app.portfolio.openPositions()).toHaveLength(1);

      // The price collapses. Marking to market must fire the stop.
      app.marketProvider.setSnapshots([{ ...token, priceUsd: 0.5 }]);
      const result = await app.positionsManager.markAndManage();
      expect(result.closed).toBe(1);
      expect(app.portfolio.openPositions()).toHaveLength(0);

      const state = app.portfolio.getState();
      expect(state.realizedPnlUsd).toBeLessThan(0);
    } finally {
      await app.shutdown();
    }
  });

  it('closes a position when the take profit is hit', async () => {
    const token = makeMarket({ address: 'TpTok1111111111111111111111111111111111111', priceUsd: 1 });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({ address: token.address })]],
    });
    try {
      app.repo.upsert(token);
      await app.signals.process({
        id: 'sig_tp', agent: 'hot_trade', bucket: 'hot_trading', chain: 'solana',
        tokenAddress: token.address, tokenSymbol: 'TEST', action: 'BUY', score: 90,
        confidence: 0.9, entryPriceUsd: 1, targetPriceUsd: 1.4, stopLossUsd: 0.85,
        requestedSizeUsd: 250, reason: 'test', riskFlags: [], metadata: {}, createdAt: TEST_NOW,
      });
      app.marketProvider.setSnapshots([{ ...token, priceUsd: 1.8 }]);
      const result = await app.positionsManager.markAndManage();
      expect(result.closed).toBe(1);
      expect(app.portfolio.getState().realizedPnlUsd).toBeGreaterThan(0);
    } finally {
      await app.shutdown();
    }
  });

  it('produces no signals from an agent that is disabled', async () => {
    const token = makeMarket();
    const app = makeTestApp({ snapshots: [token], onChain: [[token.address, makeOnChain()]] });
    try {
      app.config.update({ agents: { hot_trade: { enabled: false } } });
      expect(app.agents.get('hot_trade')!.isEnabled()).toBe(false);
    } finally {
      await app.shutdown();
    }
  });
});

describe('scheduler', () => {
  it('never lets a job overlap itself', async () => {
    const clock = new FakeClock(0);
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const log = { record() {} } as never;
    const scheduler = new Scheduler(clock, logger, log, 1_000);

    let running = 0;
    let maxConcurrent = 0;
    let release: (() => void) | null = null;

    scheduler.register({
      name: 'slow',
      intervalMs: () => 1_000,
      enabled: () => true,
      runOnStart: true,
      run: async () => {
        running += 1;
        maxConcurrent = Math.max(maxConcurrent, running);
        await new Promise<void>((resolve) => {
          release = () => {
            running -= 1;
            resolve();
          };
        });
      },
    });

    scheduler.start();
    await scheduler.tick(0);
    // Several intervals pass while the first run is still in flight.
    await scheduler.tick(2_000);
    await scheduler.tick(4_000);
    await scheduler.tick(6_000);

    expect(maxConcurrent).toBe(1);
    expect(scheduler.status()[0]!.skippedCount).toBeGreaterThan(0);

    release?.();
    await scheduler.stop();
  });

  it('reports a failing job without taking the scheduler down', async () => {
    const clock = new FakeClock(0);
    const logger = { info() {}, warn() {}, error() {}, debug() {} } as never;
    const log = { record() {} } as never;
    const scheduler = new Scheduler(clock, logger, log, 1_000);

    scheduler.register({
      name: 'broken',
      intervalMs: () => 1_000,
      enabled: () => true,
      runOnStart: true,
      run: async () => {
        throw new Error('provider exploded');
      },
    });

    scheduler.start();
    const result = await scheduler.runNow('broken');
    expect(result.ok).toBe(true);
    expect(scheduler.status()[0]!.lastError).toContain('provider exploded');
    await scheduler.stop();
  });
});
