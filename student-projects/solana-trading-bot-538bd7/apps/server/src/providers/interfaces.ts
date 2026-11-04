import type {
  Chain,
  ExecutionRequest,
  ExecutionResult,
  SocialSnapshot,
  TokenMarketSnapshot,
  TokenOnChainInfo,
  WalletTrade,
} from '../core/types.js';

/**
 * Provider seams.
 *
 * Every outside dependency enters the system through one of these. Nothing
 * above this layer imports a vendor SDK or knows a vendor's URL, so swapping
 * DexScreener for Birdeye, or Jupiter for another router, is a new file in
 * `providers/` and one line in the registry.
 *
 * Every provider must implement `isConfigured()` honestly. The registry uses
 * it to decide whether to wire the real thing or a mock, and the security
 * gate uses it to decide whether to fail closed.
 */

export interface Provider {
  readonly name: string;
  /** False when a required key is missing. Never throws. */
  isConfigured(): boolean;
  /** Cheap reachability check. Used by the health endpoint. */
  healthCheck?(): Promise<boolean>;
}

export interface MarketDataProvider extends Provider {
  /** Latest market snapshot for one token, or null when the token is unknown. */
  getTokenSnapshot(address: string, chain: Chain): Promise<TokenMarketSnapshot | null>;
  /** Batched form. Implementations should use the provider's bulk endpoint. */
  getTokenSnapshots(addresses: string[], chain: Chain): Promise<TokenMarketSnapshot[]>;
  /** Candidate discovery. Terms are provider-specific search strings. */
  searchTokens(terms: string[], chain: Chain, limit: number): Promise<TokenMarketSnapshot[]>;
  /** Recently created pairs, newest first. Used by the small-cap and gem agents. */
  getNewPairs(chain: Chain, limit: number): Promise<TokenMarketSnapshot[]>;
}

export interface TokenSecurityProvider extends Provider {
  /** On-chain facts the security rules reason over. */
  getOnChainInfo(address: string, chain: Chain): Promise<TokenOnChainInfo | null>;
}

export interface BlockchainProvider extends Provider {
  /** Native balance in whole SOL. */
  getNativeBalance(address: string): Promise<number>;
  /** SPL balance in whole tokens. */
  getTokenBalance(owner: string, mint: string): Promise<number>;
  /** Swaps by one wallet, newest first, since `sinceMs`. */
  getWalletTrades(wallet: string, sinceMs: number, limit: number): Promise<WalletTrade[]>;
  /**
   * Wait for a signature to reach a confirmed commitment.
   * Resolves false on timeout or on-chain failure. Never throws on a failed
   * transaction, only on a transport error.
   */
  confirmTransaction(signature: string, timeoutMs: number): Promise<TransactionConfirmation>;
}

export interface TransactionConfirmation {
  confirmed: boolean;
  slot: number | null;
  error: string | null;
}

export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  /** Price impact as a fraction, e.g. 0.012 for 1.2%. */
  priceImpact: number;
  slippageBps: number;
  /** Opaque routing payload handed back to buildSwapTransaction. */
  raw: unknown;
}

export interface DexProvider extends Provider {
  getQuote(params: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
  }): Promise<SwapQuote | null>;
  /** Returns a base64 serialised transaction ready to sign. */
  buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string>;
  /** Price of one token in USD, or null when the router cannot price it. */
  getPriceUsd(mint: string): Promise<number | null>;
}

export interface SocialDataProvider extends Provider {
  /**
   * `name` is optional and provider-specific: a headline-matching provider
   * (the news feed) needs it, because prose almost never uses a bare ticker,
   * while an aggregator with its own per-asset lookup (LunarCrush) ignores it.
   */
  getSocialSnapshot(symbol: string, address: string, name?: string): Promise<SocialSnapshot | null>;
  /** Symbols currently trending, strongest first. */
  getTrending(limit: number): Promise<Array<{ symbol: string; address: string | null }>>;
}

/**
 * The only thing in the system allowed to move value.
 * Agents cannot reach it: they emit signals, and the signal engine calls the
 * execution service, which calls exactly one of these.
 */
export interface TradeExecutor extends Provider {
  readonly mode: 'paper' | 'live';
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

/** Optional. Used only to phrase a decision in plain language, never to decide one. */
export interface LlmProvider extends Provider {
  explain(prompt: string, maxTokens?: number): Promise<string | null>;
}

export interface ProviderRegistry {
  market: MarketDataProvider;
  security: TokenSecurityProvider;
  blockchain: BlockchainProvider;
  dex: DexProvider;
  social: SocialDataProvider;
  llm: LlmProvider;
}
