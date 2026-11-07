import type {
  Chain,
  ExecutionRequest,
  ExecutionResult,
  SocialSnapshot,
  TokenMarketSnapshot,
  TokenOnChainInfo,
  WalletTrade,
} from '../core/types.js';
import type {
  BlockchainProvider,
  DexProvider,
  LlmProvider,
  MarketDataProvider,
  SocialDataProvider,
  SwapQuote,
  TokenSecurityProvider,
  TransactionConfirmation,
} from './interfaces.js';

/**
 * Null-object providers.
 *
 * When a key is missing the registry wires one of these instead of letting a
 * `undefined` provider reach an agent. They answer honestly: `isConfigured()`
 * is false and every call returns empty. That is what makes the security
 * gate's fail-closed rule work, and it is what the tests run against.
 *
 * They are also the seam for a fixture provider: subclass, override one
 * method, and the rest of the system is unchanged.
 */

export class NullMarketProvider implements MarketDataProvider {
  readonly name = 'null-market';
  isConfigured(): boolean {
    return false;
  }
  async getTokenSnapshot(): Promise<TokenMarketSnapshot | null> {
    return null;
  }
  async getTokenSnapshots(): Promise<TokenMarketSnapshot[]> {
    return [];
  }
  async searchTokens(): Promise<TokenMarketSnapshot[]> {
    return [];
  }
  async getNewPairs(): Promise<TokenMarketSnapshot[]> {
    return [];
  }
}

export class NullSecurityProvider implements TokenSecurityProvider {
  readonly name = 'null-security';
  isConfigured(): boolean {
    return false;
  }
  async getOnChainInfo(): Promise<TokenOnChainInfo | null> {
    return null;
  }
}

export class NullBlockchainProvider implements BlockchainProvider {
  readonly name = 'null-blockchain';
  isConfigured(): boolean {
    return false;
  }
  async getNativeBalance(): Promise<number> {
    return 0;
  }
  async getTokenBalance(): Promise<number> {
    return 0;
  }
  async getWalletTrades(): Promise<WalletTrade[]> {
    return [];
  }
  async confirmTransaction(): Promise<TransactionConfirmation> {
    return { confirmed: false, slot: null, error: 'no blockchain provider configured' };
  }
}

export class NullDexProvider implements DexProvider {
  readonly name = 'null-dex';
  isConfigured(): boolean {
    return false;
  }
  async getQuote(): Promise<SwapQuote | null> {
    return null;
  }
  async buildSwapTransaction(): Promise<string> {
    throw new Error('no DEX provider configured');
  }
  async getPriceUsd(): Promise<number | null> {
    return null;
  }
}

export class NullSocialProvider implements SocialDataProvider {
  readonly name = 'null-social';
  isConfigured(): boolean {
    return false;
  }
  async getSocialSnapshot(): Promise<SocialSnapshot | null> {
    return null;
  }
  async getTrending(): Promise<Array<{ symbol: string; address: string | null }>> {
    return [];
  }
}

export class NullLlmProvider implements LlmProvider {
  readonly name = 'null-llm';
  isConfigured(): boolean {
    return false;
  }
  async explain(): Promise<string | null> {
    return null;
  }
}

/**
 * A market provider backed by a fixed table. The integration tests drive the
 * whole pipeline through this, so a full run needs no network at all.
 */
export class StaticMarketProvider implements MarketDataProvider {
  readonly name = 'static-market';
  constructor(private snapshots: TokenMarketSnapshot[] = []) {}

  setSnapshots(snapshots: TokenMarketSnapshot[]): void {
    this.snapshots = snapshots;
  }

  isConfigured(): boolean {
    return true;
  }

  async getTokenSnapshot(address: string): Promise<TokenMarketSnapshot | null> {
    return this.snapshots.find((s) => s.address === address) ?? null;
  }

  async getTokenSnapshots(addresses: string[]): Promise<TokenMarketSnapshot[]> {
    const wanted = new Set(addresses);
    return this.snapshots.filter((s) => wanted.has(s.address));
  }

  async searchTokens(_terms: string[], _chain: Chain, limit: number): Promise<TokenMarketSnapshot[]> {
    return this.snapshots.slice(0, limit);
  }

  async getNewPairs(_chain: Chain, limit: number): Promise<TokenMarketSnapshot[]> {
    return [...this.snapshots]
      .sort((a, b) => (b.pairCreatedAt ?? 0) - (a.pairCreatedAt ?? 0))
      .slice(0, limit);
  }
}

/** Records what it was asked to execute. Used by the execution tests. */
export class RecordingExecutor {
  readonly name = 'recording-executor';
  readonly mode = 'paper' as const;
  readonly calls: ExecutionRequest[] = [];
  constructor(private readonly result: (req: ExecutionRequest) => ExecutionResult) {}
  isConfigured(): boolean {
    return true;
  }
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    return this.result(request);
  }
}
