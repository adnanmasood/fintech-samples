import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { createServer } from './http/server.js';
import { APP_VERSION } from './core/version.js';

/**
 * Entry point.
 *
 * Starts the platform, serves the API, the landing page and the dashboard, and
 * shuts everything down cleanly so a scan in flight is never cut in half.
 */
async function main(): Promise<void> {
  const env = getEnv();
  const app = buildApp();
  const server = await createServer(app);

  await server.listen({ port: env.PORT, host: '127.0.0.1' });

  const mode = app.config.effectiveMode().toUpperCase();
  app.logger.info(`USF trading platform v${APP_VERSION} listening on http://127.0.0.1:${env.PORT}`);
  app.logger.info(`Mode: ${mode}`);
  app.logger.info(`Landing page  http://127.0.0.1:${env.PORT}/`);
  app.logger.info(`Dashboard     http://127.0.0.1:${env.PORT}/app/`);

  if (app.config.isLiveRequestedButNotArmed()) {
    app.logger.warn(
      'Live mode requested but the server operator opt-in or wallet check is not satisfied; paper mode remains active.',
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info(`${signal} received, shutting down.`);
    try {
      await server.close();
      await app.shutdown();
    } catch (err) {
      app.logger.error({ err }, 'error during shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // An unhandled rejection in an agent must be loud, not silent.
  process.on('unhandledRejection', (reason) => {
    if (reason instanceof Error) {
      app.logger.error({ err: reason }, 'unhandled promise rejection');
    } else {
      app.logger.error({ reason }, 'unhandled promise rejection');
    }
  });
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
