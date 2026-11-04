import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import type { ActivityKind } from '../../observability/activity-log.js';

/**
 * The live feed: outbound provider calls and application log lines.
 *
 * This is separate from `/events`, which is the durable decision log. This one
 * answers "what is it doing right now", the other answers "why did that trade
 * happen".
 */
export async function registerActivityRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get<{ Querystring: { kind?: string; limit?: string; provider?: string; since?: string } }>(
    '/activity',
    async (request) => {
      const kind = request.query.kind === 'http' || request.query.kind === 'log'
        ? (request.query.kind as ActivityKind)
        : undefined;
      return {
        entries: app.activity.list({
          kind,
          limit: Number(request.query.limit ?? 200),
          provider: request.query.provider,
          since: request.query.since ? Number(request.query.since) : undefined,
        }),
        stats: app.activity.stats(),
        buffered: app.activity.size(),
      };
    },
  );

  server.delete('/activity', async () => {
    app.activity.clear();
    return { ok: true };
  });
}
