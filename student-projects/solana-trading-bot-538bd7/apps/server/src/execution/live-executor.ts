import { VersionedTransaction } from '@solana/web3.js';
import { getEnv } from '../config/env.js';
import type { ConfigService } from '../config/config-service.js';
import { roundUsd } from '../core/money.js';
import { SafetyError } from '../core/errors.js';
import type { ExecutionRequest, ExecutionResult } from '../core/types.js';
import type { Db } from '../db/client.js';
import { transactions } from '../db/schema.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { BlockchainProvider, DexProvider, TradeExecutor } from '../providers/interfaces.js';
import type { WalletService } from '../wallet/wallet-service.js';
import { failure } from './paper-executor.js';
import { eq } from 'drizzle-orm';

/**
 * Live executor.
 *
 * The single component in the system that can move real value, and it is
 * written to be boring: quote, size, sign, send, then wait for the chain to
 * agree before it reports anything as done.
 *
 * The rule that shapes the whole class: a trade is not successful until the
 * transaction is confirmed. A submitted-but-unconfirmed send returns `ok:
 * false` with the signature recorded, so the position is never opened on a
 * transaction that may still fail.
 */
export class LiveExecutor implements TradeExecutor {
  readonly name = 'live-executor';
  readonly mode = 'live' as const;

  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly dex: DexProvider,
    private readonly blockchain: BlockchainProvider,
    private readonly wallet: WalletService,
    private readonly log: DecisionLog,
  ) {}

  isConfigured(): boolean {
    return this.wallet.isAvailable() && this.dex.isConfigured() && this.blockchain.isConfigured();
  }

  /** Everything that must be true before a real order can be sent. */
  preflight(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    if (getEnv().LIVE_TRADING_OPT_IN !== 'I_ACCEPT_REAL_FINANCIAL_RISK') {
      problems.push('Live trading is disabled by the server operator opt-in.');
    }
    if (this.config.get().mode !== 'live') problems.push('Configuration is not set to live mode.');
    if (!this.wallet.isAvailable()) {
      problems.push(this.wallet.error() ?? 'No wallet private key is configured.');
    }
    if (!this.blockchain.isConfigured()) problems.push('No blockchain provider is configured.');
    if (this.config.get().risk.killSwitch) problems.push('The kill switch is engaged.');
    return { ok: problems.length === 0, problems };
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const pre = this.preflight();
    if (!pre.ok) {
      // Refusing here is the last safety net. Nothing is sent.
      throw new SafetyError(`Live execution refused: ${pre.problems.join(' ')}`, {
        problems: pre.problems,
      });
    }

    const cfg = this.config.get().execution;
    const owner = this.wallet.publicKey();
    if (!owner) throw new SafetyError('Wallet is unavailable.');

    const quoteMint = cfg.quoteMint;
    const inputMint = request.side === 'buy' ? quoteMint : request.tokenAddress;
    const outputMint = request.side === 'buy' ? request.tokenAddress : quoteMint;

    // Size the input leg in base units.
    const amount = await this.resolveInputAmount(request, inputMint);
    if (amount === null || amount <= 0n) {
      return failure(this.mode, 'Could not size the order in base units.');
    }

    const quote = await this.dex.getQuote({
      inputMint,
      outputMint,
      amount,
      slippageBps: request.maxSlippageBps,
    });
    if (!quote) {
      return failure(this.mode, 'No route available for this pair at the requested size.');
    }

    // The router's own impact estimate is a second slippage gate, independent
    // of the one it was asked to enforce.
    const impactBps = Math.abs(quote.priceImpact) * 10_000;
    if (impactBps > request.maxSlippageBps) {
      return {
        ...failure(this.mode, `Route price impact of ${impactBps.toFixed(0)}bps exceeds the ${request.maxSlippageBps}bps limit.`),
        slippageBps: impactBps,
      };
    }

    let lastError = 'Execution did not complete.';
    for (let attempt = 0; attempt <= cfg.liveMaxRetries; attempt += 1) {
      const txRow = this.db
        .insert(transactions)
        .values({
          signalId: request.signalId,
          chain: request.chain,
          status: 'submitted',
          submittedAt: Date.now(),
        })
        .returning({ id: transactions.id })
        .get();

      try {
        const serialised = await this.dex.buildSwapTransaction(quote, owner);
        const tx = VersionedTransaction.deserialize(Buffer.from(serialised, 'base64'));
        this.wallet.withSigner((keypair) => tx.sign([keypair]));

        const signature = await this.sendRaw(tx.serialize());
        this.db
          .update(transactions)
          .set({ signature, status: 'submitted' })
          .where(eq(transactions.id, txRow.id))
          .run();

        this.log.record({
          category: 'execution',
          signalId: request.signalId,
          tokenAddress: request.tokenAddress,
          message: `Submitted ${request.side} of ${request.tokenSymbol}, waiting for confirmation.`,
          payload: { signature },
        });

        // Nothing is reported as filled until the chain says so.
        const confirmation = await this.blockchain.confirmTransaction(
          signature,
          cfg.liveConfirmTimeoutSec * 1_000,
        );

        if (!confirmation.confirmed) {
          this.db
            .update(transactions)
            .set({
              status: confirmation.error === 'confirmation timeout' ? 'timeout' : 'failed',
              error: confirmation.error,
              confirmedAt: Date.now(),
            })
            .where(eq(transactions.id, txRow.id))
            .run();
          lastError = confirmation.error ?? 'Transaction was not confirmed.';
          // A timeout is not retried: the first transaction may still land,
          // and sending a second would risk buying the same thing twice.
          if (confirmation.error === 'confirmation timeout') {
            return { ...failure(this.mode, lastError), txSignature: signature };
          }
          continue;
        }

        this.db
          .update(transactions)
          .set({ status: 'confirmed', slot: confirmation.slot, confirmedAt: Date.now() })
          .where(eq(transactions.id, txRow.id))
          .run();

        return this.resultFromQuote(request, quote, signature, impactBps);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.db
          .update(transactions)
          .set({ status: 'failed', error: lastError, confirmedAt: Date.now() })
          .where(eq(transactions.id, txRow.id))
          .run();
      }
    }

    return failure(this.mode, lastError);
  }

  /** Convert the requested USD or token amount into the input mint's base units. */
  private async resolveInputAmount(
    request: ExecutionRequest,
    inputMint: string,
  ): Promise<bigint | null> {
    if (request.side === 'sell') {
      const quantity = request.quantity ?? 0;
      if (quantity <= 0) return null;
      const decimals = await this.tokenDecimals(request.tokenAddress);
      if (decimals === null) return null;
      return BigInt(Math.floor(quantity * 10 ** decimals));
    }

    const usd = request.amountUsd ?? 0;
    if (usd <= 0) return null;
    const quotePrice = await this.dex.getPriceUsd(inputMint);
    if (!quotePrice || quotePrice <= 0) return null;
    // The quote mint is wrapped SOL by default, which has nine decimals.
    const decimals = await this.tokenDecimals(inputMint);
    if (decimals === null) return null;
    return BigInt(Math.floor((usd / quotePrice) * 10 ** decimals));
  }

  private readonly decimalsCache = new Map<string, number>();

  private async tokenDecimals(mint: string): Promise<number | null> {
    const cached = this.decimalsCache.get(mint);
    if (cached != null) return cached;
    // Wrapped SOL is fixed and worth short-circuiting.
    if (mint === 'So11111111111111111111111111111111111111112') {
      this.decimalsCache.set(mint, 9);
      return 9;
    }
    const security = this.blockchain as unknown as {
      getOnChainInfo?: (address: string, chain: 'solana') => Promise<{ decimals: number | null } | null>;
    };
    if (typeof security.getOnChainInfo === 'function') {
      const info = await security.getOnChainInfo(mint, 'solana').catch(() => null);
      if (info?.decimals != null) {
        this.decimalsCache.set(mint, info.decimals);
        return info.decimals;
      }
    }
    return null;
  }

  private async sendRaw(raw: Uint8Array): Promise<string> {
    const env = getEnv();
    const res = await fetch(env.SOLANA_RPC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.SOLANA_RPC_API_KEY ? { 'x-api-key': env.SOLANA_RPC_API_KEY } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'send',
        method: 'sendTransaction',
        params: [
          Buffer.from(raw).toString('base64'),
          // Preflight catches a doomed transaction before it costs a fee.
          { encoding: 'base64', skipPreflight: false, maxRetries: 2 },
        ],
      }),
    });
    const body = (await res.json()) as { result?: string; error?: { message?: string } };
    if (body.error) throw new Error(body.error.message ?? 'RPC rejected the transaction');
    if (!body.result) throw new Error('RPC returned no signature');
    return body.result;
  }

  private async resultFromQuote(
    request: ExecutionRequest,
    quote: { inAmount: string; outAmount: string },
    signature: string,
    impactBps: number,
  ): Promise<ExecutionResult> {
    const decimals = await this.tokenDecimals(request.tokenAddress);
    const outUnits = Number(quote.outAmount);
    const inUnits = Number(quote.inAmount);

    let filledQuantity: number;
    let grossUsd: number;

    if (request.side === 'buy') {
      filledQuantity = decimals != null ? outUnits / 10 ** decimals : 0;
      grossUsd = request.amountUsd ?? 0;
    } else {
      filledQuantity = request.quantity ?? 0;
      const quotePrice = await this.dex.getPriceUsd(this.config.get().execution.quoteMint);
      grossUsd = quotePrice ? (outUnits / 10 ** 9) * quotePrice : 0;
    }

    const filledPriceUsd = filledQuantity > 0 ? grossUsd / filledQuantity : 0;

    return {
      ok: true,
      mode: this.mode,
      txSignature: signature,
      confirmed: true,
      filledQuantity,
      filledPriceUsd,
      grossUsd: roundUsd(grossUsd),
      // Network fees on Solana are small but real; the config value stands in
      // until the confirmed transaction's own fee is read back.
      feesUsd: roundUsd(this.config.get().execution.networkFeeUsd),
      slippageBps: impactBps,
      error: null,
      raw: { inAmount: quote.inAmount, outAmount: quote.outAmount, inUnits },
    };
  }
}
