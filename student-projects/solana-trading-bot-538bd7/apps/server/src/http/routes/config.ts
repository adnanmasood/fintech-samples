import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { ConfigError } from '../../core/errors.js';
import { describeEnv } from '../../config/env.js';

export async function registerConfigRoutes(server: FastifyInstance, app: App): Promise<void> {
  /**
   * The whole trading configuration.
   *
   * Safe to serve in full: secrets live in the environment and are not part of
   * this document. The env report alongside it reports presence only.
   */
  server.get('/config', async () => ({
    config: app.config.get(),
    effectiveMode: app.config.effectiveMode(),
    liveRequestedButNotArmed: app.config.isLiveRequestedButNotArmed(),
    // describeEnv only knows about WALLET_PRIVATE_KEY; the wallet itself also
    // knows about a key saved from the dashboard.
    env: { ...describeEnv(), walletConfigured: app.wallet.isAvailable() },
  }));

  server.patch<{ Body: Record<string, unknown> }>('/config', async (request, reply) => {
    try {
      const next = app.config.update(request.body ?? {}, 'api', 'dashboard edit');
      return { config: next, effectiveMode: app.config.effectiveMode() };
    } catch (err) {
      if (err instanceof ConfigError) {
        return reply.status(400).send({
          error: err.code,
          message: err.message,
          details: err.details ?? null,
        });
      }
      throw err;
    }
  });

  server.post('/config/reset', async () => ({
    config: app.config.resetToDefaults('api'),
    effectiveMode: app.config.effectiveMode(),
  }));

  server.get('/config/history', async () => app.config.history(50));
}
