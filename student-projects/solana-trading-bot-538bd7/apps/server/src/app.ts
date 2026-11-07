import { systemClock, type Clock } from './core/clock.js';
import { ConfigService } from './config/config-service.js';
import { describeEnv, getEnv } from './config/env.js';
import { createDb, type DbHandle } from './db/client.js';
import { applyMigrations } from './db/migrate.js';
import { createLogger, type Logger } from './observability/logger.js';
import { DecisionLog } from './observability/decision-log.js';
import { activityLog, type ActivityLog } from './observability/activity-log.js';
import { buildProviderRegistry } from './providers/registry.js';
import type { ProviderRegistry } from './providers/interfaces.js';
import { TokenRepository } from './market/token-repository.js';
import { MarketService } from './market/market-service.js';
import { ListService } from './security/list-service.js';
import { SecurityAgent } from './security/security-agent.js';
import { ScoringEngine } from './scoring/scoring-engine.js';
import { PortfolioManager } from './portfolio/portfolio-manager.js';
import { RiskManager } from './risk/risk-manager.js';
import { PaperExecutor } from './execution/paper-executor.js';
import { LiveExecutor } from './execution/live-executor.js';
import { ExecutionService } from './execution/execution-service.js';
import { WalletService } from './wallet/wallet-service.js';
import { SecretStore } from './wallet/key-store.js';
import { WalletBalanceService } from './wallet/wallet-balance.js';
import { SignalEngine } from './signals/signal-engine.js';
import { PositionManager } from './positions/position-manager.js';
import { Scheduler } from './scheduler/scheduler.js';
import { SocialAgent } from './agents/social.agent.js';
import { HotTradeAgent } from './agents/hot-trade.agent.js';
import { HiddenGemAgent } from './agents/hidden-gem.agent.js';
import { SmallCapAgent } from './agents/small-cap.agent.js';
import { CopyTradeAgent } from './agents/copy-trade/copy-trade.agent.js';
import { SmartMoneyIndex } from './agents/copy-trade/smart-money-index.js';
import type { Agent } from './agents/base-agent.js';

/**
 * The composition root.
 *
 * Every dependency is constructed here and passed in. Nothing below this file
 * reaches for a global, which is what makes the whole system constructible in
 * a test with a fake clock and an in-memory database.
 */
export interface App {
  db: DbHandle;
  logger: Logger;
  log: DecisionLog;
  activity: ActivityLog;
  config: ConfigService;
  providers: ProviderRegistry;
  repo: TokenRepository;
  market: MarketService;
  lists: ListService;
  security: SecurityAgent;
  scoring: ScoringEngine;
  portfolio: PortfolioManager;
  risk: RiskManager;
  wallet: WalletService;
  walletBalance: WalletBalanceService;
  execution: ExecutionService;
  liveExecutor: LiveExecutor;
  signals: SignalEngine;
  positionsManager: PositionManager;
  scheduler: Scheduler;
  agents: Map<string, Agent>;
  copyTrade: CopyTradeAgent;
  smartMoney: SmartMoneyIndex;
  clock: Clock;
  shutdown(): Promise<void>;
}

