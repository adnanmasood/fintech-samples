import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Persistence layer.
 *
 * Timestamps are epoch milliseconds so the whole system speaks one unit.
 * Money is REAL in USD; SQLite has no decimal type, and every write goes
 * through roundUsd() so the books stay at cent precision.
 *
 * The `wallets` table holds public addresses only. The one place a secret is
 * persisted is `secrets`, and it holds ciphertext, never a plaintext value.
 */

const now = sql`(unixepoch() * 1000)`;

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  displayName: text('display_name').notNull().default(''),
  createdAt: integer('created_at').notNull().default(now),
});

/** Public wallet addresses only. Private keys live in `secrets`, encrypted. */
export const wallets = sqliteTable(
  'wallets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').references(() => users.id),
    address: text('address').notNull(),
    chain: text('chain').notNull().default('solana'),
    label: text('label').notNull().default(''),
    /** 'main' is the trading wallet; 'followed' is a wallet the copy agent watches. */
    kind: text('kind').notNull().default('main'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    addressIdx: uniqueIndex('wallets_address_kind_idx').on(t.address, t.kind),
  }),
);

export const portfolioBuckets = sqliteTable('portfolio_buckets', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  allocationPct: real('allocation_pct').notNull(),
  /** Cash held by this bucket, in USD. */
  cashUsd: real('cash_usd').notNull().default(0),
  realizedPnlUsd: real('realized_pnl_usd').notNull().default(0),
  updatedAt: integer('updated_at').notNull().default(now),
});

export const tokens = sqliteTable(
  'tokens',
  {
    address: text('address').primaryKey(),
    chain: text('chain').notNull().default('solana'),
    symbol: text('symbol').notNull().default(''),
    name: text('name').notNull().default(''),
    decimals: integer('decimals'),
    firstSeenAt: integer('first_seen_at').notNull().default(now),
    lastSeenAt: integer('last_seen_at').notNull().default(now),
    /** Latest normalised market snapshot, as JSON. */
    marketSnapshot: text('market_snapshot', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    /** Latest on-chain facts, as JSON. */
    onChainInfo: text('on_chain_info', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    symbolIdx: index('tokens_symbol_idx').on(t.symbol),
    lastSeenIdx: index('tokens_last_seen_idx').on(t.lastSeenAt),
  }),
);

export const tokenScores = sqliteTable(
  'token_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenAddress: text('token_address').notNull(),
    agent: text('agent'),
    overall: real('overall').notNull(),
    dataCoverage: real('data_coverage').notNull().default(0),
    components: text('components', { mode: 'json' }).$type<unknown[]>().notNull(),
    positives: text('positives', { mode: 'json' }).$type<string[]>().notNull(),
    risks: text('risks', { mode: 'json' }).$type<string[]>().notNull(),
    scoredAt: integer('scored_at').notNull().default(now),
  },
  (t) => ({
    tokenIdx: index('token_scores_token_idx').on(t.tokenAddress, t.scoredAt),
  }),
);

export const securityChecks = sqliteTable(
  'security_checks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenAddress: text('token_address').notNull(),
    verdict: text('verdict').notNull(),
    score: real('score').notNull(),
    flags: text('flags', { mode: 'json' }).$type<unknown[]>().notNull(),
    listMatch: text('list_match'),
    degraded: integer('degraded', { mode: 'boolean' }).notNull().default(false),
    checkedAt: integer('checked_at').notNull().default(now),
  },
  (t) => ({
    tokenIdx: index('security_checks_token_idx').on(t.tokenAddress, t.checkedAt),
  }),
);

export const traders = sqliteTable('traders', {
  address: text('address').primaryKey(),
  label: text('label').notNull().default(''),
  isFollowed: integer('is_followed', { mode: 'boolean' }).notNull().default(true),
  firstSeenAt: integer('first_seen_at').notNull().default(now),
  lastTradeAt: integer('last_trade_at'),
  lastCheckedAt: integer('last_checked_at'),
});

export const traderScores = sqliteTable(
  'trader_scores',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    wallet: text('wallet').notNull(),
    overall: real('overall').notNull(),
    winRate: real('win_rate'),
    avgReturnPct: real('avg_return_pct'),
    maxDrawdownPct: real('max_drawdown_pct'),
    consistency: real('consistency'),
    tradeCount: integer('trade_count').notNull().default(0),
    automationLikelihood: real('automation_likelihood'),
    flags: text('flags', { mode: 'json' }).$type<unknown[]>().notNull(),
    reason: text('reason').notNull().default(''),
    scoredAt: integer('scored_at').notNull().default(now),
  },
  (t) => ({
    walletIdx: index('trader_scores_wallet_idx').on(t.wallet, t.scoredAt),
  }),
);

