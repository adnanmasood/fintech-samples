import type { SocialSnapshot } from '../../core/types.js';
import { HttpClient } from '../http.js';
import type { SocialDataProvider } from '../interfaces.js';

/**
 * News-feed social provider.
 *
 * LunarCrush's public v4 endpoints now answer 402 (payment required) on the
 * free tier, which left the social dimension permanently empty. This is the
 * provider that keeps it alive without a paid key: it reads Solana's own
 * developer news plus a handful of major, well-syndicated crypto outlets over
 * plain RSS, and turns headline mentions into the same `SocialSnapshot` shape
 * every agent already consumes.
 *
 * It needs no API key, cannot be rate-limited into silence, and never throws:
 * one dead feed just drops out of the merge. It is deliberately coarse — a
 * headline mention is a much weaker signal than LunarCrush's cross-platform
 * aggregation of posts and interactions — so `sourceQuality` is capped low
 * and this is meant as the always-on fallback / enrichment layer, not a
 * like-for-like replacement for a real paid feed.
 */

interface FeedItem {
  title: string;
  summary: string;
  publishedAt: number;
  source: string;
}

/** Solana's own news plus general crypto outlets that carry ecosystem coverage. */
const FEEDS: Array<{ name: string; url: string; sourceQuality: number }> = [
  { name: 'solana-news', url: 'https://solana.com/news/rss.xml', sourceQuality: 0.9 },
  { name: 'coindesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', sourceQuality: 0.75 },
  { name: 'cointelegraph', url: 'https://cointelegraph.com/rss', sourceQuality: 0.65 },
  { name: 'decrypt', url: 'https://decrypt.co/feed', sourceQuality: 0.7 },
  { name: 'theblock', url: 'https://www.theblock.co/rss.xml', sourceQuality: 0.75 },
];

const POSITIVE_WORDS = [
  'surge', 'soar', 'rally', 'bullish', 'partnership', 'launch', 'upgrade', 'record',
  'growth', 'adoption', 'breakthrough', 'milestone', 'integrat', 'win', 'gain', 'approve', 'raise',
];
const NEGATIVE_WORDS = [
  'hack', 'exploit', 'scam', 'rug', 'crash', 'plunge', 'bearish', 'lawsuit', 'ban',
  'delay', 'outage', 'vulnerab', 'fraud', 'collapse', 'drain', 'sec charges', 'sell-off', 'selloff',
];

export class NewsFeedSocialProvider implements SocialDataProvider {
  readonly name = 'news-feed';
  private readonly http: HttpClient;
  private cache: { items: FeedItem[]; fetchedAt: number } | null = null;
  private refreshing: Promise<FeedItem[]> | null = null;

  constructor(private readonly refreshMs = 15 * 60_000) {
    this.http = new HttpClient(this.name, {
      minIntervalMs: 500,
      timeoutMs: 10_000,
      maxRetries: 1,
      // This provider keeps its own merged-feed cache below; per-URL caching
      // would just mean five extra copies of the same headlines in memory.
      cacheTtlMs: 0,
    });
  }

