import { HttpClient } from '../http.js';
import type { DexProvider, SwapQuote } from '../interfaces.js';

/**
 * Jupiter.
 *
 * The Solana router. Free and keyless on the lite endpoints, which is enough
 * for quotes, prices and building a swap transaction. Nothing here signs or
 * sends: it returns an unsigned transaction, and only the live executor,
 * holding the wallet, can turn that into a send.
 */

const QUOTE_BASE = 'https://lite-api.jup.ag/swap/v1';
const PRICE_BASE = 'https://lite-api.jup.ag/price/v3';

interface JupQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct?: string;
  slippageBps?: number;
  routePlan?: unknown[];
}

export class JupiterProvider implements DexProvider {
  readonly name = 'jupiter';
  private readonly http: HttpClient;

  constructor() {
    this.http = new HttpClient(this.name, { minIntervalMs: 200, timeoutMs: 15_000, maxRetries: 2 });
  }

  isConfigured(): boolean {
    return true;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const price = await this.getPriceUsd('So11111111111111111111111111111111111111112');
      return price !== null;
    } catch {
      return false;
    }
  }

  async getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<SwapQuote | null> {
    const url =
      `${QUOTE_BASE}/quote?inputMint=${params.inputMint}` +
      `&outputMint=${params.outputMint}` +
      `&amount=${params.amount.toString()}` +
      `&slippageBps=${params.slippageBps}` +
      // Direct routes only would miss most small caps; multi-hop is the norm.
      `&restrictIntermediateTokens=true`;
    try {
      const res = await this.http.getJson<JupQuoteResponse>(url);
      if (!res.outAmount) return null;
      return {
        inputMint: res.inputMint,
        outputMint: res.outputMint,
        inAmount: res.inAmount,
        outAmount: res.outAmount,
        priceImpact: Number(res.priceImpactPct ?? 0),
        slippageBps: res.slippageBps ?? params.slippageBps,
        raw: res,
      };
    } catch {
      return null;
    }
  }

  async buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string> {
    const res = await this.http.postJson<{ swapTransaction?: string }>(`${QUOTE_BASE}/swap`, {
      quoteResponse: quote.raw,
      userPublicKey,
      wrapAndUnwrapSol: true,
      // Let Jupiter size the priority fee against current network conditions,
      // capped so a congested block cannot quietly cost a fortune.
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' } },
    });
    if (!res.swapTransaction) {
      throw new Error('Jupiter returned no swap transaction');
    }
    return res.swapTransaction;
  }

  async getPriceUsd(mint: string): Promise<number | null> {
    try {
      const res = await this.http.getJson<Record<string, { usdPrice?: number }>>(
        `${PRICE_BASE}?ids=${mint}`,
        { cacheTtlMs: 15_000 },
      );
      const price = res[mint]?.usdPrice;
      return typeof price === 'number' && Number.isFinite(price) ? price : null;
    } catch {
      return null;
    }
  }
}
