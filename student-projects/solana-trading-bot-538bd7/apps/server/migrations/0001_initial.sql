-- Initial schema for the USF Solana multi-agent trading platform.
-- Timestamps are epoch milliseconds. Money is USD.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  address TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'solana',
  label TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'main',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallets_address_kind_idx ON wallets(address, kind);

CREATE TABLE IF NOT EXISTS portfolio_buckets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  allocation_pct REAL NOT NULL,
  cash_usd REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  chain TEXT NOT NULL DEFAULT 'solana',
  symbol TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  decimals INTEGER,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  market_snapshot TEXT,
  on_chain_info TEXT
);
CREATE INDEX IF NOT EXISTS tokens_symbol_idx ON tokens(symbol);
CREATE INDEX IF NOT EXISTS tokens_last_seen_idx ON tokens(last_seen_at);

CREATE TABLE IF NOT EXISTS token_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  agent TEXT,
  overall REAL NOT NULL,
  data_coverage REAL NOT NULL DEFAULT 0,
  components TEXT NOT NULL,
  positives TEXT NOT NULL,
  risks TEXT NOT NULL,
  scored_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS token_scores_token_idx ON token_scores(token_address, scored_at);

CREATE TABLE IF NOT EXISTS security_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  verdict TEXT NOT NULL,
  score REAL NOT NULL,
  flags TEXT NOT NULL,
  list_match TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS security_checks_token_idx ON security_checks(token_address, checked_at);

CREATE TABLE IF NOT EXISTS traders (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  is_followed INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  last_trade_at INTEGER,
  last_checked_at INTEGER
);

CREATE TABLE IF NOT EXISTS trader_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  overall REAL NOT NULL,
  win_rate REAL,
  avg_return_pct REAL,
  max_drawdown_pct REAL,
  consistency REAL,
  trade_count INTEGER NOT NULL DEFAULT 0,
  automation_likelihood REAL,
  flags TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  scored_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS trader_scores_wallet_idx ON trader_scores(wallet, scored_at);

CREATE TABLE IF NOT EXISTS trader_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  wallet TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  amount_tokens REAL NOT NULL DEFAULT 0,
  amount_usd REAL NOT NULL DEFAULT 0,
  price_usd REAL,
  timestamp INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS trader_trades_sig_idx ON trader_trades(signature, wallet, token_address);
CREATE INDEX IF NOT EXISTS trader_trades_wallet_idx ON trader_trades(wallet, timestamp);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  bucket TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'solana',
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  score REAL NOT NULL,
  confidence REAL NOT NULL,
  entry_price_usd REAL,
  target_price_usd REAL,
  stop_loss_usd REAL,
  requested_size_usd REAL,
  reason TEXT NOT NULL DEFAULT '',
  risk_flags TEXT NOT NULL,
  metadata TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  rejection_stage TEXT,
  rejection_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS signals_agent_idx ON signals(agent, created_at);
CREATE INDEX IF NOT EXISTS signals_token_idx ON signals(token_address, created_at);
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals(status, created_at);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  agent TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'solana',
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  quantity REAL NOT NULL DEFAULT 0,
  avg_entry_price_usd REAL NOT NULL DEFAULT 0,
  cost_basis_usd REAL NOT NULL DEFAULT 0,
  high_water_price_usd REAL,
  last_mark_price_usd REAL,
  stop_loss_usd REAL,
  take_profit_usd REAL,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  fees_usd REAL NOT NULL DEFAULT 0,
  opened_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS positions_open_idx ON positions(status, bucket);
CREATE INDEX IF NOT EXISTS positions_token_idx ON positions(token_address, status);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT,
  position_id INTEGER,
  bucket TEXT NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL,
  chain TEXT NOT NULL DEFAULT 'solana',
  token_address TEXT NOT NULL,
  token_symbol TEXT NOT NULL DEFAULT '',
  side TEXT NOT NULL,
  quantity REAL NOT NULL,
  price_usd REAL NOT NULL,
  gross_usd REAL NOT NULL,
  fees_usd REAL NOT NULL DEFAULT 0,
  slippage_bps REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  score REAL,
  reason TEXT NOT NULL DEFAULT '',
  executed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS trades_executed_idx ON trades(executed_at);
CREATE INDEX IF NOT EXISTS trades_agent_idx ON trades(agent, executed_at);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id INTEGER,
  signal_id TEXT,
  chain TEXT NOT NULL DEFAULT 'solana',
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',
  slot INTEGER,
  fee_usd REAL,
  error TEXT,
  submitted_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS transactions_sig_idx ON transactions(signature);
CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions(status);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  bucket TEXT,
  start_equity_usd REAL NOT NULL DEFAULT 0,
  equity_usd REAL NOT NULL DEFAULT 0,
  realized_pnl_usd REAL NOT NULL DEFAULT 0,
  unrealized_pnl_usd REAL NOT NULL DEFAULT 0,
  peak_equity_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS pnl_day_bucket_idx ON pnl_snapshots(day, bucket);

CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  started_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  finished_at INTEGER,
  duration_ms INTEGER,
  tokens_scanned INTEGER NOT NULL DEFAULT 0,
  signals_generated INTEGER NOT NULL DEFAULT 0,
  trades_executed INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  avg_score REAL,
  error TEXT,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent, started_at);

CREATE TABLE IF NOT EXISTS social_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  mention_score REAL NOT NULL DEFAULT 0,
  sentiment_score REAL NOT NULL DEFAULT 0,
  trend_score REAL NOT NULL DEFAULT 0,
  source_quality_score REAL NOT NULL DEFAULT 0,
  spam_score REAL NOT NULL DEFAULT 0,
  raw TEXT,
  fetched_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS social_signals_token_idx ON social_signals(token_address, fetched_at);

CREATE TABLE IF NOT EXISTS token_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list TEXT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS token_lists_entry_idx ON token_lists(list, token_address);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY,
  config TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'system',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL DEFAULT 'info',
  category TEXT NOT NULL,
  agent TEXT,
  token_address TEXT,
  signal_id TEXT,
  message TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS system_events_created_idx ON system_events(created_at);
CREATE INDEX IF NOT EXISTS system_events_category_idx ON system_events(category, created_at);