  /** No key required: every feed here is public. */
  isConfigured(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const items = await this.refresh();
      return items.length > 0;
    } catch {
      return false;
    }
  }

  async getSocialSnapshot(symbol: string, address: string, name?: string): Promise<SocialSnapshot | null> {
    if (!symbol) return null;
    const items = await this.refresh().catch(() => []);
    if (items.length === 0) return null;

    // News prose almost never uses a bare ticker ("Solana", not "SOL"), so the
    // full name — when the caller has one — is the pattern that actually
    // matches real headlines. The ticker pattern stays as a stricter,
    // cashtag-aware fallback for callers that only have a symbol.
    const namePattern = name && name.length >= 3 ? buildNamePattern(name) : null;
    const symbolPattern = buildSymbolPattern(symbol);
    const matches = items.filter((item) => {
      const text = `${item.title} ${item.summary}`;
      return (namePattern && namePattern.test(text)) || symbolPattern.test(text);
    });

    if (matches.length === 0) {
      // A real "no news" answer, not a failure: the other agents should still
      // get a snapshot to reason over rather than treating this as no data.
      return {
        address,
        symbol,
        mentions24h: 0,
        mentionsPrev24h: null,
        sentiment: null,
        interactions24h: null,
        influencerMentions24h: null,
        spamRatio: null,
        sourceQuality: 0.4,
        sources: ['news-feed'],
        fetchedAt: Date.now(),
      };
    }

    const sentiments = matches.map((item) => scoreSentiment(`${item.title} ${item.summary}`)).filter(isNumber);
    const sentiment = sentiments.length > 0 ? sentiments.reduce((a, b) => a + b, 0) / sentiments.length : null;
    const sources = [...new Set(matches.map((m) => m.source))];
    const avgSourceQuality =
      matches.reduce((sum, item) => sum + (FEEDS.find((f) => f.name === item.source)?.sourceQuality ?? 0.5), 0) /
      matches.length;

    return {
      address,
      symbol,
      mentions24h: matches.length,
      // Plain RSS gives no previous window either; the social agent derives
      // trend from its own stored history, same as it does for LunarCrush.
      mentionsPrev24h: null,
      sentiment,
      interactions24h: null,
      influencerMentions24h: null,
      spamRatio: null,
      // A keyword match across a handful of outlets is real signal, but
      // nowhere near as authoritative as a dedicated social aggregator.
      sourceQuality: Math.min(0.6, avgSourceQuality),
      sources,
      fetchedAt: Date.now(),
    };
  }

  async getTrending(limit: number): Promise<Array<{ symbol: string; address: string | null }>> {
    const items = await this.refresh().catch(() => []);
    if (items.length === 0) return [];

    const counts = new Map<string, number>();
    for (const item of items) {
      for (const ticker of extractTickers(`${item.title} ${item.summary}`)) {
        counts.set(ticker, (counts.get(ticker) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([symbol]) => ({ symbol, address: null }));
  }

  /** Pull every feed, merge, and cache for `refreshMs`. One dead feed never blocks the rest. */
  private async refresh(): Promise<FeedItem[]> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.refreshMs) return this.cache.items;
    // Concurrent callers during the same cache miss share one fetch instead of
    // each kicking off five requests.
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      const results = await Promise.allSettled(FEEDS.map((feed) => this.fetchFeed(feed)));
      const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      // Keep only the last 48h: older headlines have nothing to do with a
      // "24h mentions" figure.
      const cutoff = Date.now() - 48 * 60 * 60 * 1000;
      const fresh = items.filter((i) => i.publishedAt >= cutoff);
      this.cache = { items: fresh, fetchedAt: Date.now() };
      return fresh;
    })();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async fetchFeed(feed: { name: string; url: string }): Promise<FeedItem[]> {
    const xml = await this.http.getText(feed.url);
    return parseRss(xml, feed.name);
  }
}

/**
 * A bare 2-4 letter ticker matches too much ordinary text ("SOL" inside
 * "resolve"), so it only counts prefixed with $, wrapped in word boundaries
 * and capitalised, or spelled out with "coin"/"token" alongside it.
 */
function buildSymbolPattern(symbol: string): RegExp {
  const escaped = escapeRegExp(symbol);
  return new RegExp(`\\$${escaped}\\b|\\b${escaped}\\b(?=.{0,20}?\\b(coin|token)\\b)|\\b${escaped}(coin|token)\\b`, 'i');
}

/** A plain word-boundary match on the token's name, e.g. "Solana" or "dogwifhat". */
function buildNamePattern(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Pulls $CASHTAG-style mentions plus a short list of well-known Solana tickers. */
const KNOWN_TICKERS = ['SOL', 'BONK', 'WIF', 'JUP', 'JTO', 'PYTH', 'RAY', 'ORCA', 'RENDER', 'PENGU'];
function extractTickers(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$([A-Za-z]{2,10})\b/g)) found.add(m[1]!.toUpperCase());
  for (const ticker of KNOWN_TICKERS) {
    if (new RegExp(`\\b${ticker}\\b`).test(text)) found.add(ticker);
  }
  return [...found];
}

/** Crude keyword sentiment: no ML, just a word count, same spirit as the rest of this heuristic feed. */
function scoreSentiment(text: string): number | null {
  const lower = text.toLowerCase();
  let pos = 0;
  let neg = 0;
  for (const word of POSITIVE_WORDS) if (lower.includes(word)) pos += 1;
  for (const word of NEGATIVE_WORDS) if (lower.includes(word)) neg += 1;
  if (pos === 0 && neg === 0) return null;
  return clamp((pos - neg) / (pos + neg), -1, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isNumber(value: number | null): value is number {
  return value != null;
}

/**
 * Minimal RSS 2.0 / Atom reader. Regex rather than a real XML parser: these
 * feeds are simple, well-formed, and this avoids a new dependency for five
 * read-only URLs.
 */
function parseRss(xml: string, source: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const summary = extractTag(block, 'description') ?? extractTag(block, 'summary') ?? extractTag(block, 'content') ?? '';
    const dateText = extractTag(block, 'pubDate') ?? extractTag(block, 'published') ?? extractTag(block, 'updated');
    const publishedAt = dateText ? Date.parse(dateText) : NaN;
    if (!title) continue;
    items.push({
      title: decodeEntities(title),
      summary: decodeEntities(summary),
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      source,
    });
  }
  return items;
}

function extractTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;
  const raw = match[1]!.trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1]! : raw).trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