/** Swaps observed from followed wallets. Used for scoring and for copy signals. */
export const traderTrades = sqliteTable(
  'trader_trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signature: text('signature').notNull(),
    wallet: text('wallet').notNull(),
    tokenAddress: text('token_address').notNull(),
    side: text('side').notNull(),
    amountTokens: real('amount_tokens').notNull().default(0),
    amountUsd: real('amount_usd').notNull().default(0),
    priceUsd: real('price_usd'),
    timestamp: integer('timestamp').notNull(),
    processedAt: integer('processed_at'),
  },
  (t) => ({
    sigIdx: uniqueIndex('trader_trades_sig_idx').on(t.signature, t.wallet, t.tokenAddress),
    walletIdx: index('trader_trades_wallet_idx').on(t.wallet, t.timestamp),
  }),
);

export const signals = sqliteTable(
  'signals',
  {
    id: text('id').primaryKey(),
    agent: text('agent').notNull(),
    bucket: text('bucket').notNull(),
    chain: text('chain').notNull().default('solana'),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull().default(''),
    action: text('action').notNull(),
    score: real('score').notNull(),
    confidence: real('confidence').notNull(),
    entryPriceUsd: real('entry_price_usd'),
    targetPriceUsd: real('target_price_usd'),
    stopLossUsd: real('stop_loss_usd'),
    requestedSizeUsd: real('requested_size_usd'),
    reason: text('reason').notNull().default(''),
    riskFlags: text('risk_flags', { mode: 'json' }).$type<unknown[]>().notNull(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** pending | approved | rejected | executed | failed */
    status: text('status').notNull().default('pending'),
    rejectionStage: text('rejection_stage'),
    rejectionReason: text('rejection_reason'),
    createdAt: integer('created_at').notNull().default(now),
    resolvedAt: integer('resolved_at'),
  },
  (t) => ({
    agentIdx: index('signals_agent_idx').on(t.agent, t.createdAt),
    tokenIdx: index('signals_token_idx').on(t.tokenAddress, t.createdAt),
    statusIdx: index('signals_status_idx').on(t.status, t.createdAt),
  }),
);

export const positions = sqliteTable(
  'positions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    bucket: text('bucket').notNull(),
    agent: text('agent').notNull(),
    chain: text('chain').notNull().default('solana'),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull().default(''),
    status: text('status').notNull().default('open'),
    quantity: real('quantity').notNull().default(0),
    avgEntryPriceUsd: real('avg_entry_price_usd').notNull().default(0),
    costBasisUsd: real('cost_basis_usd').notNull().default(0),
    /** Highest mark seen while open, for the trailing stop. */
    highWaterPriceUsd: real('high_water_price_usd'),
    lastMarkPriceUsd: real('last_mark_price_usd'),
    stopLossUsd: real('stop_loss_usd'),
    takeProfitUsd: real('take_profit_usd'),
    realizedPnlUsd: real('realized_pnl_usd').notNull().default(0),
    feesUsd: real('fees_usd').notNull().default(0),
    openedAt: integer('opened_at').notNull().default(now),
    closedAt: integer('closed_at'),
  },
  (t) => ({
    openIdx: index('positions_open_idx').on(t.status, t.bucket),
    tokenIdx: index('positions_token_idx').on(t.tokenAddress, t.status),
  }),
);

export const trades = sqliteTable(
  'trades',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    signalId: text('signal_id'),
    positionId: integer('position_id'),
    bucket: text('bucket').notNull(),
    agent: text('agent').notNull(),
    mode: text('mode').notNull(),
    chain: text('chain').notNull().default('solana'),
    tokenAddress: text('token_address').notNull(),
    tokenSymbol: text('token_symbol').notNull().default(''),
    side: text('side').notNull(),
    quantity: real('quantity').notNull(),
    priceUsd: real('price_usd').notNull(),
    grossUsd: real('gross_usd').notNull(),
    feesUsd: real('fees_usd').notNull().default(0),
    slippageBps: real('slippage_bps').notNull().default(0),
    realizedPnlUsd: real('realized_pnl_usd').notNull().default(0),
    score: real('score'),
    reason: text('reason').notNull().default(''),
    executedAt: integer('executed_at').notNull().default(now),
  },
  (t) => ({
    executedIdx: index('trades_executed_idx').on(t.executedAt),
    agentIdx: index('trades_agent_idx').on(t.agent, t.executedAt),
  }),
);

