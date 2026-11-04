import { describe, expect, it } from 'vitest';
import { TEST_NOW, makeMarket, makeOnChain, makeTestApp } from './helpers.js';
import { PaperExecutor } from '../src/execution/paper-executor.js';
import type { ExecutionRequest, TradeSignal } from '../src/core/types.js';

function buyRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    signalId: 'sig_1',
    agent: 'hot_trade',
    bucket: 'hot_trading',
    chain: 'solana',
    tokenAddress: 'Tok1111111111111111111111111111111111111111',
    tokenSymbol: 'TEST',
    side: 'buy',
    amountUsd: 250,
    quantity: null,
    priceUsd: 1,
    maxSlippageBps: 150,
    mode: 'paper',
    ...overrides,
  };
}

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig_exec_1', agent: 'hot_trade', bucket: 'hot_trading', chain: 'solana',
    tokenAddress: 'Tok1111111111111111111111111111111111111111', tokenSymbol: 'TEST',
    action: 'BUY', score: 82, confidence: 0.8, entryPriceUsd: 1,
    targetPriceUsd: 1.4, stopLossUsd: 0.85, requestedSizeUsd: 250,
    reason: 'test', riskFlags: [], metadata: {}, createdAt: TEST_NOW, ...overrides,
  };
}

describe('paper executor', () => {
  it('fills a buy above the mark, because slippage works against the trader', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      const executor = new PaperExecutor(app.config, app.repo);
      const result = await executor.execute(buyRequest());
      expect(result.ok).toBe(true);
      expect(result.filledPriceUsd).toBeGreaterThan(1);
      expect(result.feesUsd).toBeGreaterThan(0);
      // A paper trade has no signature and must not pretend otherwise.
      expect(result.txSignature).toBeNull();
    } finally {
      await app.shutdown();
    }
  });

  it('fills a sell below the mark', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market] });
    try {
      app.repo.upsert(market);
      const executor = new PaperExecutor(app.config, app.repo);
      const result = await executor.execute(buyRequest({ side: 'sell', amountUsd: null, quantity: 100 }));
      expect(result.ok).toBe(true);
      expect(result.filledPriceUsd).toBeLessThan(1);
    } finally {
      await app.shutdown();
    }
  });

  it('charges more slippage in a thin pool than a deep one', async () => {
    const thin = makeMarket({ address: 'Thin', liquidityUsd: 20_000 });
    const deep = makeMarket({ address: 'Deep', liquidityUsd: 5_000_000 });
    const app = makeTestApp({ snapshots: [thin, deep] });
    try {
      app.repo.upsert(thin);
      app.repo.upsert(deep);
      const executor = new PaperExecutor(app.config, app.repo);
      const thinFill = await executor.execute(buyRequest({ tokenAddress: 'Thin', maxSlippageBps: 5_000 }));
      const deepFill = await executor.execute(buyRequest({ tokenAddress: 'Deep', maxSlippageBps: 5_000 }));
      expect(thinFill.slippageBps).toBeGreaterThan(deepFill.slippageBps);
    } finally {
      await app.shutdown();
    }
  });

  it('refuses a fill that would exceed the slippage limit, as a real router would', async () => {
    const tiny = makeMarket({ address: 'Tiny', liquidityUsd: 2_000 });
    const app = makeTestApp({ snapshots: [tiny] });
    try {
      app.repo.upsert(tiny);
      const executor = new PaperExecutor(app.config, app.repo);
      const result = await executor.execute(buyRequest({ tokenAddress: 'Tiny', amountUsd: 1_000, maxSlippageBps: 50 }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain('exceeds');
    } finally {
      await app.shutdown();
    }
  });

  it('refuses to fill without a usable price', async () => {
    const app = makeTestApp();
    try {
      const executor = new PaperExecutor(app.config, app.repo);
      const result = await executor.execute(buyRequest({ priceUsd: 0 }));
      expect(result.ok).toBe(false);
    } finally {
      await app.shutdown();
    }
  });
});

