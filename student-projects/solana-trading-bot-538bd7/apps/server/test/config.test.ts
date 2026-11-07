import { describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';
import { deepMerge } from '../src/config/config-service.js';
import { DEFAULT_CONFIG, normaliseWeights, DEFAULT_WEIGHTS } from '../src/config/defaults.js';
import { tradingConfigSchema } from '../src/config/schema.js';

describe('configuration', () => {
  it('ships defaults that validate', () => {
    expect(tradingConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });

  it('defaults to paper mode', () => {
    expect(DEFAULT_CONFIG.mode).toBe('paper');
  });

  it('refuses allocations that do not total 100', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      portfolio: {
        ...DEFAULT_CONFIG.portfolio,
        allocations: { copy_trading: 50, hot_trading: 50, hidden_gems: 25, low_market_cap: 15 },
      },
    };
    const result = tradingConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('total 100'))).toBe(true);
    }
  });

  it('refuses scoring weights that do not total 1', () => {
    const bad = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        hot_trade: { ...DEFAULT_CONFIG.agents.hot_trade, weights: { ...DEFAULT_WEIGHTS, security: 0.9 } },
      },
    };
    expect(tradingConfigSchema.safeParse(bad).success).toBe(false);
  });

  it('normalises a weight map to exactly 1', () => {
    const weights = normaliseWeights({ ...DEFAULT_WEIGHTS, momentum: 0.5, security: 0.4 });
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('merges a patch without dropping untouched branches', () => {
    const merged = deepMerge(
      { a: { b: 1, c: 2 }, d: 3 },
      { a: { b: 9 } } as never,
    );
    expect(merged).toEqual({ a: { b: 9, c: 2 }, d: 3 });
  });

  it('replaces arrays rather than concatenating them', () => {
    const merged = deepMerge({ list: [1, 2, 3] }, { list: [9] } as never);
    expect(merged.list).toEqual([9]);
  });

  it('persists an update and bumps the version', async () => {
    const app = makeTestApp();
    try {
      const before = app.config.get().version;
      const next = app.config.update({ risk: { maxPositionUsd: 123 } });
      expect(next.risk.maxPositionUsd).toBe(123);
      expect(next.version).toBe(before + 1);
      // Untouched values survive the patch.
      expect(next.risk.stopLossPct).toBe(DEFAULT_CONFIG.risk.stopLossPct);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects an invalid update and leaves the live config untouched', async () => {
    const app = makeTestApp();
    try {
      const before = app.config.get().risk.maxPositionUsd;
      expect(() => app.config.update({ risk: { maxPositionUsd: -5 } })).toThrow();
      expect(app.config.get().risk.maxPositionUsd).toBe(before);
    } finally {
      await app.shutdown();
    }
  });

  it('keeps live mode inert without a configured wallet', async () => {
    const app = makeTestApp();
    try {
      app.config.update({ mode: 'live' });
      expect(app.config.effectiveMode()).toBe('paper');
      expect(app.config.isLiveRequestedButNotArmed()).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('does not arm live execution with a wallet alone', async () => {
    const app = makeTestApp();
    try {
      app.config.setWalletProbe(() => true);
      app.config.update({ mode: 'live' });
      // A local classroom install starts with LIVE_TRADING_OPT_IN=disabled.
      expect(app.config.effectiveMode()).toBe('paper');
      expect(app.config.isLiveRequestedButNotArmed()).toBe(true);
      expect(app.liveExecutor.preflight().problems.join(' ')).toMatch(/operator opt-in/);
    } finally {
      await app.shutdown();
    }
  });

  it('notifies listeners on change', async () => {
    const app = makeTestApp();
    try {
      let seen = 0;
      app.config.onChange(() => { seen += 1; });
      app.config.update({ risk: { maxOpenPositions: 5 } });
      expect(seen).toBe(1);
    } finally {
      await app.shutdown();
    }
  });
});
