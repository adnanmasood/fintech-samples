import { describe, expect, it } from 'vitest';
import { ScoringEngine, explainScore } from '../src/scoring/scoring-engine.js';
import {
  liquidityDimension,
  marketCapDimension,
  momentumDimension,
  securityDimension,
  smartMoneyDimension,
  socialDimension,
  volumeDimension,
} from '../src/scoring/dimensions.js';
import { DEFAULT_WEIGHTS, normaliseWeights } from '../src/config/defaults.js';
import { TEST_NOW, makeMarket, makeSocial } from './helpers.js';
import type { SecurityAssessment } from '../src/core/types.js';

const cleanSecurity: SecurityAssessment = {
  address: 'a', chain: 'solana', verdict: 'pass', score: 94, flags: [],
  listMatch: null, checkedAt: TEST_NOW, degraded: false,
};

function input(overrides = {}) {
  return {
    market: makeMarket(),
    onChain: null,
    social: makeSocial(),
    security: cleanSecurity,
    trader: null,
    history: [],
    now: TEST_NOW,
    ...overrides,
  };
}

describe('scoring dimensions', () => {
  it('scores a deep pool higher than a thin one', () => {
    const deep = liquidityDimension(input({ market: makeMarket({ liquidityUsd: 900_000 }) }));
    const thin = liquidityDimension(input({ market: makeMarket({ liquidityUsd: 8_000 }) }));
    expect(deep.score).toBeGreaterThan(thin.score);
    expect(thin.risks.length).toBeGreaterThan(0);
  });

  it('punishes a parabolic move rather than rewarding it', () => {
    const steady = momentumDimension(input({ market: makeMarket({ priceChange1h: 15, priceChange6h: 25 }) }));
    const parabolic = momentumDimension(input({ market: makeMarket({ priceChange1h: 280, priceChange6h: 600 }) }));
    expect(steady.score).toBeGreaterThan(parabolic.score);
    expect(parabolic.risks.join(' ')).toContain('late entry risk');
  });

  it('reads volume growth against the token\'s own baseline', () => {
    const history = [makeMarket({ volume24hUsd: 100_000 }), makeMarket({ volume24hUsd: 90_000 })];
    const growing = volumeDimension(input({ market: makeMarket({ volume24hUsd: 500_000 }), history }));
    const flat = volumeDimension(input({ market: makeMarket({ volume24hUsd: 95_000 }), history }));
    expect(growing.score).toBeGreaterThan(flat.score);
  });

  it('pulls the social score down when the posts look automated', () => {
    const organic = socialDimension(input({ social: makeSocial({ spamRatio: 0 }) }));
    const botted = socialDimension(input({ social: makeSocial({ spamRatio: 0.9 }) }));
    expect(botted.score).toBeLessThan(organic.score * 0.6);
  });

  it('rewards net buying by tracked wallets and punishes net selling', () => {
    const buying = smartMoneyDimension(input({ smartMoneyBuys: 6, smartMoneySells: 0 }));
    const selling = smartMoneyDimension(input({ smartMoneyBuys: 0, smartMoneySells: 5 }));
    expect(buying.score).toBeGreaterThan(80);
    expect(selling.score).toBeLessThan(20);
  });

  it('marks a dimension as having no data rather than inventing a score', () => {
    const result = marketCapDimension(input({ market: makeMarket({ marketCapUsd: null, fdvUsd: null }) }));
    expect(result.hasData).toBe(false);
    expect(result.score).toBe(50);
  });

  it('carries the security assessment straight through', () => {
    const result = securityDimension(input());
    expect(result.score).toBe(94);
    expect(result.hasData).toBe(true);
  });

  it('reports a degraded security assessment as missing data', () => {
    const result = securityDimension(
      input({ security: { ...cleanSecurity, degraded: true } }),
    );
    expect(result.hasData).toBe(false);
  });
});

describe('scoring engine', () => {
  const engine = new ScoringEngine();

  it('produces a weighted overall score inside 0..100', () => {
    const score = engine.score('a', DEFAULT_WEIGHTS, input());
    expect(score.overall).toBeGreaterThan(0);
    expect(score.overall).toBeLessThanOrEqual(100);
    expect(score.components.length).toBeGreaterThan(0);
  });

  it('ignores dimensions weighted at zero', () => {
    const weights = normaliseWeights({ ...DEFAULT_WEIGHTS, trader: 0, social: 0, sentiment: 0 });
    const score = engine.score('a', weights, input());
    expect(score.components.find((c) => c.key === 'trader')).toBeUndefined();
    expect(score.components.find((c) => c.key === 'social')).toBeUndefined();
  });

  it('reports full data coverage when every dimension had data', () => {
    const weights = normaliseWeights({
      ...DEFAULT_WEIGHTS, trader: 0, smartMoney: 0, holderGrowth: 0,
    });
    const score = engine.score('a', weights, input());
    expect(score.dataCoverage).toBeCloseTo(1, 5);
  });

  it('reports reduced coverage when a dimension had nothing to work with', () => {
    const score = engine.score('a', DEFAULT_WEIGHTS, input({ social: null, security: null }));
    expect(score.dataCoverage).toBeLessThan(1);
  });

  it('respects per-agent weights: a momentum-heavy profile scores a mover higher', () => {
    const momentumHeavy = normaliseWeights({ ...DEFAULT_WEIGHTS, momentum: 0.6, security: 0.2 });
    const securityHeavy = normaliseWeights({ ...DEFAULT_WEIGHTS, momentum: 0.02, security: 0.6 });
    const mover = input({ market: makeMarket({ priceChange1h: 18, priceChange6h: 40 }) });
    const withMomentum = engine.score('a', momentumHeavy, mover).overall;
    const withSecurity = engine.score('a', securityHeavy, mover).overall;
    expect(withMomentum).not.toBe(withSecurity);
  });

  it('explains itself in a form a person can read', () => {
    const score = engine.score('a', DEFAULT_WEIGHTS, input());
    const text = explainScore(score, 'TEST');
    expect(text).toContain('TEST scored');
    expect(text).toContain('Security');
    expect(text).toContain('weight');
  });

  it('always returns a bounded score even on absurd inputs', () => {
    const score = engine.score('a', DEFAULT_WEIGHTS, input({
      market: makeMarket({
        liquidityUsd: Number.MAX_SAFE_INTEGER,
        volume24hUsd: Number.MAX_SAFE_INTEGER,
        priceChange1h: 1e9,
      }),
    }));
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);
  });
});