export interface BuildAppOptions {
  databaseUrl?: string;
  clock?: Clock;
  logger?: Logger;
  providers?: Partial<ProviderRegistry>;
  /** Skip the scheduler, for tests that drive agents directly. */
  startScheduler?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): App {
  const env = getEnv();
  const clock = options.clock ?? systemClock;
  const logger = options.logger ?? createLogger();

  const databaseUrl = options.databaseUrl ?? env.DATABASE_URL;
  const db = createDb(databaseUrl);
  applyMigrations(db.sqlite);

  const log = new DecisionLog(db.db, logger);
  const config = ConfigService.load(db.db);

  const providers: ProviderRegistry = { ...buildProviderRegistry(env), ...options.providers };

  const repo = new TokenRepository(db.db);
  const market = new MarketService(providers.market, repo, config, log);

  const lists = new ListService(db.db);
  lists.seedFromConfig(config.get().lists);

  const security = new SecurityAgent(db.db, config, providers.security, lists, log, clock);
  const scoring = new ScoringEngine(db.db);

  const portfolio = new PortfolioManager(db.db, config, clock);
  portfolio.initialise();

  const risk = new RiskManager(db.db, config, portfolio, clock);

  const secrets = new SecretStore(db.db, SecretStore.keyPathFor(databaseUrl));
  const wallet = new WalletService(secrets);
  // A key saved from the dashboard arms live mode without a restart, so the
  // mode check has to ask the wallet rather than only the environment.
  config.setWalletProbe(() => wallet.isAvailable());
  const walletBalance = new WalletBalanceService(
    wallet, providers.blockchain, providers.dex, config, clock,
  );

  const paperExecutor = new PaperExecutor(config, repo);
  const liveExecutor = new LiveExecutor(db.db, config, providers.dex, providers.blockchain, wallet, log);
  const execution = new ExecutionService(db.db, config, portfolio, paperExecutor, liveExecutor, log, clock);

  const signals = new SignalEngine(
    db.db,
    config,
    security,
    risk,
    portfolio,
    execution,
    market,
    log,
    clock,
    providers.llm,
  );

  const positionsManager = new PositionManager(db.db, config, portfolio, market, execution, log, clock);

  const agentDeps = { db: db.db, config, log, clock };
  const smartMoney = new SmartMoneyIndex(db.db);
  const social = new SocialAgent(agentDeps, db.db, providers.social, repo);

  const hotTrade = new HotTradeAgent(agentDeps, market, repo, scoring, security, social, smartMoney);
  const hiddenGem = new HiddenGemAgent(
    agentDeps, market, repo, scoring, security, providers.security, social, smartMoney,
  );
  const smallCap = new SmallCapAgent(
    agentDeps, market, repo, scoring, security, providers.security, social, smartMoney,
  );
  const copyTrade = new CopyTradeAgent(
    agentDeps, db.db, providers.blockchain, market, repo, scoring, security, social, smartMoney,
  );

  const agents = new Map<string, Agent>([
    ['hot_trade', hotTrade],
    ['hidden_gem', hiddenGem],
    ['small_market_cap', smallCap],
    ['copy_trade', copyTrade],
    ['social', social],
  ]);

  const scheduler = new Scheduler(clock, logger, log);

  // Every trading agent gets the same shape of job: run, then hand each signal
  // to the engine. The agent cannot execute; only this loop can ask.
  for (const [name, agent] of agents) {
    if (name === 'social') continue;
    scheduler.register({
      name,
      intervalMs: () => agent.intervalMs(),
      enabled: () => agent.isEnabled(),
      runOnStart: false,
      run: async () => {
        const result = await agent.run();
        for (const signal of result.signals) {
          await signals.process(signal);
        }
      },
    });
  }

  scheduler.register({
    name: 'social',
    intervalMs: () => social.intervalMs(),
    enabled: () => social.isEnabled(),
    run: async () => {
      await social.run();
    },
  });

  // Marking to market is what enforces every stop and target, so it runs on
  // its own cadence rather than piggybacking on an agent.
  scheduler.register({
    name: 'mark_to_market',
    intervalMs: () => config.get().portfolio.markToMarketSec * 1_000,
    enabled: () => true,
    runOnStart: true,
    run: async () => {
      const leaderExits = copyTrade.recentLeaderExits(clock.now() - 60 * 60 * 1000);
      const result = await positionsManager.markAndManage(leaderExits);
      const state = portfolio.getState(result.marks);
      portfolio.snapshotDaily(state);
    },
  });

  // Housekeeping, so a long paper run does not grow without bound.
  scheduler.register({
    name: 'housekeeping',
    intervalMs: () => 6 * 60 * 60 * 1000,
    enabled: () => true,
    run: async () => {
      log.prune(30);
      repo.prune(14 * 24 * 60 * 60 * 1000);
      const removed = repo.removeImplausible();
      if (removed > 0) {
        log.record({
          category: 'system',
          message: `Housekeeping removed ${removed} token row(s) that failed the ingestion sanity checks.`,
        });
      }
    },
  });

  // Run once at boot too, not only every six hours: a table carrying rows
  // from before this check existed should not have to wait for the first
  // scheduled housekeeping pass to clean up.
  repo.removeImplausible();

  config.onChange((next, previous) => {
    if (next.portfolio.allocations !== previous.portfolio.allocations) {
      try {
        portfolio.applyAllocations(next.portfolio.allocations);
      } catch (err) {
        logger.error({ err }, 'failed to apply new allocations');
      }
    }
    lists.seedFromConfig(next.lists);
  });

  const report = describeEnv(env);
  log.record({
    category: 'system',
    message: `Platform started in ${config.effectiveMode().toUpperCase()} mode.`,
    payload: {
      configuredMode: config.get().mode,
      walletConfigured: wallet.isAvailable(),
      providers: report.providers,
    },
  });

  if (config.isLiveRequestedButNotArmed()) {
    logger.warn(
      'Configuration asks for live trading but no wallet private key is configured. Running in paper mode.',
    );
  }
  if (wallet.error()) {
    logger.warn(wallet.error());
  }

  if (options.startScheduler !== false) {
    scheduler.start();
  }

  return {
    db, logger, log, activity: activityLog, config, providers, repo, market, lists, security, scoring,
    portfolio, risk, wallet, walletBalance, execution, liveExecutor, signals, positionsManager,
    scheduler, agents, copyTrade, smartMoney, clock,
    async shutdown() {
      await scheduler.stop();
      db.close();
    },
  };
}
