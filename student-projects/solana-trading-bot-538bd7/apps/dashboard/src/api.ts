/**
 * The API client.
 *
 * One place that knows how to talk to the server, so a route change is a
 * one-line edit rather than a hunt through components.
 */
const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only declare a JSON body when there actually is one. Fastify rejects a
  // bodyless request that claims content-type: application/json, which is
  // every POST and DELETE that takes no arguments.
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) };
  if (init?.body != null) headers['content-type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed with ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => request<Status>('/status'),
  portfolio: () => request<Portfolio>('/portfolio'),
  positions: () => request<PositionRow[]>('/portfolio/positions'),
  agents: () => request<AgentRow[]>('/agents'),
  tokens: () => request<TokenRow[]>('/tokens?limit=120'),
  trades: () => request<TradeRow[]>('/trades?limit=150'),
  tradeSummary: () => request<TradeSummary>('/trades/summary'),
  events: (limit = 120) => request<EventRow[]>(`/events?limit=${limit}`),
  config: () => request<ConfigResponse>('/config'),
  lists: () => request<{ blacklist: ListEntry[]; whitelist: ListEntry[] }>('/lists'),
  activity: (kind?: 'http' | 'log') =>
    request<ActivityResponse>(`/activity?limit=250${kind ? `&kind=${kind}` : ''}`),
  clearActivity: () => request<{ ok: boolean }>('/activity', { method: 'DELETE' }),
  wallet: (refresh = false) => request<Wallet>(`/wallet${refresh ? '?refresh=true' : ''}`),
  agentRuns: (id: string) => request<AgentRun[]>(`/agents/${id}/runs`),
  social: () => request<SocialCatch[]>('/social?limit=24'),
  signals: () => request<SignalRow[]>('/signals?limit=60'),

  patchConfig: (patch: unknown) =>
    request<{ config: TradingConfig }>('/config', { method: 'PATCH', body: JSON.stringify(patch) }),
  setAllocations: (allocations: Allocations) =>
    request<Portfolio>('/portfolio/allocations', { method: 'PUT', body: JSON.stringify(allocations) }),
  setKillSwitch: (engaged: boolean) =>
    request<{ killSwitch: boolean }>('/control/kill-switch', {
      method: 'POST', body: JSON.stringify({ engaged }),
    }),
  setMode: (mode: 'paper' | 'live') =>
    request<{
      requestedMode: string; effectiveMode: string; ready: boolean; blockers: string[];
      funded: { source: 'wallet' | 'paper'; balanceUsd: number; solBalance: number | null } | null;
    }>('/control/mode', { method: 'POST', body: JSON.stringify({ mode }) }),
  saveWalletKey: (privateKey: string) =>
    request<Wallet>('/wallet/key', { method: 'PUT', body: JSON.stringify({ privateKey }) }),
  removeWalletKey: () => request<Wallet>('/wallet/key', { method: 'DELETE' }),
  closeAll: (reason: string) =>
    request<{ closed: number }>('/control/close-all', { method: 'POST', body: JSON.stringify({ reason }) }),
  runAgent: (id: string) => request<{ ok: boolean; message: string }>(`/agents/${id}/run`, { method: 'POST' }),
  fund: (amountUsd: number) =>
    request<Portfolio>('/portfolio/fund', { method: 'POST', body: JSON.stringify({ amountUsd }) }),
  addToList: (list: 'blacklist' | 'whitelist', tokenAddress: string, reason: string) =>
    request<unknown>(`/lists/${list}`, { method: 'POST', body: JSON.stringify({ tokenAddress, reason }) }),
  removeFromList: (list: 'blacklist' | 'whitelist', address: string) =>
    request<unknown>(`/lists/${list}/${address}`, { method: 'DELETE' }),
};

export type BucketId = 'copy_trading' | 'hot_trading' | 'hidden_gems' | 'low_market_cap';
export type Allocations = Record<BucketId, number>;

export interface WalletBalance {
  address: string | null;
  solBalance: number | null;
  solPriceUsd: number | null;
  balanceUsd: number | null;
  fetchedAt: number | null;
  error: string | null;
}

export interface Wallet {
  configured: boolean;
  /** The public address. The private key is never sent back by the server. */
  address: string | null;
  /** 'settings' when saved from this dashboard, 'env' when it came from .env. */
  source: 'settings' | 'env' | null;
  error: string | null;
  balance: WalletBalance;
}

export interface Status {
  mode: 'paper' | 'live';
  configuredMode: 'paper' | 'live';
  liveReady: boolean;
  liveBlockers: string[];
  killSwitch: boolean;
  wallet: Wallet;
  providers: Array<{ name: string; role: string; configured: boolean; reachable: boolean | null }>;
  tokensTracked: number;
  scheduler: Array<{
    name: string; enabled: boolean; running: boolean; intervalMs: number;
    lastRunAt: number | null; nextRunAt: number | null; lastError: string | null; skippedCount: number;
  }>;
  appVersion: string;
  startedAt: number;
  configVersion: number;
}

export interface BucketState {
  bucket: BucketId;
  allocationPct: number;
  allocatedUsd: number;
  /** Raw bucket cash. Not all of it is spendable — see `spendableUsd`. */
  availableUsd: number;
  reservedUsd: number;
  spendableUsd: number;
  investedUsd: number;
  unrealizedPnlUsd: number;
  realizedPnlUsd: number;
  openPositions: number;
}

