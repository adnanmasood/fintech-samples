import type { SocialSnapshot } from '../../core/types.js';
import { HttpClient } from '../http.js';
import type { SocialDataProvider } from '../interfaces.js';

/**
 * LunarCrush.
 *
 * Aggregates X, Reddit, YouTube, TikTok and news into per-asset counts and
 * sentiment, which is far cheaper and far more terms-of-service friendly than
 * scraping each platform. Rate limited hard on the free tier, so the cache TTL
 * is long and every failure degrades to null rather than throwing.
 *
 * As of writing, LunarCrush's public v4 endpoints (`coins/{symbol}/v1` and
 * `coins/list/v1`) answer HTTP 402 (payment required) for keys on the free
 * tier — every call here degrades to null exactly like any other failure, so
 * this provider quietly stops producing anything. The registry wraps it in
 * `CompositeSocialProvider` alongside the news-feed provider precisely for
 * this: the social dimension keeps working from headlines even while this
 * one is fully paywalled. If your plan changes, nothing here needs editing.
 */

const BASE = 'https://lunarcrush.com/api4/public';

interface LcCoin {
  symbol?: string;
  name?: string;
  social_volume_24h?: number;
  social_dominance?: number;
  interactions_24h?: number;
  sentiment?: number;
  galaxy_score?: number;
  alt_rank?: number;
  percent_change_24h?: number;
}

export class LunarCrushProvider implements SocialDataProvider {
  readonly name = 'lunarcrush';
  private readonly http: HttpClient;

  constructor(
    private readonly apiKey: string | undefined,
    cacheTtlMs = 900_000,
  ) {
    this.http = new HttpClient(this.name, {
      // The free tier is roughly 10 calls a minute. Six seconds apart keeps
      // the agent inside it even when it sweeps a long token list.
      minIntervalMs: 6_000,
      timeoutMs: 15_000,
      maxRetries: 1,
      cacheTtlMs,
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    });
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.http.getJson(`${BASE}/coins/list/v1?limit=1`);
      return true;
    } catch {
      return false;
    }
  }

  async getSocialSnapshot(symbol: string, address: string): Promise<SocialSnapshot | null> {
    if (!this.isConfigured() || !symbol) return null;
    try {
      const res = await this.http.getJson<{ data?: LcCoin }>(
        `${BASE}/coins/${encodeURIComponent(symbol)}/v1`,
      );
      const coin = res.data;
      if (!coin) return null;
      return {
        address,
        symbol,
        mentions24h: coin.social_volume_24h ?? null,
        // The v1 coin endpoint gives no previous window, so the trend is
        // derived later from our own stored history instead of guessed here.
        mentionsPrev24h: null,
        sentiment: normaliseSentiment(coin.sentiment),
        interactions24h: coin.interactions_24h ?? null,
        influencerMentions24h: null,
        spamRatio: null,
        // A single aggregator that spans several platforms is decent but not
        // authoritative, so it never claims full source quality.
        sourceQuality: 0.7,
        sources: ['lunarcrush'],
        fetchedAt: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getTrending(limit: number): Promise<Array<{ symbol: string; address: string | null }>> {
    if (!this.isConfigured()) return [];
    try {
      const res = await this.http.getJson<{ data?: LcCoin[] }>(
        `${BASE}/coins/list/v1?sort=social_volume_24h&limit=${limit}`,
      );
      return (res.data ?? [])
        .filter((c): c is LcCoin & { symbol: string } => Boolean(c.symbol))
        .map((c) => ({ symbol: c.symbol, address: null }));
    } catch {
      return [];
    }
  }
}

/** LunarCrush reports sentiment 0..100. The domain wants -1..1. */
function normaliseSentiment(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return (value - 50) / 50;
}
