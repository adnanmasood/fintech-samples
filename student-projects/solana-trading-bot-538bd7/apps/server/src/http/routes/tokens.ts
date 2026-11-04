import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app.js';
import { securityChecks, socialSignals, tokenScores } from '../../db/schema.js';
import type { TokenMarketSnapshot } from '../../core/types.js';

const listEntrySchema = z.object({
  tokenAddress: z.string().min(32),
  symbol: z.string().optional(),
  reason: z.string().optional(),
});

export async function registerTokenRoutes(server: FastifyInstance, app: App): Promise<void> {
  /** The token scanner table. */
  server.get<{ Querystring: { limit?: string } }>('/tokens', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    const rows = app.repo.recent(limit);
    return rows.map((row) => {
      const market = row.marketSnapshot as TokenMarketSnapshot | null;
      const score = app.db.db
        .select()
        .from(tokenScores)
        .where(eq(tokenScores.tokenAddress, row.address))
        .orderBy(desc(tokenScores.scoredAt))
        .limit(1)
        .get();
      const security = app.db.db
        .select()
        .from(securityChecks)
        .where(eq(securityChecks.tokenAddress, row.address))
        .orderBy(desc(securityChecks.checkedAt))
        .limit(1)
        .get();
      const social = app.db.db
        .select()
        .from(socialSignals)
        .where(eq(socialSignals.tokenAddress, row.address))
        .orderBy(desc(socialSignals.fetchedAt))
        .limit(1)
        .get();

      return {
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        priceUsd: market?.priceUsd ?? null,
        marketCapUsd: market?.marketCapUsd ?? market?.fdvUsd ?? null,
        liquidityUsd: market?.liquidityUsd ?? null,
        volume24hUsd: market?.volume24hUsd ?? null,
        priceChange24h: market?.priceChange24h ?? null,
        overallScore: score?.overall ?? null,
        scoringAgent: score?.agent ?? null,
        securityScore: security?.score ?? null,
        securityVerdict: security?.verdict ?? null,
        socialScore: social?.mentionScore ?? null,
        riskFlags: (security?.flags as Array<{ code: string; severity: string; message: string }>) ?? [],
        blacklisted: app.lists.isBlacklisted(row.address),
        whitelisted: app.lists.isWhitelisted(row.address),
        lastSeenAt: row.lastSeenAt,
      };
    });
  });

  /** Everything known about one token, including why it scored what it did. */
  server.get<{ Params: { address: string } }>('/tokens/:address', async (request, reply) => {
    const address = request.params.address;
    const market = await app.market.getOne(address);
    if (!market && !app.repo.get(address)) {
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Token is not known to the system.' });
    }
    return {
      market: market ?? app.repo.get(address),
      scores: app.db.db
        .select()
        .from(tokenScores)
        .where(eq(tokenScores.tokenAddress, address))
        .orderBy(desc(tokenScores.scoredAt))
        .limit(10)
        .all(),
      security: app.db.db
        .select()
        .from(securityChecks)
        .where(eq(securityChecks.tokenAddress, address))
        .orderBy(desc(securityChecks.checkedAt))
        .limit(5)
        .all(),
      social: app.db.db
        .select()
        .from(socialSignals)
        .where(eq(socialSignals.tokenAddress, address))
        .orderBy(desc(socialSignals.fetchedAt))
        .limit(5)
        .all(),
      events: app.log.list({ limit: 50 }).filter((e) => e.tokenAddress === address),
    };
  });

  /** Re-run the security gate by hand, bypassing the cache. */
  server.post<{ Params: { address: string } }>('/tokens/:address/security', async (request) => {
    const market = await app.market.getOne(request.params.address);
    return app.security.assess(request.params.address, market, { force: true });
  });

  server.get('/lists', async () => ({
    blacklist: app.lists.entries('blacklist'),
    whitelist: app.lists.entries('whitelist'),
  }));

  server.post<{ Params: { list: string }; Body: unknown }>('/lists/:list', async (request, reply) => {
    const list = request.params.list;
    if (list !== 'blacklist' && list !== 'whitelist') {
      return reply.status(400).send({ error: 'BAD_LIST', message: 'List must be blacklist or whitelist.' });
    }
    const parsed = listEntrySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send({ error: 'INVALID', message: 'A tokenAddress is required.', details: parsed.error.issues });
    }
    app.lists.add(list, parsed.data.tokenAddress, {
      symbol: parsed.data.symbol,
      reason: parsed.data.reason ?? 'added from the dashboard',
      source: 'manual',
    });
    return { ok: true, entries: app.lists.entries(list) };
  });

  server.delete<{ Params: { list: string; address: string } }>(
    '/lists/:list/:address',
    async (request, reply) => {
      const list = request.params.list;
      if (list !== 'blacklist' && list !== 'whitelist') {
        return reply.status(400).send({ error: 'BAD_LIST', message: 'List must be blacklist or whitelist.' });
      }
      app.lists.remove(list, request.params.address);
      return { ok: true, entries: app.lists.entries(list) };
    },
  );
}
