import { desc, eq, gte, and } from 'drizzle-orm';
import { clamp, curveScore, pctChange } from '../core/money.js';
import type { AgentId, SocialSnapshot } from '../core/types.js';
import type { Db } from '../db/client.js';
import { socialSignals } from '../db/schema.js';
import type { SocialDataProvider } from '../providers/interfaces.js';
import type { TokenRepository } from '../market/token-repository.js';
import { BaseAgent, type AgentDeps, type AgentRunResult } from './base-agent.js';

/**
 * Social Intelligence Agent.
 *
 * Produces the five scores the brief asks for, and it is deliberately
 * sceptical: loud is not the same as good. A sudden spike with no source
 * quality behind it reads as coordinated hype, and the spam score exists to
 * pull that back down rather than let it inflate the overall token score.
 *
 * It is not a trading agent. It has no bucket and emits no signals; it feeds
 * the other agents.
 */
export interface SocialScores {
  mention: number;
  sentiment: number;
  trend: number;
  sourceQuality: number;
  spam: number;
}

export class SocialAgent extends BaseAgent {
  readonly id: AgentId = 'social';

  constructor(
    deps: AgentDeps,
    private readonly db: Db,
    private readonly provider: SocialDataProvider,
    /**
     * Optional: lets the trending sweep resolve a bare symbol (all a news or
     * trending feed can name) to a token this system already tracks, so the
     * cache actually gets warmed. Without it, trending items with no address
     * are skipped, same as before.
     */
    private readonly repo?: TokenRepository,
  ) {
    super(deps);
  }

  isEnabled(): boolean {
    return this.deps.config.get().agents.social.enabled;
  }

  intervalMs(): number {
    return this.deps.config.get().agents.social.intervalSec * 1_000;
  }

  /**
   * The snapshot other agents consume.
   *
   * Cached hard: the free social tier is the tightest rate limit in the system,
   * and a token's social profile does not change minute to minute.
   */
  async getSnapshot(address: string, symbol: string, name?: string): Promise<SocialSnapshot | null> {
    const cfg = this.deps.config.get().agents.social;
    if (!cfg.enabled || !this.provider.isConfigured()) return null;

    const cached = this.readCache(address, cfg.cacheTtlSec * 1_000);
    if (cached) return cached;

    const snapshot = await this.provider.getSocialSnapshot(symbol, address, name).catch(() => null);
    if (!snapshot) return null;

    const enriched = this.enrich(snapshot, address);
    this.persist(enriched, this.computeScores(enriched, cfg));
    return enriched;
  }

  /**
   * Fill in what a single-call provider cannot know: the previous window, and
   * therefore whether this is a spike, comes from our own stored history.
   */
  private enrich(snapshot: SocialSnapshot, address: string): SocialSnapshot {
    if (snapshot.mentionsPrev24h != null) return snapshot;
    const previous = this.db
      .select()
      .from(socialSignals)
      .where(eq(socialSignals.tokenAddress, address))
      .orderBy(desc(socialSignals.fetchedAt))
      .limit(6)
      .all();
    const raws = previous
      .map((r) => (r.raw as { mentions24h?: number } | null)?.mentions24h)
      .filter((n): n is number => typeof n === 'number');
    if (raws.length === 0) return snapshot;
    const baseline = raws.reduce((a, b) => a + b, 0) / raws.length;
    return { ...snapshot, mentionsPrev24h: baseline };
  }

