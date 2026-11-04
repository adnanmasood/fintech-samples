import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { agentRuns, signals, socialSignals, tokens } from '../../db/schema.js';

/**
 * The provider a given agent cannot function without, and why. Not every
 * agent needs one: hot_trade and hidden_gem work off market data plus
 * whatever security and social data happens to be available, degrading their
 * *quality* rather than going idle. These three go idle entirely without
 * their provider, which is a different, more visible thing worth surfacing
 * as "degraded" rather than the plain "armed" every other enabled agent gets.
 */
function requiredProvider(name: string, app: App): { ok: boolean; reason: string } | null {
  switch (name) {
    case 'copy_trade':
      return {
        ok: app.providers.blockchain.isConfigured(),
        reason: 'No blockchain provider is configured, so followed wallets cannot be read.',
      };
    case 'social':
      return {
        ok: app.providers.social.isConfigured(),
        reason: 'No social data provider is configured, so nothing can be refreshed.',
      };
    case 'small_market_cap':
      return {
        ok: app.providers.security.isConfigured(),
        reason: 'No on-chain security provider is configured, and this agent refuses to trade without holder data.',
      };
    default:
      return null;
  }
}

export async function registerAgentRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/agents', async () => {
    const status = app.scheduler.status();
    return [...app.agents.entries()].map(([name, agent]) => {
      const job = status.find((s) => s.name === name);
      const lastRun = app.db.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agent, name))
        .orderBy(desc(agentRuns.startedAt))
        .limit(1)
        .get();

      // Aggregate over the recent history rather than the whole table, so the
      // panel stays fast as the log grows.
      const recent = app.db.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.agent, name))
        .orderBy(desc(agentRuns.startedAt))
        .limit(50)
        .all();

      const scored = recent.filter((r) => r.avgScore != null);
      const required = requiredProvider(name, app);
      return {
        id: name,
        bucket: agent.bucket,
        enabled: agent.isEnabled(),
        degraded: required ? !required.ok : false,
        degradedReason: required && !required.ok ? required.reason : null,
        running: job?.running ?? false,
        intervalSec: Math.round(agent.intervalMs() / 1000),
        lastRunAt: lastRun?.startedAt ?? null,
        lastDurationMs: lastRun?.durationMs ?? null,
        nextRunAt: job?.nextRunAt ?? null,
        lastStatus: lastRun?.status ?? null,
        lastError: lastRun?.error ?? null,
        signalsGenerated: recent.reduce((acc, r) => acc + r.signalsGenerated, 0),
        tokensScanned: recent.reduce((acc, r) => acc + r.tokensScanned, 0),
        rejected: recent.reduce((acc, r) => acc + r.rejected, 0),
        avgScore:
          scored.length > 0 ? scored.reduce((acc, r) => acc + (r.avgScore ?? 0), 0) / scored.length : null,
        skippedRuns: job?.skippedCount ?? 0,
      };
    });
  });

  /**
   * What the social agent last caught.
   *
   * The social agent emits no signals of its own — it writes these scores and
   * the trading agents read them back through the scoring engine. Serving them
   * is what makes that otherwise invisible influence legible.
   */
  server.get<{ Querystring: { limit?: string } }>('/social', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 24), 100);
    const rows = app.db.db
      .select()
      .from(socialSignals)
      .orderBy(desc(socialSignals.fetchedAt))
      .limit(limit)
      .all();

    // One row per token: an older snapshot of the same token is history, not
    // a separate catch, and repeating it would overstate how much the agent
    // actually found.
    const seen = new Set<string>();
    return rows
      .filter((row) => {
        if (seen.has(row.tokenAddress)) return false;
        seen.add(row.tokenAddress);
        return true;
      })
      .map((row) => {
        const token = app.db.db
          .select({ symbol: tokens.symbol })
          .from(tokens)
          .where(eq(tokens.address, row.tokenAddress))
          .get();
        return {
          tokenAddress: row.tokenAddress,
          symbol: row.symbol || token?.symbol || '',
          mentionScore: row.mentionScore,
          sentimentScore: row.sentimentScore,
          trendScore: row.trendScore,
          sourceQualityScore: row.sourceQualityScore,
          spamScore: row.spamScore,
          fetchedAt: row.fetchedAt,
        };
      });
  });

  server.get<{ Params: { id: string } }>('/agents/:id/runs', async (request) => {
    return app.db.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.agent, request.params.id))
      .orderBy(desc(agentRuns.startedAt))
      .limit(50)
      .all();
  });

  /** Trigger a scan by hand. The scheduler's overlap lock still applies. */
  server.post<{ Params: { id: string } }>('/agents/:id/run', async (request, reply) => {
    const result = await app.scheduler.runNow(request.params.id);
    if (!result.ok) return reply.status(409).send({ error: 'JOB_BUSY', message: result.message });
    return { ok: true, message: result.message };
  });

  server.get<{ Querystring: { limit?: string; status?: string; agent?: string } }>(
    '/signals',
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      const conditions = [];
      if (request.query.status) conditions.push(eq(signals.status, request.query.status));
      if (request.query.agent) conditions.push(eq(signals.agent, request.query.agent));
      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;
      return app.db.db
        .select()
        .from(signals)
        .where(where)
        .orderBy(desc(signals.createdAt))
        .limit(limit)
        .all();
    },
  );

  /** The decision log: every accepted and refused trade, with its reasons. */
  server.get<{ Querystring: { limit?: string; category?: string; agent?: string } }>(
    '/events',
    async (request) => {
      return app.log.list({
        limit: Number(request.query.limit ?? 100),
        category: request.query.category as never,
        agent: request.query.agent,
      });
    },
  );
}
