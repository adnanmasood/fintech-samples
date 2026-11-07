import { desc } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app.js';
import { pnlSnapshots } from '../../db/schema.js';
import { BUCKETS } from '../../core/types.js';

const allocationSchema = z.object({
  copy_trading: z.number().min(0).max(100),
  hot_trading: z.number().min(0).max(100),
  hidden_gems: z.number().min(0).max(100),
  low_market_cap: z.number().min(0).max(100),
});

export async function registerPortfolioRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/portfolio', async () => {
    const open = app.portfolio.openPositions();
    const marks = new Map<string, number>();
    for (const position of open) {
      const snapshot = app.repo.get(position.tokenAddress);
      if (snapshot?.priceUsd) marks.set(position.tokenAddress, snapshot.priceUsd);
    }
    return app.portfolio.getState(marks);
  });

  server.get('/portfolio/positions', async () => {
    const open = app.portfolio.openPositions();
    return open.map((position) => {
      const snapshot = app.repo.get(position.tokenAddress);
      const mark = snapshot?.priceUsd ?? position.lastMarkPriceUsd ?? position.avgEntryPriceUsd;
      const value = mark * position.quantity;
      return {
        ...position,
        markPriceUsd: mark,
        valueUsd: value,
        unrealizedPnlUsd: value - position.costBasisUsd,
        unrealizedPnlPct:
          position.costBasisUsd > 0 ? ((value - position.costBasisUsd) / position.costBasisUsd) * 100 : 0,
      };
    });
  });

  server.get('/portfolio/history', async () => {
    return app.db.db.select().from(pnlSnapshots).orderBy(desc(pnlSnapshots.day)).limit(90).all();
  });

  /**
   * Change the bucket split. Validated to total 100 before anything moves,
   * and only uninvested cash is redistributed.
   */
  server.put<{ Body: unknown }>('/portfolio/allocations', async (request, reply) => {
    const parsed = allocationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'ALLOCATION_INVALID',
        message: 'Each bucket needs a percentage between 0 and 100.',
        details: parsed.error.issues,
      });
    }
    const total = BUCKETS.reduce((acc, b) => acc + parsed.data[b], 0);
    if (Math.abs(total - 100) > 0.01) {
      return reply.status(400).send({
        error: 'ALLOCATION_INVALID',
        message: `Allocations must total 100%, got ${total.toFixed(2)}%.`,
      });
    }
    app.config.update({ portfolio: { allocations: parsed.data } }, 'api', 'allocation change');
    app.portfolio.applyAllocations(parsed.data);
    return app.portfolio.getState();
  });

  /** Paper mode only: add or remove simulated cash. */
  server.post<{ Body: { amountUsd?: number } }>('/portfolio/fund', async (request, reply) => {
    if (app.config.effectiveMode() === 'live') {
      return reply.status(400).send({
        error: 'LIVE_MODE',
        message: 'Live balances come from the wallet and cannot be set here.',
      });
    }
    const amount = Number(request.body?.amountUsd);
    if (!Number.isFinite(amount) || amount === 0) {
      return reply.status(400).send({ error: 'INVALID_AMOUNT', message: 'Provide a non-zero amountUsd.' });
    }
    app.portfolio.fund(amount);
    return app.portfolio.getState();
  });
}