export interface Portfolio {
  mode: 'paper' | 'live';
  totalValueUsd: number;
  cashUsd: number;
  reservedUsd: number;
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

export interface PositionRow {
  id: number; bucket: BucketId; agent: string; tokenAddress: string; tokenSymbol: string;
  quantity: number; avgEntryPriceUsd: number; costBasisUsd: number;
  stopLossUsd: number | null; takeProfitUsd: number | null;
  markPriceUsd: number; valueUsd: number; unrealizedPnlUsd: number; unrealizedPnlPct: number;
  openedAt: number;
}

export interface AgentRow {
  id: string; bucket: BucketId | null; enabled: boolean; running: boolean; intervalSec: number;
  lastRunAt: number | null; lastDurationMs: number | null; nextRunAt: number | null;
  lastStatus: string | null; lastError: string | null;
  signalsGenerated: number; tokensScanned: number; rejected: number;
  avgScore: number | null; skippedRuns: number;
  /** True when this agent's own required provider is missing, so it cannot run at all. */
  degraded: boolean;
  degradedReason: string | null;
}

/**
 * A candidate that made it past an agent's own screen and became a proposal.
 * `rejectionStage` says which gate turned it away; null means it went through.
 */
export interface SignalRow {
  id: string;
  agent: string;
  tokenSymbol: string;
  tokenAddress: string;
  action: string;
  score: number;
  confidence: number;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
  rejectionStage:
    | 'security' | 'risk' | 'portfolio' | 'execution'
    | 'duplicate' | 'kill_switch' | 'mode' | null;
  rejectionReason: string | null;
  reason: string;
  createdAt: number;
  resolvedAt: number | null;
}

/** One token the social agent scored. All five scores are 0-100. */
export interface SocialCatch {
  tokenAddress: string;
  symbol: string;
  mentionScore: number;
  sentimentScore: number;
  trendScore: number;
  sourceQualityScore: number;
  spamScore: number;
  fetchedAt: number;
}

/** One scheduled or hand-triggered scan, newest first from /agents/:id/runs. */
export interface AgentRun {
  id: number;
  agent: string;
  status: 'running' | 'ok' | 'error' | 'skipped';
  startedAt: number;
  finishedAt: number | null;
  durationMs: number | null;
  tokensScanned: number;
  signalsGenerated: number;
  tradesExecuted: number;
  rejected: number;
  avgScore: number | null;
  error: string | null;
}

export interface TokenRow {
  address: string; symbol: string; name: string;
  priceUsd: number | null; marketCapUsd: number | null; liquidityUsd: number | null;
  volume24hUsd: number | null; priceChange24h: number | null;
  overallScore: number | null; scoringAgent: string | null;
  securityScore: number | null; securityVerdict: string | null; socialScore: number | null;
  riskFlags: Array<{ code: string; severity: string; message: string }>;
  blacklisted: boolean; whitelisted: boolean; lastSeenAt: number;
}

export interface TradeRow {
  id: number; bucket: BucketId; agent: string; mode: string;
  tokenSymbol: string; tokenAddress: string; side: 'buy' | 'sell';
  quantity: number; priceUsd: number; grossUsd: number; feesUsd: number;
  realizedPnlUsd: number; score: number | null; reason: string; executedAt: number;
}

export interface TradeSummary {
  totalTrades: number; buys: number; sells: number;
  closedWins: number; closedLosses: number; winRate: number | null;
  realizedPnlUsd: number; feesUsd: number; profitFactor: number | null;
  avgWinUsd: number | null; avgLossUsd: number | null;
}

export interface EventRow {
  id: number; level: string; category: string; agent: string | null;
  tokenAddress: string | null; signalId: string | null;
  message: string; payload: Record<string, unknown> | null; createdAt: number;
}

export interface HttpActivity {
  id: number; kind: 'http'; at: number; provider: string; method: string;
  url: string; host: string; path: string; status: number | null;
  durationMs: number; cached: boolean; ok: boolean; error: string | null; attempt: number;
}

export interface LogActivity {
  id: number; kind: 'log'; at: number; level: string;
  message: string; context: Record<string, unknown> | null;
}

export type ActivityEntry = HttpActivity | LogActivity;

export interface ActivityResponse {
  entries: ActivityEntry[];
  stats: Array<{ provider: string; calls: number; cached: number; errors: number; avgMs: number; lastAt: number | null }>;
  buffered: number;
}

export interface ListEntry {
  tokenAddress: string; symbol: string; reason: string; source: string; createdAt: number;
}

export interface TradingConfig {
  version: number;
  mode: 'paper' | 'live';
  portfolio: { paperStartingBalanceUsd: number; allocations: Allocations; cashBufferPct: number; markToMarketSec: number };
  risk: Record<string, number | boolean>;
  security: Record<string, number | boolean | string>;
  execution: Record<string, number | string>;
  agents: Record<string, Record<string, unknown>>;
  lists: { blacklist: string[]; whitelist: string[] };
  discovery: { maxTokensPerScan: number; searchTerms: string[]; minLiquidityUsd: number };
}

export interface ConfigResponse {
  config: TradingConfig;
  effectiveMode: 'paper' | 'live';
  liveRequestedButNotArmed: boolean;
  env: { nodeEnv: string; walletConfigured: boolean; providers: Record<string, boolean> };
}

export const BUCKET_LABELS: Record<BucketId, string> = {
  copy_trading: 'Copy Trading',
  hot_trading: 'Hot Trading',
  hidden_gems: 'Hidden Gems',
  low_market_cap: 'Low Market Cap',
};

/** A config patch that sets every agent's `enabled` flag at once. */
export function allAgentsPatch(agents: AgentRow[], enabled: boolean): unknown {
  return { agents: Object.fromEntries(agents.map((a) => [a.id, { enabled }])) };
}

export const AGENT_LABELS: Record<string, string> = {
  copy_trade: 'Copy Trade',
  hot_trade: 'Hot Trade',
  hidden_gem: 'Hidden Gem',
  small_market_cap: 'Small Market Cap',
  social: 'Social Intelligence',
};
