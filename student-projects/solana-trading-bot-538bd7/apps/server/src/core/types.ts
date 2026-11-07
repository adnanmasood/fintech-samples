/**
 * Domain types shared across every layer.
 *
 * These are deliberately provider-agnostic: nothing here mentions Solana,
 * Jupiter, DexScreener or any other vendor. Providers translate their own
 * payloads into these shapes at the edge, which is what lets a provider be
 * swapped without touching an agent.
 */

/** The four logical portfolio buckets. The main wallet is divided across them. */
export const BUCKETS = ['copy_trading', 'hot_trading', 'hidden_gems', 'low_market_cap'] as const;
export type BucketId = (typeof BUCKETS)[number];

/** Human labels, used by the API and the dashboard. */
export const BUCKET_LABELS: Record<BucketId, string> = {
  copy_trading: 'Copy Trading',
  hot_trading: 'Hot Trading',
  hidden_gems: 'Hidden Gems',
  low_market_cap: 'Low Market Cap',
};

export const AGENTS = [
  'copy_trade',
  'hidden_gem',
  'hot_trade',
  'small_market_cap',
  'security',
  'social',
] as const;
export type AgentId = (typeof AGENTS)[number];

/** Which bucket each trading agent spends from. Non-trading agents map to null. */
export const AGENT_BUCKET: Record<AgentId, BucketId | null> = {
  copy_trade: 'copy_trading',
  hot_trade: 'hot_trading',
  hidden_gem: 'hidden_gems',
  small_market_cap: 'low_market_cap',
  security: null,
  social: null,
};

export type TradingMode = 'paper' | 'live';

export type SignalAction = 'BUY' | 'SELL' | 'HOLD' | 'IGNORE';

export type Chain = 'solana';

/** A point-in-time market snapshot for one token, normalised across providers. */
export interface TokenMarketSnapshot {
  address: string;
  chain: Chain;
  symbol: string;
  name: string;
  priceUsd: number;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  liquidityUsd: number;
  volume24hUsd: number;
  volume6hUsd: number | null;
  volume1hUsd: number | null;
  volume5mUsd: number | null;
  priceChange5m: number | null;
  priceChange1h: number | null;
  priceChange6h: number | null;
  priceChange24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  pairCreatedAt: number | null;
  pairAddress: string | null;
  dexId: string | null;
  fetchedAt: number;
}

/** On-chain facts about a token that the security agent reasons over. */
export interface TokenOnChainInfo {
  address: string;
  chain: Chain;
  decimals: number | null;
  supply: number | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  updateAuthority: string | null;
  isMutable: boolean | null;
  creator: string | null;
  createdAt: number | null;
  holderCount: number | null;
  /** Fractions of supply held by the largest holders, descending. 0..1 each. */
  topHolderShares: number[];
  /** Fraction of the pool's LP tokens that are burned or locked. 0..1, null when unknown. */
  lpLockedFraction: number | null;
  /** Basis points taken on a buy and on a sell, when the chain exposes them. */
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  transferFeeBps: number | null;
  fetchedAt: number;
}

/** Aggregated social signal for one token. */
export interface SocialSnapshot {
  address: string;
  symbol: string;
  mentions24h: number | null;
  mentionsPrev24h: number | null;
  /** -1 (very negative) .. 1 (very positive), null when no usable data. */
  sentiment: number | null;
  interactions24h: number | null;
  influencerMentions24h: number | null;
  /** 0..1, the share of observed posts that look automated or spammy. */
  spamRatio: number | null;
  /** 0..1, how trustworthy the sources behind this snapshot are. */
  sourceQuality: number | null;
  sources: string[];
  fetchedAt: number;
}

/** One observed swap by a tracked wallet. */
export interface WalletTrade {
  signature: string;
  wallet: string;
  tokenAddress: string;
  side: 'buy' | 'sell';
  amountTokens: number;
  amountUsd: number;
  priceUsd: number | null;
  timestamp: number;
}

/** A scored dimension, always carrying the reason it landed where it did. */
export interface ScoreComponent {
  key: string;
  label: string;
  /** 0..100 */
  score: number;
  /** 0..1, this component's share of the overall score. */
  weight: number;
  /** Plain-language explanation of how the score was reached. */
  reason: string;
  positives: string[];
  risks: string[];
  /** False when the underlying data was missing and a neutral score was used. */
  hasData: boolean;
}

export interface TokenScore {
  address: string;
  chain: Chain;
  agent: AgentId | null;
  /** 0..100 */
  overall: number;
  components: ScoreComponent[];
  positives: string[];
  risks: string[];
  /** 0..1, how much of the weighted score came from real rather than neutral data. */
  dataCoverage: number;
  scoredAt: number;
}

export type SecurityVerdict = 'pass' | 'warn' | 'reject';

