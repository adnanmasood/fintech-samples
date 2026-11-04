import { FakeClock } from '../src/core/clock.js';
import type { TokenMarketSnapshot, TokenOnChainInfo, SocialSnapshot } from '../src/core/types.js';
import { buildApp, type App } from '../src/app.js';
import { StaticMarketProvider, NullSocialProvider, NullLlmProvider, NullDexProvider, NullBlockchainProvider } from '../src/providers/mocks.js';
import type { TokenSecurityProvider } from '../src/providers/interfaces.js';

/**
 * One fixed instant for the whole test suite.
 *
 * The fake clock and every fixture timestamp derive from this, so a "30 day
 * old pair" really is thirty days old from the system's point of view. Mixing
 * a fake clock with real Date.now() makes ages come out negative and every
 * age-based rule misfire.
 */
export const TEST_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

/** A security provider backed by a table, so tests control the contract facts. */
export class StaticSecurityProvider implements TokenSecurityProvider {
  readonly name = 'static-security';
  constructor(private readonly infos = new Map<string, TokenOnChainInfo>()) {}
  set(address: string, info: TokenOnChainInfo): void {
    this.infos.set(address, info);
  }
  isConfigured(): boolean {
    return true;
  }
  async getOnChainInfo(address: string): Promise<TokenOnChainInfo | null> {
    return this.infos.get(address) ?? null;
  }
}

export function makeMarket(overrides: Partial<TokenMarketSnapshot> = {}): TokenMarketSnapshot {
  return {
    address: 'Tok1111111111111111111111111111111111111111',
    chain: 'solana',
    symbol: 'TEST',
    name: 'Test Token',
    priceUsd: 1,
    marketCapUsd: 5_000_000,
    fdvUsd: 5_000_000,
    liquidityUsd: 250_000,
    volume24hUsd: 800_000,
    volume6hUsd: 300_000,
    volume1hUsd: 120_000,
    volume5mUsd: 12_000,
    priceChange5m: 0.4,
    priceChange1h: 8,
    priceChange6h: 14,
    priceChange24h: 22,
    buys24h: 900,
    sells24h: 700,
    buys1h: 90,
    sells1h: 60,
    pairCreatedAt: TEST_NOW - 30 * 24 * 60 * 60 * 1000,
    pairAddress: 'Pair111111111111111111111111111111111111111',
    dexId: 'raydium',
    fetchedAt: TEST_NOW,
    ...overrides,
  };
}

export function makeOnChain(overrides: Partial<TokenOnChainInfo> = {}): TokenOnChainInfo {
  return {
    address: 'Tok1111111111111111111111111111111111111111',
    chain: 'solana',
    decimals: 9,
    supply: 1_000_000_000,
    // A safe token by default: both authorities revoked.
    mintAuthority: null,
    freezeAuthority: null,
    updateAuthority: null,
    isMutable: false,
    creator: 'Creator11111111111111111111111111111111111',
    createdAt: TEST_NOW - 30 * 24 * 60 * 60 * 1000,
    holderCount: 4_000,
    topHolderShares: [0.08, 0.05, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02, 0.01, 0.01],
    lpLockedFraction: 1,
    buyTaxBps: 0,
    sellTaxBps: 0,
    transferFeeBps: 0,
    fetchedAt: TEST_NOW,
    ...overrides,
  };
}

export function makeSocial(overrides: Partial<SocialSnapshot> = {}): SocialSnapshot {
  return {
    address: 'Tok1111111111111111111111111111111111111111',
    symbol: 'TEST',
    mentions24h: 800,
    mentionsPrev24h: 400,
    sentiment: 0.35,
    interactions24h: 12_000,
    influencerMentions24h: 3,
    spamRatio: 0.1,
    sourceQuality: 0.7,
    sources: ['test'],
    fetchedAt: TEST_NOW,
    ...overrides,
  };
}

export interface TestApp extends App {
  fakeClock: FakeClock;
  marketProvider: StaticMarketProvider;
  securityProvider: StaticSecurityProvider;
}

/** A fully wired app on an in-memory database with no network at all. */
export function makeTestApp(
  options: {
    snapshots?: TokenMarketSnapshot[];
    onChain?: Array<[string, TokenOnChainInfo]>;
    now?: number;
  } = {},
): TestApp {
  const fakeClock = new FakeClock(options.now ?? TEST_NOW);
  const marketProvider = new StaticMarketProvider(options.snapshots ?? []);
  const securityProvider = new StaticSecurityProvider(new Map(options.onChain ?? []));

  const app = buildApp({
    databaseUrl: ':memory:',
    clock: fakeClock,
    startScheduler: false,
    logger: silentLogger(),
    providers: {
      market: marketProvider,
      security: securityProvider,
      social: new NullSocialProvider(),
      llm: new NullLlmProvider(),
      dex: new NullDexProvider(),
      blockchain: new NullBlockchainProvider(),
    },
  });

  return Object.assign(app, { fakeClock, marketProvider, securityProvider });
}

function silentLogger() {
  const noop = () => undefined;
  const logger = {
    info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
    level: 'silent',
    child: () => logger,
  };
  return logger as unknown as App['logger'];
}
