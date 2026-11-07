import { describe, expect, it } from 'vitest';
import { checkMarketSnapshot } from '../src/market/sanity.js';
import { makeMarket, makeTestApp } from './helpers.js';

describe('ingestion sanity checks', () => {
  it('passes an ordinary token through untouched', () => {
    expect(checkMarketSnapshot(makeMarket())).toBeNull();
  });

  it('rejects a token impersonating a well-known symbol at the wrong address', () => {
    const fake = makeMarket({ symbol: 'USDC', address: 'Fake11111111111111111111111111111111111111' });
    const result = checkMarketSnapshot(fake);
    expect(result?.code).toBe('IMPOSTOR_SYMBOL');
  });

  it('does not flag the real mint for a canonical symbol', () => {
    const real = makeMarket({
      symbol: 'USDC',
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
    expect(checkMarketSnapshot(real)).toBeNull();
  });

  it('rejects an implausible market cap', () => {
    const fake = makeMarket({ marketCapUsd: 3_080_000_000_000, liquidityUsd: 40_000_000 });
    expect(checkMarketSnapshot(fake)?.code).toBe('IMPLAUSIBLE_MARKET_CAP');
  });

  it('rejects an implausible 24h price move', () => {
    const fake = makeMarket({ priceChange24h: 375_809 });
    expect(checkMarketSnapshot(fake)?.code).toBe('IMPLAUSIBLE_PRICE_CHANGE');
  });

  it('rejects a market cap the liquidity could never support', () => {
    // Under the absolute cap ceiling on its own, but the pool behind it is
    // orders of magnitude too thin to back that price - a bad feed, not a
    // real (if wild) token.
    const fake = makeMarket({ marketCapUsd: 10_000_000_000, liquidityUsd: 23, priceChange24h: 0 });
    expect(checkMarketSnapshot(fake)?.code).toBe('MARKET_CAP_LIQUIDITY_MISMATCH');
  });

  it('does not flag a small legitimate cap sitting on modest liquidity', () => {
    const small = makeMarket({ marketCapUsd: 2_000_000, liquidityUsd: 60_000, priceChange24h: 40 });
    expect(checkMarketSnapshot(small)).toBeNull();
  });
});

describe('cleaning up rows already in the table', () => {
  it('removes stored rows that fail the sanity check and leaves good ones alone', async () => {
    const app = makeTestApp();
    try {
      const good = makeMarket({ address: 'Good1111111111111111111111111111111111111111' });
      const bad = makeMarket({
        address: 'Bad11111111111111111111111111111111111111111',
        marketCapUsd: 3_080_000_000_000,
        priceChange24h: 375_809,
      });
      app.repo.upsertMany([good, bad]);
      expect(app.repo.get(bad.address)).not.toBeNull();

      const removed = app.repo.removeImplausible();

      expect(removed).toBe(1);
      expect(app.repo.get(bad.address)).toBeNull();
      expect(app.repo.get(good.address)).not.toBeNull();
      // Calling it again with nothing left to remove is a no-op, not an error.
      expect(app.repo.removeImplausible()).toBe(0);
    } finally {
      await app.shutdown();
    }
  });
});
