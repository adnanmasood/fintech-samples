import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { checkProviderHealth } from '../../providers/registry.js';
import { APP_VERSION, STARTED_AT } from '../../core/version.js';

export async function registerHealthRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get('/health', async () => ({
    ok: true,
    at: Date.now(),
    appVersion: APP_VERSION,
  }));

  /**
   * The status panel. Reports what is wired without ever reporting a value:
   * `describeEnv` returns presence booleans only.
   */
  server.get<{ Querystring: { probe?: string } }>('/status', async (request) => {
    const probe = request.query.probe === 'true';
    const providers = await checkProviderHealth(app.providers, probe);
    const preflight = app.liveExecutor.preflight();

    return {
      mode: app.config.effectiveMode(),
      configuredMode: app.config.get().mode,
      liveReady: preflight.ok,
      liveBlockers: preflight.problems,
      killSwitch: app.config.get().risk.killSwitch,
      // Address and source only; the key never leaves WalletService. The last
      // balance reading rides along so the dashboard's existing poll carries
      // it without a second request.
      wallet: { ...app.wallet.describe(), balance: app.walletBalance.peek() },
      providers,
      tokensTracked: app.repo.count(),
      scheduler: app.scheduler.status(),
      // The build that is running, so a stale bundle is obvious rather than
      // something to guess at.
      appVersion: APP_VERSION,
      startedAt: STARTED_AT,
      // The configuration document's own revision, bumped on every edit.
      configVersion: app.config.get().version,
    };
  });
}
