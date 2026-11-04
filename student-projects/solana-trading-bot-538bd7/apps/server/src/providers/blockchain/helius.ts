import type { Chain, TokenOnChainInfo, WalletTrade } from '../../core/types.js';
import { HttpClient } from '../http.js';
import type {
  BlockchainProvider,
  TokenSecurityProvider,
  TransactionConfirmation,
} from '../interfaces.js';
import { sleep } from '../http.js';

/**
 * Helius.
 *
 * One vendor covers two seams here: the DAS API gives the token metadata and
 * authorities the security agent needs, and the enhanced-transactions API
 * gives parsed swaps for the copy-trade agent. Both are on the free tier.
 *
 * When no key is present every method returns empty rather than throwing, and
 * `isConfigured()` reports false so the security gate can fail closed.
 */

interface DasAsset {
  id: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  authorities?: Array<{ address: string; scopes?: string[] }>;
  mutable?: boolean;
  ownership?: { owner?: string };
  creators?: Array<{ address: string; verified?: boolean }>;
  token_info?: {
    decimals?: number;
    supply?: number;
    mint_authority?: string | null;
    freeze_authority?: string | null;
  };
}

interface HeliusTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  mint?: string;
  tokenAmount?: number;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount?: number | string;
}

/** Per-account net effect of a transaction. The authoritative SOL delta. */
interface HeliusAccountData {
  account?: string;
  nativeBalanceChange?: number | string;
}

interface HeliusTx {
  signature: string;
  timestamp: number;
  type?: string;
  tokenTransfers?: HeliusTransfer[];
  nativeTransfers?: HeliusNativeTransfer[];
  accountData?: HeliusAccountData[];
  events?: {
    swap?: {
      tokenInputs?: Array<{ mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
      tokenOutputs?: Array<{ mint?: string; rawTokenAmount?: { tokenAmount?: string; decimals?: number } }>;
      nativeInput?: { amount?: string };
      nativeOutput?: { amount?: string };
    };
  };
}

const LAMPORTS_PER_SOL = 1_000_000_000;
/** Wrapped SOL is the quote side of a swap, never the asset being traded. */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export class HeliusProvider implements BlockchainProvider, TokenSecurityProvider {
  readonly name = 'helius';
  private readonly http: HttpClient;
  private readonly rpc: HttpClient;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly rpcUrl: string,
    private readonly rpcApiKey: string | undefined,
    /** Injected so the copy agent can price a swap without a second vendor. */
    private readonly solPriceUsd: () => Promise<number | null>,
  ) {
    this.http = new HttpClient(this.name, { minIntervalMs: 120, cacheTtlMs: 30_000 });
    this.rpc = new HttpClient(`${this.name}-rpc`, {
      minIntervalMs: 80,
      headers: rpcApiKey ? { 'x-api-key': rpcApiKey } : {},
    });
  }

  isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  private dasUrl(): string {
    return `https://mainnet.helius-rpc.com/?api-key=${this.apiKey}`;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await this.http.postJson(this.dasUrl(), {
        jsonrpc: '2.0',
        id: 'health',
        method: 'getAsset',
        params: { id: 'So11111111111111111111111111111111111111112' },
      });
      return true;
    } catch {
      return false;
    }
  }

  async getOnChainInfo(address: string, chain: Chain): Promise<TokenOnChainInfo | null> {
    if (!this.isConfigured()) return null;
    let asset: DasAsset | null = null;
    try {
      const res = await this.http.postJson<{ result?: DasAsset }>(this.dasUrl(), {
        jsonrpc: '2.0',
        id: 'asset',
        method: 'getAsset',
        params: { id: address },
      });
      asset = res.result ?? null;
    } catch {
      return null;
    }
    if (!asset) return null;

    const topHolderShares = await this.getTopHolderShares(address, asset.token_info?.supply ?? null);
    const updateAuthority =
      asset.authorities?.find((a) => a.scopes?.includes('full') || a.scopes?.includes('metadata'))
        ?.address ?? null;

    return {
      address,
      chain,
      decimals: asset.token_info?.decimals ?? null,
      supply: asset.token_info?.supply ?? null,
      mintAuthority: asset.token_info?.mint_authority ?? null,
      freezeAuthority: asset.token_info?.freeze_authority ?? null,
      updateAuthority,
      isMutable: asset.mutable ?? null,
      creator: asset.creators?.[0]?.address ?? null,
      createdAt: null,
      holderCount: null,
      topHolderShares,
      // Helius does not expose LP lock state; a dedicated provider can fill
      // this in later without touching the security rules.
      lpLockedFraction: null,
      buyTaxBps: null,
      sellTaxBps: null,
      transferFeeBps: null,
      fetchedAt: Date.now(),
    };
  }

  /**
   * Largest holders as fractions of supply, descending. Empty when unknown.
   *
   * Deliberately called against the Helius endpoint (`this.http`, the same one
   * `getAsset` uses) rather than the generic `rpcUrl`: a plain third-party RPC
   * gateway (Tatum's, in particular) has been observed returning "Invalid
   * response from upstream" for this exact method even though it answers
   * every other call fine. Helius runs full validators behind the same URL
   * the DAS calls already use, so this one query rides along for free.
   */
  private async getTopHolderShares(mint: string, supply: number | null): Promise<number[]> {
    if (!supply || supply <= 0) return [];
    try {
      const res = await this.http.postJson<{
        result?: { value?: Array<{ amount?: string; uiAmount?: number }> };
      }>(this.dasUrl(), {
        jsonrpc: '2.0',
        id: 'largest',
        method: 'getTokenLargestAccounts',
        params: [mint],
      });
      const accounts = res.result?.value ?? [];
      return accounts
        .map((a) => Number(a.amount ?? 0) / supply)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);
    } catch {
      return [];
    }
  }

  /**
   * A balance query, against whichever endpoint will actually answer it.
   *
   * Two traps live here, and both of them used to end in a silent zero. The
   * first is the endpoint: a third-party gateway (Tatum's free tier, which is
   * what `rpcUrl` often points at) refuses `getBalance` and
   * `getTokenAccountsByOwner` as paid-plan methods, so these ride the Helius
   * URL the DAS calls already use, exactly as `getTokenLargestAccounts` does.
   *
   * The second is the shape of the refusal: it comes back as HTTP 200 with a
   * JSON-RPC `error` body and no `result`. Reading `result?.value ?? 0` turns
   * that into a confident "you have 0 SOL", which is worse than an error —
   * the dashboard shows an empty wallet and live trading sizes every order
   * against nothing. So a JSON-RPC error is raised, never defaulted.
   */
  private async balanceRpc<T>(id: string, method: string, params: unknown[]): Promise<T> {
    const url = this.isConfigured() ? this.dasUrl() : this.rpcUrl;
    const res = await this.rpc.postJson<{ result?: T; error?: { message?: string } }>(url, {
      jsonrpc: '2.0',
      id,
      method,
      params,
    });
    if (res.error) {
      throw new Error(`${method} was refused by the RPC endpoint: ${res.error.message ?? 'no reason given'}`);
    }
    if (res.result === undefined) {
      throw new Error(`${method} returned no result.`);
    }
    return res.result;
  }

  async getNativeBalance(address: string): Promise<number> {
    const result = await this.balanceRpc<{ value?: number }>('bal', 'getBalance', [address]);
    return (result.value ?? 0) / LAMPORTS_PER_SOL;
  }

  async getTokenBalance(owner: string, mint: string): Promise<number> {
    const result = await this.balanceRpc<{
      value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }>;
    }>('tokbal', 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
    const accounts = result.value ?? [];
    return accounts.reduce(
      (acc, a) => acc + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0),
      0,
    );
  }

  async getWalletTrades(wallet: string, sinceMs: number, limit: number): Promise<WalletTrade[]> {
    if (!this.isConfigured()) return [];
    let txs: HeliusTx[] = [];
    try {
      txs = await this.http.getJson<HeliusTx[]>(
        `https://api.helius.xyz/v0/addresses/${wallet}/transactions?api-key=${this.apiKey}&type=SWAP&limit=${Math.min(100, limit)}`,
        { cacheTtlMs: 15_000 },
      );
    } catch {
      return [];
    }
    const solPrice = (await this.solPriceUsd()) ?? 0;
    const out: WalletTrade[] = [];

    for (const tx of txs) {
      const timestamp = (tx.timestamp ?? 0) * 1000;
      if (timestamp < sinceMs) continue;
      const swap = tx.events?.swap;
      if (!swap) {
        // Helius only fills in `events.swap` for the venues it decodes.
        // Pump.fun, Pump AMM and the OKX router arrive with `events` as an
        // empty object, so relying on it alone silently drops every trade a
        // memecoin wallet makes — which is most of what a copy-trade leader
        // does. The raw transfer arrays are always present, so fall back to
        // reading the legs straight out of them.
        const derived = tradeFromTransfers(tx, wallet, solPrice, timestamp);
        if (derived) out.push(derived);
        continue;
      }

      // A swap that spends SOL and receives a token is a buy of that token.
      // A swap that spends a token and receives SOL is a sell of it.
      const nativeIn = Number(swap.nativeInput?.amount ?? 0) / LAMPORTS_PER_SOL;
      const nativeOut = Number(swap.nativeOutput?.amount ?? 0) / LAMPORTS_PER_SOL;
      const tokenOut = swap.tokenOutputs?.[0];
      const tokenIn = swap.tokenInputs?.[0];

      if (nativeIn > 0 && tokenOut?.mint) {
        const qty = rawToUi(tokenOut.rawTokenAmount);
        const usd = nativeIn * solPrice;
        out.push({
          signature: tx.signature,
          wallet,
          tokenAddress: tokenOut.mint,
          side: 'buy',
          amountTokens: qty,
          amountUsd: usd,
          priceUsd: qty > 0 ? usd / qty : null,
          timestamp,
        });
      } else if (nativeOut > 0 && tokenIn?.mint) {
        const qty = rawToUi(tokenIn.rawTokenAmount);
        const usd = nativeOut * solPrice;
        out.push({
          signature: tx.signature,
          wallet,
          tokenAddress: tokenIn.mint,
          side: 'sell',
          amountTokens: qty,
          amountUsd: usd,
          priceUsd: qty > 0 ? usd / qty : null,
          timestamp,
        });
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async confirmTransaction(signature: string, timeoutMs: number): Promise<TransactionConfirmation> {
    const deadline = Date.now() + timeoutMs;
    // Poll rather than subscribe: the RPC gateway may not carry websockets,
    // and a poll is honest about the timeout.
    while (Date.now() < deadline) {
      try {
        const res = await this.rpc.postJson<{
          result?: {
            value?: Array<{
              slot?: number;
              confirmationStatus?: string;
              err?: unknown;
            } | null>;
          };
        }>(this.rpcUrl, {
          jsonrpc: '2.0',
          id: 'sig',
          method: 'getSignatureStatuses',
          params: [[signature], { searchTransactionHistory: true }],
        });
        const status = res.result?.value?.[0];
        if (status) {
          if (status.err) {
            return { confirmed: false, slot: status.slot ?? null, error: JSON.stringify(status.err) };
          }
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            return { confirmed: true, slot: status.slot ?? null, error: null };
          }
        }
      } catch {
        // Transport blip: keep polling until the deadline.
      }
      await sleep(1_500);
    }
    return { confirmed: false, slot: null, error: 'confirmation timeout' };
  }
}

/**
 * Reconstruct a swap for the venues Helius does not decode into `events.swap`.
 *
 * The SOL leg comes from the wallet's own `nativeBalanceChange`, not from
 * `nativeTransfers`. That distinction is the whole reason this function
 * exists twice: on a pump.fun *sell* the proceeds never appear as an incoming
 * native transfer at all — the wallet's balance simply goes up. Reading the
 * transfer list instead reported a 0.498 SOL sale as 0.002 SOL, which turned
 * a flat wallet into an apparent 92% loser.
 *
 * The balance delta is also the more honest number for scoring: it is net of
 * priority fees, platform fees and account rent, so it is what the wallet
 * actually gained or lost rather than the headline trade size.
 *
 * Wrapped SOL is skipped as a token leg — it is the quote side of the swap,
 * not the asset being traded.
 */
function tradeFromTransfers(
  tx: HeliusTx,
  wallet: string,
  solPrice: number,
  timestamp: number,
): WalletTrade | null {
  const delta = Number(
    (tx.accountData ?? []).find((a) => a.account === wallet)?.nativeBalanceChange ?? 0,
  );
  if (!Number.isFinite(delta) || delta === 0) return null;

  // Spent SOL: a buy. Received SOL: a sell.
  const buying = delta < 0;
  const sol = Math.abs(delta) / LAMPORTS_PER_SOL;

  const tokens = (tx.tokenTransfers ?? []).filter((t) => t.mint && t.mint !== WSOL_MINT);
  const leg = buying
    ? tokens.find((t) => t.toUserAccount === wallet)
    : tokens.find((t) => t.fromUserAccount === wallet);
  if (!leg?.mint) return null;

  const quantity = Math.abs(Number(leg.tokenAmount) || 0);
  const amountUsd = sol * solPrice;

  return {
    signature: tx.signature,
    wallet,
    tokenAddress: leg.mint,
    side: buying ? 'buy' : 'sell',
    amountTokens: quantity,
    amountUsd,
    priceUsd: quantity > 0 ? amountUsd / quantity : null,
    timestamp,
  };
}

function rawToUi(raw: { tokenAmount?: string; decimals?: number } | undefined): number {
  if (!raw?.tokenAmount) return 0;
  const decimals = raw.decimals ?? 0;
  const value = Number(raw.tokenAmount);
  if (!Number.isFinite(value)) return 0;
  return value / 10 ** decimals;
}
