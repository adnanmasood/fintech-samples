import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { trades, transactions } from '../../db/schema.js';

export async function registerTradeRoutes(server: FastifyInstance, app: App): Promise<void> {
  /**
   * Trades for the mode currently in force.
   *
   * Paper and live trades share one table, so an unfiltered read reports
   * simulated fills as part of a live record. `mode=all` is there for anyone
   * who genuinely wants both, but the dashboard asks for neither and so gets
   * the mode it is running in.
   */
  server.get<{ Querystring: { limit?: string; agent?: string; bucket?: string; mode?: string } }>(
    '/trades',
    async (request) => {
      const limit = Math.min(Number(request.query.limit ?? 100), 500);
      const conditions = [];
      if (request.query.agent) conditions.push(eq(trades.agent, request.query.agent));
      if (request.query.bucket) conditions.push(eq(trades.bucket, request.query.bucket));
      if (request.query.mode !== 'all') {
        conditions.push(eq(trades.mode, request.query.mode ?? app.config.effectiveMode()));
      }
      const where = conditions.length > 0 ? sql.join(conditions, sql` AND `) : undefined;
      return app.db.db
        .select()
        .from(trades)
        .where(where)
        .orderBy(desc(trades.executedAt))
        .limit(limit)
        .all();
    },
  );

  /** Headline numbers for the trade-history panel, for the mode in force. */
  server.get<{ Querystring: { mode?: string } }>('/trades/summary', async (request) => {
    const mode = request.query.mode ?? app.config.effectiveMode();
    const all =
      mode === 'all'
        ? app.db.db.select().from(trades).all()
        : app.db.db.select().from(trades).where(eq(trades.mode, mode)).all();
    const sells = all.filter((t) => t.side === 'sell');
    const wins = sells.filter((t) => t.realizedPnlUsd > 0);
    const losses = sells.filter((t) => t.realizedPnlUsd < 0);
    const grossWin = wins.reduce((acc, t) => acc + t.realizedPnlUsd, 0);
    const grossLoss = Math.abs(losses.reduce((acc, t) => acc + t.realizedPnlUsd, 0));

    return {
      totalTrades: all.length,
      buys: all.filter((t) => t.side === 'buy').length,
      sells: sells.length,
      closedWins: wins.length,
      closedLosses: losses.length,
      winRate: sells.length > 0 ? wins.length / sells.length : null,
      realizedPnlUsd: sells.reduce((acc, t) => acc + t.realizedPnlUsd, 0),
      feesUsd: all.reduce((acc, t) => acc + t.feesUsd, 0),
      // Profit factor is only meaningful once something has actually lost.
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgWinUsd: wins.length > 0 ? grossWin / wins.length : null,
      avgLossUsd: losses.length > 0 ? -grossLoss / losses.length : null,
    };
  });

  /** Live mode only: the on-chain record behind each trade. */
  server.get('/transactions', async () => {
    return app.db.db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.submittedAt))
      .limit(100)
      .all();
  });
}
