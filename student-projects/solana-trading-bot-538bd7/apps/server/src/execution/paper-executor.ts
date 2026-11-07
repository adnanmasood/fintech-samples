import type { ConfigService } from '../config/config-service.js';
import { bpsToFraction, roundUsd } from '../core/money.js';
import type { ExecutionRequest, ExecutionResult } from '../core/types.js';
import type { TokenRepository } from '../market/token-repository.js';
import type { TradeExecutor } from '../providers/interfaces.js';

/**
 * Paper executor.
 *
 * Simulates a fill without touching the chain. It runs behind exactly the same
 * strategy, security and risk pipeline as live trading; the only thing that
 * differs is this class.
 *
 * The simulation is deliberately pessimistic. A paper run that ignores fees
 * and price impact produces a number nobody can trade on, so both are modelled
 * against the pool's real depth.
 */
export class PaperExecutor implements TradeExecutor {
  readonly name = 'paper-executor';
  readonly mode = 'paper' as const;

  constructor(
    private readonly config: ConfigService,
    private readonly repo: TokenRepository,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const cfg = this.config.get().execution;
    const price = request.priceUsd;

    if (price <= 0) {
      return failure(this.mode, 'No usable price, the simulated order was not filled.');
    }

    const notionalUsd =
      request.side === 'buy'
        ? (request.amountUsd ?? 0)
        : (request.quantity ?? 0) * price;

    if (notionalUsd <= 0) {
      return failure(this.mode, 'Order size resolved to zero.');
    }

    // Price impact scales with how much of the pool the order consumes, which
    // is the honest way to make a small pool cost more than a deep one.
    const snapshot = this.repo.get(request.tokenAddress);
    const liquidity = snapshot?.liquidityUsd ?? 0;
    const poolPct = liquidity > 0 ? (notionalUsd / liquidity) * 100 : 5;
    const impactBps = poolPct * cfg.paperImpactBpsPerPoolPct;
    const slippageBps = Math.min(cfg.paperBaseSlippageBps + impactBps, request.maxSlippageBps);

    // A real router would refuse rather than fill past the slippage limit, so
    // the simulation refuses too.
    if (cfg.paperBaseSlippageBps + impactBps > request.maxSlippageBps) {
      return {
        ok: false,
        mode: this.mode,
        txSignature: null,
        confirmed: false,
        filledQuantity: 0,
        filledPriceUsd: 0,
        grossUsd: 0,
        feesUsd: 0,
        slippageBps: cfg.paperBaseSlippageBps + impactBps,
        error:
          `Simulated slippage of ${(cfg.paperBaseSlippageBps + impactBps).toFixed(0)}bps ` +
          `exceeds the ${request.maxSlippageBps}bps limit.`,
      };
    }

    // Slippage always works against the trader: buys fill higher, sells lower.
    const slip = bpsToFraction(slippageBps);
    const filledPrice = request.side === 'buy' ? price * (1 + slip) : price * (1 - slip);

    const quantity =
      request.side === 'buy' ? (request.amountUsd ?? 0) / filledPrice : (request.quantity ?? 0);
    const grossUsd = roundUsd(quantity * filledPrice);
    const takerFee = grossUsd * bpsToFraction(cfg.takerFeeBps);
    const feesUsd = roundUsd(takerFee + cfg.networkFeeUsd);

    return {
      ok: true,
      mode: this.mode,
      // A paper trade has no signature, and pretending otherwise would make
      // the trade history lie about what really happened.
      txSignature: null,
      confirmed: true,
      filledQuantity: quantity,
      filledPriceUsd: filledPrice,
      grossUsd,
      feesUsd,
      slippageBps,
      error: null,
      raw: { simulated: true, poolPct, liquidityUsd: liquidity },
    };
  }
}

function failure(mode: 'paper' | 'live', error: string): ExecutionResult {
  return {
    ok: false,
    mode,
    txSignature: null,
    confirmed: false,
    filledQuantity: 0,
    filledPriceUsd: 0,
    grossUsd: 0,
    feesUsd: 0,
    slippageBps: 0,
    error,
  };
}

export { failure };
