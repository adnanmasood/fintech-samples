import type { Chain, TokenMarketSnapshot } from '../../core/types.js';
import { HttpClient } from '../http.js';
import type { MarketDataProvider } from '../interfaces.js';

/**
 * DexScreener market data.
 *
 * Free, no key, and it covers every Solana DEX pair, which is why it is the
 * default. Its documented limits are 300 requests a minute on the pair
 * endpoints and 60 a minute on search, so the client is rate limited to stay
 * well inside them.
 */

const BASE = 'https://api.dexscreener.com';
const CHAIN_IDS: Record<Chain, string> = { solana: 'solana' };

interface DsPair {
  chainId: string;
  dexId?: string;
  pairAddress?: string;
  baseToken: { address: string; name?: string; symbol?: string };
  quoteToken?: { address: string; symbol?: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  volume?: { h24?: number; h6?: number; h1?: number; m5?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
}

export class DexScreenerProvider implements MarketDataProvider {
  readonly name = 'dexscreener';
  private readonly http: HttpClient;

  constructor(cacheTtlMs = 20_000) {
    this.http = new HttpClient(this.name, {
      // 300/min on pairs; 250ms between calls leaves plenty of headroom.
      minIntervalMs: 250,
      timeoutMs: 12_000,
      maxRetries: 2,
      cacheTtlMs,
    });
  }

  isConfigured(): boolean {
    // No key needed, so it is always available.
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.getJson(`${BASE}/latest/dex/search?q=SOL`, { cacheTtlMs: 60_000 });
      return true;
    } catch {
      return false;
    }
  }

  async getTokenSnapshot(address: string, chain: Chain): Promise<TokenMarketSnapshot | null> {
    const found = await this.getTokenSnapshots([address], chain);
    return found[0] ?? null;
  }

  async getTokenSnapshots(addresses: string[], chain: Chain): Promise<TokenMarketSnapshot[]> {
    if (addresses.length === 0) return [];
    const out: TokenMarketSnapshot[] = [];
    // The tokens endpoint accepts up to 30 comma-separated addresses per call.
    for (let i = 0; i < addresses.length; i += 30) {
      const batch = addresses.slice(i, i + 30);
      const url = `${BASE}/tokens/v1/${CHAIN_IDS[chain]}/${batch.join(',')}`;
      let pairs: DsPair[] = [];
      try {
        pairs = (await this.http.getJson<DsPair[] | null>(url)) ?? [];
      } catch {
        // A failing batch must not lose the batches that worked.
        continue;
      }
      out.push(...pickBestPairPerToken(pairs, chain));
    }
    return out;
  }

  async searchTokens(terms: string[], chain: Chain, limit: number): Promise<TokenMarketSnapshot[]> {
    const collected: DsPair[] = [];
    for (const term of terms) {
      if (collected.length >= limit * 3) break;
      try {
        const res = await this.http.getJson<{ pairs?: DsPair[] }>(
          `${BASE}/latest/dex/search?q=${encodeURIComponent(term)}`,
          { cacheTtlMs: 30_000 },
        );
        collected.push(...(res.pairs ?? []).filter((p) => p.chainId === CHAIN_IDS[chain]));
      } catch {
        continue;
      }
    }
    return pickBestPairPerToken(collected, chain)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, limit);
  }

  async getNewPairs(chain: Chain, limit: number): Promise<TokenMarketSnapshot[]> {
    // DexScreener's public boosted-token feed is the closest free stand-in for
    // a "new pairs" stream; it surfaces tokens that just started paying for
    // visibility, which skews new. Anything it returns still goes through the
    // full security gate, so a promoted scam gets rejected like any other.
    try {
      const boosted = await this.http.getJson<Array<{ chainId: string; tokenAddress: string }>>(
        `${BASE}/token-boosts/latest/v1`,
        { cacheTtlMs: 60_000 },
      );
      const addresses = boosted
        .filter((b) => b.chainId === CHAIN_IDS[chain])
        .map((b) => b.tokenAddress)
        .slice(0, limit);
      const snapshots = await this.getTokenSnapshots(addresses, chain);
      return snapshots.sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0));
    } catch {
      return [];
    }
  }
}

/**
 * A token trades in many pairs. Keep the deepest one: it is the pair a trade
 * would actually route through, so its liquidity and price are the honest ones.
 */
function pickBestPairPerToken(pairs: DsPair[], chain: Chain): TokenMarketSnapshot[] {
  const best = new Map<string, DsPair>();
  for (const pair of pairs) {
    if (pair.chainId !== CHAIN_IDS[chain]) continue;
    const address = pair.baseToken?.address;
    if (!address) continue;
    const current = best.get(address);
    if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
      best.set(address, pair);
    }
  }
  return [...best.values()].map((p) => toSnapshot(p, chain));
}

function toSnapshot(pair: DsPair, chain: Chain): TokenMarketSnapshot {
  const txns = pair.txns ?? {};
  return {
    address: pair.baseToken.address,
    chain,
    symbol: pair.baseToken.symbol ?? '',
    name: pair.baseToken.name ?? '',
    priceUsd: num(pair.priceUsd) ?? 0,
    marketCapUsd: pair.marketCap ?? null,
    fdvUsd: pair.fdv ?? null,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volume24hUsd: pair.volume?.h24 ?? 0,
    volume6hUsd: pair.volume?.h6 ?? null,
    volume1hUsd: pair.volume?.h1 ?? null,
    volume5mUsd: pair.volume?.m5 ?? null,
    priceChange5m: pair.priceChange?.m5 ?? null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    priceChange6h: pair.priceChange?.h6 ?? null,
    priceChange24h: pair.priceChange?.h24 ?? null,
    buys24h: txns.h24?.buys ?? null,
    sells24h: txns.h24?.sells ?? null,
    buys1h: txns.h1?.buys ?? null,
    sells1h: txns.h1?.sells ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null,
    pairAddress: pair.pairAddress ?? null,
    dexId: pair.dexId ?? null,
    fetchedAt: Date.now(),
  };
}

function num(value: string | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
