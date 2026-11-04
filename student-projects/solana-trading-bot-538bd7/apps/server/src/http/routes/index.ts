import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { registerHealthRoutes } from './health.js';
import { registerPortfolioRoutes } from './portfolio.js';
import { registerAgentRoutes } from './agents.js';
import { registerTokenRoutes } from './tokens.js';
import { registerTradeRoutes } from './trades.js';
import { registerConfigRoutes } from './config.js';
import { registerControlRoutes } from './control.js';
import { registerActivityRoutes } from './activity.js';
import { registerWalletRoutes } from './wallet.js';

export async function registerRoutes(server: FastifyInstance, app: App): Promise<void> {
  await server.register(
    async (api) => {
      await registerHealthRoutes(api, app);
      await registerPortfolioRoutes(api, app);
      await registerAgentRoutes(api, app);
      await registerTokenRoutes(api, app);
      await registerTradeRoutes(api, app);
      await registerConfigRoutes(api, app);
      await registerControlRoutes(api, app);
      await registerActivityRoutes(api, app);
      await registerWalletRoutes(api, app);
    },
    { prefix: '/api' },
  );
}