export type RiskSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface RiskFlag {
  code: string;
  severity: RiskSeverity;
  message: string;
  /** Values the rule saw, so a decision can be replayed later. */
  evidence?: Record<string, unknown>;
}

export interface SecurityAssessment {
  address: string;
  chain: Chain;
  verdict: SecurityVerdict;
  /** 0..100. A reject can still carry a score; the verdict is what gates. */
  score: number;
  flags: RiskFlag[];
  /** Set when the verdict came from the blacklist or whitelist rather than the rules. */
  listMatch: 'blacklist' | 'whitelist' | null;
  checkedAt: number;
  /** True when a provider was unavailable and the assessment ran on partial data. */
  degraded: boolean;
}

export interface TraderScore {
  wallet: string;
  /** 0..100 */
  overall: number;
  winRate: number | null;
  avgReturnPct: number | null;
  maxDrawdownPct: number | null;
  consistency: number | null;
  tradeCount: number;
  automationLikelihood: number | null;
  flags: RiskFlag[];
  reason: string;
  scoredAt: number;
}

/** What an agent emits. Agents never execute; they only produce these. */
export interface TradeSignal {
  id: string;
  agent: AgentId;
  bucket: BucketId;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string;
  action: SignalAction;
  /** 0..100 */
  score: number;
  /** 0..1 */
  confidence: number;
  entryPriceUsd: number | null;
  targetPriceUsd: number | null;
  stopLossUsd: number | null;
  /** Requested notional in USD. The risk manager may shrink it. */
  requestedSizeUsd: number | null;
  reason: string;
  riskFlags: RiskFlag[];
  /** Free-form agent evidence, persisted for the decision log. */
  metadata: Record<string, unknown>;
  createdAt: number;
}

export type RejectionStage =
  | 'security'
  | 'risk'
  | 'portfolio'
  | 'execution'
  | 'duplicate'
  | 'kill_switch'
  | 'mode';

export interface RiskDecision {
  approved: boolean;
  /** The size the risk manager will allow, in USD. Zero when rejected. */
  approvedSizeUsd: number;
  stage: RejectionStage | null;
  reasons: string[];
  checks: RiskCheckResult[];
}

export interface RiskCheckResult {
  code: string;
  passed: boolean;
  message: string;
  observed?: number;
  limit?: number;
}

export interface Position {
  id: number;
  bucket: BucketId;
  agent: AgentId;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string;
  status: 'open' | 'closed';
  quantity: number;
  avgEntryPriceUsd: number;
  costBasisUsd: number;
  /** Latest mark, and the highest mark seen while open (for the trailing stop). */
  lastMarkPriceUsd: number | null;
  highWaterPriceUsd: number | null;
  stopLossUsd: number | null;
  takeProfitUsd: number | null;
  realizedPnlUsd: number;
  feesUsd: number;
  openedAt: number;
  closedAt: number | null;
}

export type TradeSide = 'buy' | 'sell';

export interface ExecutionRequest {
  signalId: string;
  agent: AgentId;
  bucket: BucketId;
  chain: Chain;
  tokenAddress: string;
  tokenSymbol: string;
  side: TradeSide;
  /** USD notional for a buy; token quantity for a sell. */
  amountUsd: number | null;
  quantity: number | null;
  priceUsd: number;
  maxSlippageBps: number;
  mode: TradingMode;
}

export interface ExecutionResult {
  ok: boolean;
  mode: TradingMode;
  /** Only set once a live transaction is confirmed on chain. */
  txSignature: string | null;
  confirmed: boolean;
  filledQuantity: number;
  filledPriceUsd: number;
  grossUsd: number;
  feesUsd: number;
  slippageBps: number;
  error: string | null;
  raw?: Record<string, unknown>;
}

export interface BucketState {
  bucket: BucketId;
  allocationPct: number;
  allocatedUsd: number;
  /**
   * Raw, unspent cash sitting in the bucket. This is what the risk manager
   * sizes trades against (it subtracts the cash buffer itself); it is not
   * "safe to spend" on its own. `spendableUsd` is that number.
   */
  availableUsd: number;
  /** The `portfolio.cashBufferPct` slice of `availableUsd` held back from new trades. */
  reservedUsd: number;
  /** What is actually free to put into a new trade: `availableUsd - reservedUsd`. */
  spendableUsd: number;
  investedUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  openPositions: number;
}

export interface PortfolioState {
  mode: TradingMode;
  totalValueUsd: number;
  cashUsd: number;
  /** Sum of every bucket's cash buffer. Real equity, just not deployable yet. */
  reservedUsd: number;
  /** `cashUsd - reservedUsd`: what could actually go into a new trade right now. */
  spendableUsd: number;
  investedUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  dailyPnlUsd: number;
  drawdownPct: number;
  openPositions: number;
  buckets: BucketState[];
  asOf: number;
}
