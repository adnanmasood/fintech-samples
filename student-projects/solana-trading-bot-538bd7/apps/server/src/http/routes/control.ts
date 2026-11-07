import type { FastifyInstance } from 'fastify';
import type { App } from '../../app.js';

export async function registerControlRoutes(server: FastifyInstance, app: App): Promise<void> {
  /**
   * The kill switch.
   *
   * Stops new positions immediately. It deliberately does not close anything:
   * a panic button that force-sells into a thin market can do more damage than
   * the thing it was pressed for. Closing is a separate, explicit action.
   */
  server.post<{ Body: { engaged?: boolean } }>('/control/kill-switch', async (request) => {
    const engaged = Boolean(request.body?.engaged);
    app.config.setKillSwitch(engaged, 'api');
    app.log.record({
      level: 'warn',
      category: 'system',
      message: engaged
        ? 'Kill switch engaged. No new positions will be opened.'
        : 'Kill switch released. Trading may resume.',
    });
    return { killSwitch: engaged };
  });

  /** Close every open position at the current mark. Always available. */
  server.post<{ Body: { reason?: string } }>('/control/close-all', async (request) => {
    const reason = request.body?.reason ?? 'Closed by hand from the dashboard.';
    const closed = await app.positionsManager.closeAll(reason);
    app.log.record({
      level: 'warn',
      category: 'system',
      message: `Closed ${closed} position(s) by hand. ${reason}`,
    });
    return { closed };
  });

  /**
   * Switch between paper and live.
   *
   * Asking for live here is not enough on its own: a usable wallet has to be
   * configured too, and the response says plainly what is still missing rather
   * than silently staying on paper.
   */
  server.post<{ Body: { mode?: string } }>('/control/mode', async (request, reply) => {
    const mode = request.body?.mode;
    if (mode !== 'paper' && mode !== 'live') {
      return reply.status(400).send({ error: 'BAD_MODE', message: 'Mode must be paper or live.' });
    }
    app.config.update({ mode }, 'api', `mode set to ${mode}`);
    const preflight = app.liveExecutor.preflight();
    const effective = app.config.effectiveMode();

    const funded = effective === 'live' ? await seedFromWallet(app) : seedFromPaper(app);

    app.log.record({
      level: 'warn',
      category: 'system',
      message: `Mode set to ${mode}. Effective mode is ${effective}.`,
      payload: { blockers: preflight.problems, funded },
    });

    return {
      requestedMode: mode,
      effectiveMode: effective,
      ready: preflight.ok,
      blockers: preflight.problems,
      funded,
    };
  });
}

/**
 * Point the ledger at the real wallet on the way into live mode.
 *
 * Without this the buckets would still be holding the paper starting balance,
 * and the risk manager would happily size a $500 trade against a wallet with
 * $40 in it — every one of which fails at the router, after paying to find
 * out. Open positions block the reseed because their cost basis has already
 * left cash, and overwriting the total here would count it twice.
 */
async function seedFromWallet(app: App): Promise<FundingResult | null> {
  if (app.portfolio.openPositions().length > 0) return null;

  const balance = await app.walletBalance.read(true);
  if (balance.balanceUsd == null || balance.solBalance == null) return null;

  app.portfolio.resetBooks(balance.balanceUsd);
  app.log.record({
    level: 'warn',
    category: 'portfolio',
    message:
      `Live books opened from the wallet: ${balance.solBalance.toFixed(4)} SOL ` +
      `(about $${balance.balanceUsd.toFixed(2)}). Paper P&L has been cleared.`,
    payload: { address: balance.address, solBalance: balance.solBalance, balanceUsd: balance.balanceUsd },
  });
  return { source: 'wallet', balanceUsd: balance.balanceUsd, solBalance: balance.solBalance };
}

/**
 * The mirror image on the way back to paper: simulated cash comes from the
 * configured starting balance. Without this the buckets would keep whatever
 * the wallet happened to hold, so an excursion into live mode with an empty
 * wallet would leave paper trading permanently stuck at zero.
 */
function seedFromPaper(app: App): FundingResult | null {
  if (app.portfolio.openPositions().length > 0) return null;

  const balanceUsd = app.config.get().portfolio.paperStartingBalanceUsd;
  app.portfolio.resetBooks(balanceUsd);
  app.log.record({
    category: 'portfolio',
    message: `Paper books reopened at the starting balance of $${balanceUsd.toFixed(2)}.`,
    payload: { balanceUsd },
  });
  return { source: 'paper', balanceUsd, solBalance: null };
}

interface FundingResult {
  source: 'wallet' | 'paper';
  balanceUsd: number;
  /** Only meaningful for a live wallet. */
  solBalance: number | null;
}