  /** The five scores. Each is 0..100 and each is explainable on its own. */
  computeScores(
    snapshot: SocialSnapshot,
    cfg = this.deps.config.get().agents.social,
  ): SocialScores {
    const mentions = snapshot.mentions24h ?? 0;

    const mention = curveScore(mentions, [
      [0, 0],
      [cfg.minMentions24h, 25],
      [200, 55],
      [2_000, 80],
      [20_000, 95],
      [200_000, 100],
    ]);

    const sentiment =
      snapshot.sentiment == null
        ? 50
        : curveScore(snapshot.sentiment, [
            [-1, 0],
            [-0.3, 30],
            [0, 50],
            [0.4, 78],
            [1, 100],
          ]);

    // Trend is growth against this token's own baseline, not a raw count.
    const growth =
      snapshot.mentionsPrev24h && snapshot.mentionsPrev24h > 0
        ? pctChange(snapshot.mentionsPrev24h, mentions)
        : null;
    const trend =
      growth == null
        ? 50
        : curveScore(growth, [
            [-80, 5],
            [-25, 32],
            [0, 50],
            [60, 72],
            [250, 90],
            [1_000, 98],
          ]);

    const sourceQuality = (snapshot.sourceQuality ?? 0.5) * 100;

    // A spike far beyond the configured multiple, with thin sourcing behind it,
    // is the signature of a paid push rather than organic interest.
    let spam = (snapshot.spamRatio ?? 0) * 100;
    if (growth != null && snapshot.mentionsPrev24h != null && snapshot.mentionsPrev24h > 0) {
      const multiple = mentions / snapshot.mentionsPrev24h;
      if (multiple > cfg.spikeMultiple) {
        const excess = clamp((multiple - cfg.spikeMultiple) / (cfg.spikeMultiple * 3), 0, 1);
        const unsupported = 1 - (snapshot.sourceQuality ?? 0.5);
        spam = Math.max(spam, excess * unsupported * 100);
      }
    }
    // Enormous reach with almost no interactions behind it is bot volume.
    if (snapshot.interactions24h != null && mentions > 0) {
      const perMention = snapshot.interactions24h / mentions;
      if (perMention < 1 && mentions > 100) spam = Math.max(spam, 60);
    }

    return {
      mention: clamp(mention, 0, 100),
      sentiment: clamp(sentiment, 0, 100),
      trend: clamp(trend, 0, 100),
      sourceQuality: clamp(sourceQuality, 0, 100),
      spam: clamp(spam, 0, 100),
    };
  }

  /** The periodic sweep: refresh what is trending so the cache is warm. */
  protected async scan(): Promise<AgentRunResult> {
    const cfg = this.deps.config.get().agents.social;
    if (!this.provider.isConfigured()) {
      return {
        agent: this.id,
        tokensScanned: 0,
        signals: [],
        rejected: 0,
        avgScore: null,
        notes: { reason: 'no social provider configured' },
      };
    }

    const trending = await this.provider.getTrending(25).catch(() => []);
    let refreshed = 0;
    for (const item of trending) {
      // A trending symbol with no address is only useful once it is matched
      // to a token this system has actually seen on-chain.
      const address = item.address ?? this.repo?.findBySymbol(item.symbol) ?? null;
      if (!address) continue;
      const snapshot = await this.provider.getSocialSnapshot(item.symbol, address).catch(() => null);
      if (!snapshot) continue;
      const enriched = this.enrich(snapshot, address);
      this.persist(enriched, this.computeScores(enriched, cfg));
      refreshed += 1;
    }

    return {
      agent: this.id,
      tokensScanned: trending.length,
      // This agent never trades; it has no bucket and emits nothing.
      signals: [],
      rejected: 0,
      avgScore: null,
      notes: { trending: trending.length, refreshed },
    };
  }

  private readCache(address: string, ttlMs: number): SocialSnapshot | null {
    if (ttlMs <= 0) return null;
    const row = this.db
      .select()
      .from(socialSignals)
      .where(and(eq(socialSignals.tokenAddress, address), gte(socialSignals.fetchedAt, Date.now() - ttlMs)))
      .orderBy(desc(socialSignals.fetchedAt))
      .limit(1)
      .get();
    if (!row) return null;
    return (row.raw as unknown as SocialSnapshot | null) ?? null;
  }

  private persist(snapshot: SocialSnapshot, scores: SocialScores): void {
    try {
      this.db
        .insert(socialSignals)
        .values({
          tokenAddress: snapshot.address,
          symbol: snapshot.symbol,
          mentionScore: scores.mention,
          sentimentScore: scores.sentiment,
          trendScore: scores.trend,
          sourceQualityScore: scores.sourceQuality,
          spamScore: scores.spam,
          raw: snapshot as unknown as Record<string, unknown>,
          fetchedAt: snapshot.fetchedAt,
        })
        .run();
    } catch {
      // Caching is an optimisation; failing to cache must not fail the read.
    }
  }
}