describe('execution service bookkeeping', () => {
  it('opens a position and takes the cost out of the right bucket', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      const before = app.portfolio.getBucketCash('hot_trading');
      const { result, position } = await app.execution.openPosition(makeSignal(), 250, 1);

      expect(result.ok).toBe(true);
      expect(position).not.toBeNull();
      expect(position!.bucket).toBe('hot_trading');

      const after = app.portfolio.getBucketCash('hot_trading');
      // Cash out equals the fill plus its fees, exactly.
      expect(before - after).toBeCloseTo(result.grossUsd + result.feesUsd, 2);
      // Only the hot bucket paid.
      expect(app.portfolio.getBucketCash('copy_trading')).toBeCloseTo(3_000, 2);
    } finally {
      await app.shutdown();
    }
  });

  it('averages into an existing position rather than opening a second one', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      await app.execution.openPosition(makeSignal(), 200, 1);
      await app.execution.openPosition(makeSignal({ id: 'sig_exec_2' }), 200, 2);
      const open = app.portfolio.openPositions();
      expect(open).toHaveLength(1);
      // Averaged entry sits between the two fills.
      expect(open[0]!.avgEntryPriceUsd).toBeGreaterThan(1);
      expect(open[0]!.avgEntryPriceUsd).toBeLessThan(2);
    } finally {
      await app.shutdown();
    }
  });

  it('books a profit back to the bucket on a winning close', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      const { position } = await app.execution.openPosition(makeSignal(), 250, 1);
      const { realizedPnlUsd } = await app.execution.closePosition(position!, 2, 'take profit');
      expect(realizedPnlUsd).toBeGreaterThan(0);
      const state = app.portfolio.getState();
      expect(state.realizedPnlUsd).toBeCloseTo(realizedPnlUsd, 2);
      expect(app.portfolio.openPositions()).toHaveLength(0);
    } finally {
      await app.shutdown();
    }
  });

  it('books a loss on a losing close and leaves the books consistent', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      const startTotal = app.portfolio.getState().totalValueUsd;
      const { position } = await app.execution.openPosition(makeSignal(), 250, 1);
      await app.execution.closePosition(position!, 0.5, 'stop loss');
      const state = app.portfolio.getState();
      expect(state.realizedPnlUsd).toBeLessThan(0);
      // Equity fell by roughly the loss, and nothing vanished.
      expect(state.totalValueUsd).toBeLessThan(startTotal);
      expect(state.totalValueUsd).toBeGreaterThan(startTotal - 250);
    } finally {
      await app.shutdown();
    }
  });

  it('leaves the position open when an exit fails', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.repo.upsert(market);
      const { position } = await app.execution.openPosition(makeSignal(), 250, 1);
      // Price of zero means the simulated order cannot fill.
      const { result } = await app.execution.closePosition(position!, 0, 'attempted exit');
      expect(result.ok).toBe(false);
      expect(app.portfolio.openPositions()).toHaveLength(1);
    } finally {
      await app.shutdown();
    }
  });
});

describe('live execution abstraction', () => {
  it('refuses to run when live is not fully armed, and says exactly why', async () => {
    const app = makeTestApp();
    try {
      const preflight = app.liveExecutor.preflight();
      expect(preflight.ok).toBe(false);
      expect(preflight.problems.join(' ')).toMatch(/not set to live mode|wallet/i);
    } finally {
      await app.shutdown();
    }
  });

  it('stays on the paper executor while live is requested but not armed', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.config.update({ mode: 'live' });
      expect(app.config.get().mode).toBe('live');
      // No wallet is configured, so the effective mode stays paper and
      // nothing real can be sent.
      expect(app.config.effectiveMode()).toBe('paper');
      expect(app.config.isLiveRequestedButNotArmed()).toBe(true);

      app.repo.upsert(market);
      const { result } = await app.execution.openPosition(makeSignal(), 100, 1);
      expect(result.mode).toBe('paper');
    } finally {
      await app.shutdown();
    }
  });
});