/** One row per on-chain send. Live only; a trade is not real until confirmed. */
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tradeId: integer('trade_id'),
    signalId: text('signal_id'),
    chain: text('chain').notNull().default('solana'),
    signature: text('signature'),
    /** submitted | confirmed | failed | timeout */
    status: text('status').notNull().default('submitted'),
    slot: integer('slot'),
    feeUsd: real('fee_usd'),
    error: text('error'),
    submittedAt: integer('submitted_at').notNull().default(now),
    confirmedAt: integer('confirmed_at'),
  },
  (t) => ({
    sigIdx: index('transactions_sig_idx').on(t.signature),
    statusIdx: index('transactions_status_idx').on(t.status),
  }),
);

/** Daily equity marks. Feeds the daily-loss limit and the drawdown readout. */
export const pnlSnapshots = sqliteTable(
  'pnl_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** YYYY-MM-DD in UTC. */
    day: text('day').notNull(),
    bucket: text('bucket'),
    startEquityUsd: real('start_equity_usd').notNull().default(0),
    equityUsd: real('equity_usd').notNull().default(0),
    realizedPnlUsd: real('realized_pnl_usd').notNull().default(0),
    unrealizedPnlUsd: real('unrealized_pnl_usd').notNull().default(0),
    peakEquityUsd: real('peak_equity_usd').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => ({
    dayIdx: uniqueIndex('pnl_day_bucket_idx').on(t.day, t.bucket),
  }),
);

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent: text('agent').notNull(),
    /** running | ok | error | skipped */
    status: text('status').notNull().default('running'),
    startedAt: integer('started_at').notNull().default(now),
    finishedAt: integer('finished_at'),
    durationMs: integer('duration_ms'),
    tokensScanned: integer('tokens_scanned').notNull().default(0),
    signalsGenerated: integer('signals_generated').notNull().default(0),
    tradesExecuted: integer('trades_executed').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    avgScore: real('avg_score'),
    error: text('error'),
    notes: text('notes', { mode: 'json' }).$type<Record<string, unknown> | null>(),
  },
  (t) => ({
    agentIdx: index('agent_runs_agent_idx').on(t.agent, t.startedAt),
  }),
);

export const socialSignals = sqliteTable(
  'social_signals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    tokenAddress: text('token_address').notNull(),
    symbol: text('symbol').notNull().default(''),
    mentionScore: real('mention_score').notNull().default(0),
    sentimentScore: real('sentiment_score').notNull().default(0),
    trendScore: real('trend_score').notNull().default(0),
    sourceQualityScore: real('source_quality_score').notNull().default(0),
    spamScore: real('spam_score').notNull().default(0),
    raw: text('raw', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    fetchedAt: integer('fetched_at').notNull().default(now),
  },
  (t) => ({
    tokenIdx: index('social_signals_token_idx').on(t.tokenAddress, t.fetchedAt),
  }),
);

/** Blacklist and whitelist in one table, separated by `list`. */
export const tokenLists = sqliteTable(
  'token_lists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    list: text('list').notNull(),
    tokenAddress: text('token_address').notNull(),
    symbol: text('symbol').notNull().default(''),
    reason: text('reason').notNull().default(''),
    source: text('source').notNull().default('manual'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    entryIdx: uniqueIndex('token_lists_entry_idx').on(t.list, t.tokenAddress),
  }),
);

/** The single settings document, versioned. Row id 1 is the live config. */
export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: integer('updated_at').notNull().default(now),
});

/**
 * Encrypted secrets, keyed by name. Values are AES-256-GCM ciphertext and are
 * never served by the API — see `wallet/key-store.ts`.
 */
export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull().default(now),
});

/** Append-only history of config changes, so a bad edit can be traced. */
export const settingsHistory = sqliteTable('settings_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: integer('version').notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  changedBy: text('changed_by').notNull().default('system'),
  note: text('note').notNull().default(''),
  createdAt: integer('created_at').notNull().default(now),
});

/** The decision log. Every accepted and every refused trade lands here. */
export const systemEvents = sqliteTable(
  'system_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    level: text('level').notNull().default('info'),
    /** signal | security | risk | portfolio | execution | scheduler | config | system */
    category: text('category').notNull(),
    agent: text('agent'),
    tokenAddress: text('token_address'),
    signalId: text('signal_id'),
    message: text('message').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => ({
    createdIdx: index('system_events_created_idx').on(t.createdAt),
    categoryIdx: index('system_events_category_idx').on(t.category, t.createdAt),
  }),
);

export type DbToken = typeof tokens.$inferSelect;
export type DbSignal = typeof signals.$inferSelect;
export type DbPosition = typeof positions.$inferSelect;
export type DbTrade = typeof trades.$inferSelect;
export type DbBucket = typeof portfolioBuckets.$inferSelect;
export type DbAgentRun = typeof agentRuns.$inferSelect;
export type DbSystemEvent = typeof systemEvents.$inferSelect;
