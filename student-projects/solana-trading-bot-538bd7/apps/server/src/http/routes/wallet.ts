import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';
import { SafetyError } from '../../core/errors.js';

/**
 * Wallet routes.
 *
 * Every response here is derived from the public address or the chain. The
 * private key goes one way only — in through PUT, into the encrypted store —
 * and there is deliberately no endpoint that reads it back.
 */
export async function registerWalletRoutes(server: FastifyInstance, app: App): Promise<void> {
  server.get<{ Querystring: { refresh?: string } }>('/wallet', async (request) => {
    const report = app.wallet.describe();
    // Skip the RPC call entirely when there is nothing to look up.
    const balance = report.configured
      ? await app.walletBalance.read(request.query.refresh === 'true')
      : app.walletBalance.peek();
    return { ...report, balance };
  });

  /**
   * Save a private key. The key is validated by deriving its keypair before
   * anything is written, so an unusable paste is rejected rather than stored.
   */
  server.put<{ Body: { privateKey?: string } }>('/wallet/key', async (request, reply) => {
    const raw = request.body?.privateKey;
    if (typeof raw !== 'string') {
      return reply.status(400).send({
        error: 'MISSING_KEY',
        message: 'Send the private key as privateKey.',
      });
    }

    let address: string;
    try {
      address = app.wallet.save(raw);
    } catch (err) {
      if (err instanceof SafetyError) {
        return reply.status(400).send({ error: 'INVALID_KEY', message: err.message });
      }
      throw err;
    }

    // The balance belongs to the old wallet now.
    const balance = await app.walletBalance.read(true);

    app.log.record({
      level: 'warn',
      category: 'system',
      message: `A wallet private key was saved. Trading wallet is now ${address}.`,
      payload: { address },
    });

    return { ...app.wallet.describe(), balance };
  });

  /**
   * Forget the saved key. Live mode is dropped at the same time rather than
   * left configured-but-unarmed, so the dashboard cannot show live with no
   * wallet behind it.
   */
  server.delete('/wallet/key', async () => {
    app.wallet.clear();
    if (app.config.get().mode === 'live' && !app.wallet.isAvailable()) {
      app.config.update({ mode: 'paper' }, 'api', 'wallet key removed');
    }
    app.log.record({
      level: 'warn',
      category: 'system',
      message: 'The saved wallet private key was removed.',
    });
    return { ...app.wallet.describe(), balance: await app.walletBalance.read(true) };
  });
}
