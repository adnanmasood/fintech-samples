import { describe, expect, it } from 'vitest';
import { TEST_NOW, makeMarket, makeOnChain, makeSocial, makeTestApp } from './helpers.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import type { HotTradeAgent } from '../src/agents/hot-trade.agent.js';
import type { HiddenGemAgent } from '../src/agents/hidden-gem.agent.js';
import type { SmallCapAgent } from '../src/agents/small-cap.agent.js';
import type { SocialAgent } from '../src/agents/social.agent.js';

describe('hot trade screening', () => {
  it('refuses a token that has already run too far to chase', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hot_trade') as unknown as HotTradeAgent;
      const cfg = DEFAULT_CONFIG.agents.hot_trade;
      const result = agent.screen(makeMarket({ priceChange1h: 95 }), cfg, TEST_NOW);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('already run too far');
    } finally {
      await app.shutdown();
    }
  });

  it('refuses a token where sellers outnumber buyers', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hot_trade') as unknown as HotTradeAgent;
      const result = agent.screen(
        makeMarket({ buys1h: 20, sells1h: 200 }),
        DEFAULT_CONFIG.agents.hot_trade,
        TEST_NOW,
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('sellers outnumber');
    } finally {
      await app.shutdown();
    }
  });

  it('refuses a pair too new to have a readable baseline', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hot_trade') as unknown as HotTradeAgent;
      const result = agent.screen(
        makeMarket({ pairCreatedAt: TEST_NOW - 60_000 }),
        DEFAULT_CONFIG.agents.hot_trade,
        TEST_NOW,
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('too new');
    } finally {
      await app.shutdown();
    }
  });

  it('passes a token that is moving with support', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hot_trade') as unknown as HotTradeAgent;
      const result = agent.screen(makeMarket(), DEFAULT_CONFIG.agents.hot_trade, TEST_NOW);
      expect(result.pass).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('produces no signal at all on a quiet market, which is the normal case', async () => {
    const quiet = makeMarket({ priceChange1h: 0.2, volume1hUsd: 1_000, liquidityUsd: 60_000 });
    const app = makeTestApp({ snapshots: [quiet], onChain: [[quiet.address, makeOnChain()]] });
    try {
      const run = await app.agents.get('hot_trade')!.run();
      expect(run.signals).toHaveLength(0);
      // A quiet cycle is a successful cycle, not an error.
      expect(run.rejected).toBeGreaterThan(0);
    } finally {
      await app.shutdown();
    }
  });
});

describe('hidden gem screening', () => {
  it('rejects a token whose market cap is already too large to be hidden', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hidden_gem') as unknown as HiddenGemAgent;
      const result = agent.screen(
        makeMarket({ marketCapUsd: 900_000_000 }),
        DEFAULT_CONFIG.agents.hidden_gem,
        TEST_NOW,
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('too large');
    } finally {
      await app.shutdown();
    }
  });

  it('rejects a token too new to have proven anything', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('hidden_gem') as unknown as HiddenGemAgent;
      const result = agent.screen(
        makeMarket({ pairCreatedAt: TEST_NOW - 60 * 60 * 1000 }),
        DEFAULT_CONFIG.agents.hidden_gem,
        TEST_NOW,
      );
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('too new');
    } finally {
      await app.shutdown();
    }
  });
});

describe('small cap agent', () => {
  it('declines to trade when it cannot see who holds the token', async () => {
    const token = makeMarket({
      address: 'SmallTok1111111111111111111111111111111111',
      marketCapUsd: 800_000,
      liquidityUsd: 60_000,
      volume24hUsd: 120_000,
    });
    // Snapshot present, but no on-chain entry: holder distribution is unknown.
    const app = makeTestApp({ snapshots: [token] });
    try {
      const run = await app.agents.get('small_market_cap')!.run();
      expect(run.signals).toHaveLength(0);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects a token where a few wallets hold too much of the supply', async () => {
    const token = makeMarket({
      address: 'ConcTok11111111111111111111111111111111111',
      marketCapUsd: 800_000,
      liquidityUsd: 60_000,
      volume24hUsd: 120_000,
    });
    const app = makeTestApp({
      snapshots: [token],
      onChain: [[token.address, makeOnChain({
        address: token.address,
        topHolderShares: [0.3, 0.2, 0.15, 0.1, 0.05],
      })]],
    });
    try {
      const run = await app.agents.get('small_market_cap')!.run();
      expect(run.signals).toHaveLength(0);
      expect(run.rejected).toBeGreaterThan(0);
    } finally {
      await app.shutdown();
    }
  });
});

describe('social scoring', () => {
  it('treats a huge unsupported spike as probable manipulation', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('social') as unknown as SocialAgent;
      const organic = agent.computeScores(makeSocial({ mentions24h: 900, mentionsPrev24h: 600, sourceQuality: 0.9 }));
      const pumped = agent.computeScores(
        makeSocial({ mentions24h: 20_000, mentionsPrev24h: 200, sourceQuality: 0.15, spamRatio: 0 }),
      );
      expect(pumped.spam).toBeGreaterThan(organic.spam);
      expect(pumped.trend).toBeGreaterThan(organic.trend);
    } finally {
      await app.shutdown();
    }
  });

  it('marks reach with almost no interaction behind it as bot volume', async () => {
    const app = makeTestApp();
    try {
      const agent = app.agents.get('social') as unknown as SocialAgent;
      const scores = agent.computeScores(makeSocial({ mentions24h: 5_000, interactions24h: 200 }));
      expect(scores.spam).toBeGreaterThanOrEqual(60);
    } finally {
      await app.shutdown();
    }
  });

  it('never emits a trade signal, because it has no bucket', async () => {
    const app = makeTestApp();
    try {
      const social = app.agents.get('social')!;
      expect(social.bucket).toBeNull();
      const run = await social.run();
      expect(run.signals).toHaveLength(0);
    } finally {
      await app.shutdown();
    }
  });
});

describe('agents cannot execute', () => {
  it('exposes no execution surface on any agent', async () => {
    const app = makeTestApp();
    try {
      for (const agent of app.agents.values()) {
        const surface = agent as unknown as Record<string, unknown>;
        expect(surface.execute).toBeUndefined();
        expect(surface.openPosition).toBeUndefined();
        expect(surface.closePosition).toBeUndefined();
      }
    } finally {
      await app.shutdown();
    }
  });
});
