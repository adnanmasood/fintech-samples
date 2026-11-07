import { describe, expect, it } from 'vitest';
import {
  ALL_RULES,
  buySellImbalanceRule,
  freezeAuthorityRule,
  impersonationRule,
  liquidityFloorRule,
  mintAuthorityRule,
  runRules,
  scoreFromFlags,
  sellTaxRule,
  topHolderRule,
  washTradingRule,
  worstSeverity,
} from '../src/security/rules.js';
import { DEFAULT_CONFIG } from '../src/config/defaults.js';
import { TEST_NOW, makeMarket, makeOnChain, makeTestApp } from './helpers.js';

const cfg = DEFAULT_CONFIG.security;
const now = TEST_NOW;

describe('security rules', () => {
  it('treats a live mint authority as critical', () => {
    const flag = mintAuthorityRule({
      address: 'a', market: null, onChain: makeOnChain({ mintAuthority: 'Deployer1' }), config: cfg, now,
    });
    expect(flag?.code).toBe('MINT_AUTHORITY_ACTIVE');
    expect(flag?.severity).toBe('critical');
  });

  it('treats a live freeze authority as critical, because it traps the position', () => {
    const flag = freezeAuthorityRule({
      address: 'a', market: null, onChain: makeOnChain({ freezeAuthority: 'Deployer1' }), config: cfg, now,
    });
    expect(flag?.severity).toBe('critical');
  });

  it('passes a token with both authorities revoked', () => {
    const input = { address: 'a', market: null, onChain: makeOnChain(), config: cfg, now };
    expect(mintAuthorityRule(input)).toBeNull();
    expect(freezeAuthorityRule(input)).toBeNull();
  });

  it('escalates a punitive sell tax to critical', () => {
    const flag = sellTaxRule({
      address: 'a', market: null, onChain: makeOnChain({ sellTaxBps: 3_000 }), config: cfg, now,
    });
    expect(flag?.severity).toBe('critical');
  });

  it('flags liquidity below the floor and escalates when it is far below', () => {
    const mild = liquidityFloorRule({
      address: 'a', market: makeMarket({ liquidityUsd: 12_000 }), onChain: null, config: cfg, now,
    });
    expect(mild?.severity).toBe('high');
    const severe = liquidityFloorRule({
      address: 'a', market: makeMarket({ liquidityUsd: 500 }), onChain: null, config: cfg, now,
    });
    expect(severe?.severity).toBe('critical');
  });

  it('flags a single wallet holding most of the supply', () => {
    const flag = topHolderRule({
      address: 'a', market: null, onChain: makeOnChain({ topHolderShares: [0.62, 0.1] }), config: cfg, now,
    });
    expect(flag?.code).toBe('TOP_HOLDER_CONCENTRATION');
    expect(flag?.severity).toBe('critical');
  });

  it('detects volume far beyond the pool as wash trading', () => {
    const flag = washTradingRule({
      address: 'a',
      market: makeMarket({ liquidityUsd: 50_000, volume24hUsd: 5_000_000 }),
      onChain: null, config: cfg, now,
    });
    expect(flag?.code).toBe('VOLUME_LOOKS_MANIPULATED');
  });

  it('ignores a buy/sell imbalance when the sample is too small to mean anything', () => {
    const flag = buySellImbalanceRule({
      address: 'a', market: makeMarket({ buys24h: 20, sells24h: 1 }), onChain: null, config: cfg, now,
    });
    expect(flag).toBeNull();
  });

  it('flags a token reusing a symbol that already belongs to another address', () => {
    const flag = impersonationRule({
      address: 'FakeAddr',
      market: makeMarket({ symbol: 'BONK' }),
      onChain: null, config: cfg, now,
      knownSymbols: new Map([['BONK', 'RealAddr']]),
    });
    expect(flag?.code).toBe('DUPLICATE_SYMBOL');
  });

  it('scores a clean token at 100 and a critical one at 0', () => {
    expect(scoreFromFlags([])).toBe(100);
    expect(scoreFromFlags([{ code: 'X', severity: 'critical', message: '' }])).toBe(0);
  });

  it('reports the worst severity across a mixed set', () => {
    const flags = runRules({
      address: 'a',
      market: makeMarket({ liquidityUsd: 1_000 }),
      onChain: makeOnChain({ mintAuthority: 'D' }),
      config: cfg, now,
    }, ALL_RULES);
    expect(worstSeverity(flags)).toBe('critical');
  });
});

describe('security agent as a hard gate', () => {
  it('rejects a token whose deployer can still mint, and blacklists it', async () => {
    const market = makeMarket();
    const app = makeTestApp({
      snapshots: [market],
      onChain: [[market.address, makeOnChain({ mintAuthority: 'Deployer1' })]],
    });
    try {
      const assessment = await app.security.assess(market.address, market);
      expect(assessment.verdict).toBe('reject');
      // A permanent contract flaw is remembered so the same call is not paid for twice.
      expect(app.lists.isBlacklisted(market.address)).toBe(true);
    } finally {
      await app.shutdown();
    }
  });

  it('passes a clean token', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      const assessment = await app.security.assess(market.address, market);
      expect(assessment.verdict).toBe('pass');
      expect(assessment.score).toBeGreaterThan(80);
    } finally {
      await app.shutdown();
    }
  });

  it('rejects immediately when the token is blacklisted, without calling a provider', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market], onChain: [[market.address, makeOnChain()]] });
    try {
      app.lists.add('blacklist', market.address, { reason: 'test' });
      const assessment = await app.security.assess(market.address, market, { force: true });
      expect(assessment.verdict).toBe('reject');
      expect(assessment.listMatch).toBe('blacklist');
    } finally {
      await app.shutdown();
    }
  });

  it('degrades rather than rejects in paper mode when no security provider is configured', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market] });
    try {
      // No on-chain entry, so the provider returns null and the checks cannot run.
      // Paper mode's default (failClosed: false) lets the token continue with
      // a score penalty so the rest of the pipeline stays observable.
      const assessment = await app.security.assess(market.address, market, { force: true });
      expect(assessment.degraded).toBe(true);
      expect(assessment.verdict).not.toBe('reject');
      expect(assessment.score).toBeLessThan(100);
    } finally {
      await app.shutdown();
    }
  });

  it('still fails closed in live mode with no provider, regardless of the failClosed setting', async () => {
    const market = makeMarket();
    const app = makeTestApp({ snapshots: [market] });
    try {
      app.config.update({ mode: 'live', security: { failClosed: false } });
      const assessment = await app.security.assess(market.address, market, { force: true });
      expect(assessment.degraded).toBe(true);
      expect(assessment.verdict).toBe('reject');
      expect(assessment.flags[0]?.severity).toBe('critical');
    } finally {
      await app.shutdown();
    }
  });

  it('lets a whitelist downgrade a rules-based rejection but never a critical one', async () => {
    const thin = makeMarket({ liquidityUsd: 12_000 });
    const app = makeTestApp({
      snapshots: [thin],
      onChain: [[thin.address, makeOnChain()]],
    });
    try {
      app.lists.add('whitelist', thin.address, { reason: 'trusted' });
      const assessment = await app.security.assess(thin.address, thin, { force: true });
      expect(assessment.verdict).toBe('warn');

      // Now make it critical: whitelisting must not rescue it.
      app.securityProvider.set(thin.address, makeOnChain({ mintAuthority: 'D' }));
      const critical = await app.security.assess(thin.address, thin, { force: true });
      expect(critical.verdict).toBe('reject');
    } finally {
      await app.shutdown();
    }
  });
});
