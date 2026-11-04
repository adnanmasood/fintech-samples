import type { AgentId, TokenMarketSnapshot } from '../core/types.js';
import { median } from '../scoring/dimensions.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { SecurityAgent } from '../security/security-agent.js';
import type { MarketService } from '../market/market-service.js';
import type { TokenRepository } from '../market/token-repository.js';
import type { SocialAgent } from './social.agent.js';
import type { SmartMoneyIndex } from './copy-trade/smart-money-index.js';
import { BaseAgent, type AgentDeps, type AgentRunResult } from './base-agent.js';

/**
 * Hot Trade Agent.
 *
 * Short-term opportunities, scanned every five minutes by default.
 *
 * The interval starts a scan. It does not imply a trade. Most cycles end with
 * zero signals, and that is the agent working correctly, not failing.
 */
export class HotTradeAgent extends BaseAgent {
  readonly id: AgentId = 'hot_trade';

  constructor(
    deps: AgentDeps,
    private readonly market: MarketService,
    private readonly repo: TokenRepository,
    private readonly scoring: ScoringEngine,
    private readonly security: SecurityAgent,
    private readonly social: SocialAgent,
    private readonly smartMoney: SmartMoneyIndex,
  ) {
    super(deps);
  }

  isEnabled(): boolean {
    return this.deps.config.get().agents.hot_trade.enabled;
  }

  intervalMs(): number {
    return this.deps.config.get().agents.hot_trade.intervalSec * 1_000;
  }

  protected async scan(): Promise<AgentRunResult> {
    const cfg = this.deps.config.get().agents.hot_trade;
    const now = this.deps.clock.now();

    // 1. Market data: the shared discovery sweep, plus the watchlist looked
    // up directly so an established token is evaluated every cycle even when
    // it does not rank into that sweep.
    const candidates = await this.withWatchlist(await this.market.discover());
    const scores: number[] = [];
    const signals = [];
    let rejected = 0;

    const watched = new Set(cfg.watchlist);

    for (const token of candidates) {
      // 2-7. Cheap structural filters first. Every one of these is free, and
      // running them before the security call keeps the provider budget for
      // tokens that could actually be traded.
      const verdict = this.screen(token, cfg, now, watched.has(token.address));
      if (!verdict.pass) {
        rejected += 1;
        this.logRejection(token, verdict.reason ?? 'failed the structural screen');
        continue;
      }

      // 8. Security is a hard gate and runs before anything is scored as
      // tradeable.
      const security = await this.security.assess(token.address, token);
      if (security.verdict === 'reject') {
        rejected += 1;
        this.logRejection(token, security.flags[0]?.message ?? 'failed security checks', {
          securityScore: security.score,
        });
        continue;
      }

      // 9. Score.
      const social = await this.social.getSnapshot(token.address, token.symbol, token.name);
      const smart = this.smartMoney.countsFor(token.address, now - 24 * 60 * 60 * 1000);
      const score = this.scoring.score(
        token.address,
        cfg.weights,
        {
          market: token,
          onChain: null,
          social,
          security,
          trader: null,
          history: this.repo.getHistory(token.address),
          smartMoneyBuys: smart.buys,
          smartMoneySells: smart.sells,
          now,
        },
        this.id,
      );
      scores.push(score.overall);

      // 10-11. The decision. Anything short of the bar is IGNORE, and the
      // agent is silent about it beyond the run counters.
      if (score.overall < cfg.minScore) {
        rejected += 1;
        this.logRejection(token, `score ${score.overall.toFixed(0)} is below the ${cfg.minScore} floor`);
        continue;
      }
      const confidence = this.confidenceFrom(score, cfg.minScore);
      if (confidence < cfg.minConfidence) {
        rejected += 1;
        this.logRejection(
          token,
          `confidence ${confidence.toFixed(2)} is below the ${cfg.minConfidence} floor`,
          { score: score.overall },
        );
        continue;
      }

      const risk = this.deps.config.get().risk;
      const reason = [
        `Short-term momentum with ${verdict.spike ? `a ${verdict.spike.toFixed(1)}x volume spike, ` : ''}`,
        `1h price ${fmt(token.priceChange1h)} and $${Math.round(token.liquidityUsd).toLocaleString()} of liquidity.`,
      ].join('');

      signals.push(
        this.buildSignal({
          market: token,
          score,
          action: 'BUY',
          confidence,
          requestedSizeUsd: cfg.maxTradeUsd,
          reason,
          riskFlags: security.flags.filter((f) => f.severity !== 'info'),
          stopLossPct: risk.stopLossPct,
          takeProfitPct: risk.takeProfitPct,
          metadata: {
            volumeSpike: verdict.spike,
            securityScore: security.score,
            priceChange1h: token.priceChange1h,
            buySellRatio: verdict.buySellRatio,
          },
        }),
      );
    }

    return {
      agent: this.id,
      tokensScanned: candidates.length,
      signals,
      rejected,
      avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      notes: { candidates: candidates.length, passedScreen: candidates.length - rejected },
    };
  }

  /**
   * Add the watchlist to a candidate list, without duplicating anything
   * discovery already found.
   *
   * The quote asset is filtered out rather than trusted to fail downstream: a
   * BUY on it would swap SOL for SOL, which the router cannot price and which
   * would burn a cycle producing a confusing rejection every scan.
   */
  private async withWatchlist(
    discovered: TokenMarketSnapshot[],
  ): Promise<TokenMarketSnapshot[]> {
    const cfg = this.deps.config.get();
    const quoteMint = cfg.execution.quoteMint;
    const seen = new Set(discovered.map((t) => t.address));
    const missing = cfg.agents.hot_trade.watchlist.filter(
      (mint) => mint !== quoteMint && !seen.has(mint),
    );
    if (missing.length === 0) return discovered;

    const snapshots = await this.market.refresh(missing);
    return [...discovered, ...snapshots.values()];
  }

  /**
   * The structural screen. Pure, so it is directly unit testable.
   *
   * `watched` selects the gentler watchlist thresholds. Only this pre-filter
   * changes — security, scoring and risk are untouched either way.
   */
  screen(
    token: TokenMarketSnapshot,
    config: ReturnType<ConfigOf>['agents']['hot_trade'],
    now: number,
    watched = false,
  ): { pass: boolean; reason?: string; spike?: number; buySellRatio?: number } {
    const relaxed = watched && config.watchlistScreen.enabled;
    const cfg = relaxed ? { ...config, ...config.watchlistScreen } : config;

    if (token.liquidityUsd < cfg.minLiquidityUsd) {
      return { pass: false, reason: 'liquidity below floor' };
    }
    const vol1h = token.volume1hUsd ?? 0;
    if (vol1h < cfg.minVolume1hUsd) {
      return { pass: false, reason: 'hourly volume below floor' };
    }

    // A spike is measured against the token's own recent hourly baseline, not
    // against other tokens. A quiet token waking up is the signal; a
    // permanently busy one is not.
    const history = this.repo.getHistory(token.address);
    const baseline = median(
      history.map((h) => h.volume1hUsd ?? 0).filter((v) => v > 0),
    );
    const spike = baseline && baseline > 0 ? vol1h / baseline : null;
    if (spike !== null && spike < cfg.minVolumeSpikeMultiple) {
      return { pass: false, reason: 'no volume spike', spike };
    }

    const change1h = token.priceChange1h;
    if (change1h == null) return { pass: false, reason: 'no price history' };
    if (change1h < cfg.minPriceChange1hPct) {
      return { pass: false, reason: 'not moving', spike: spike ?? undefined };
    }
    if (change1h > cfg.maxPriceChange1hPct) {
      return { pass: false, reason: 'move too extreme', spike: spike ?? undefined };
    }
    // Refuse to buy the top of a vertical candle. Being late is the most
    // expensive mistake this agent can make.
    if (change1h > cfg.maxChaseGainPct) {
      return { pass: false, reason: 'already run too far', spike: spike ?? undefined };
    }

    const buys = token.buys1h ?? 0;
    const sells = token.sells1h ?? 0;
    const ratio = sells === 0 ? (buys > 0 ? Number.POSITIVE_INFINITY : 0) : buys / sells;
    if (buys + sells >= 20 && ratio < cfg.minBuySellRatio) {
      return { pass: false, reason: 'sellers outnumber buyers', spike: spike ?? undefined, buySellRatio: ratio };
    }

    // Age is checked here as well as in security, because a pair minted this
    // minute has no baseline at all and every measure above is noise.
    if (token.pairCreatedAt && now - token.pairCreatedAt < 15 * 60_000) {
      return { pass: false, reason: 'pair too new to read' };
    }

    return { pass: true, spike: spike ?? undefined, buySellRatio: Number.isFinite(ratio) ? ratio : undefined };
  }
}

type ConfigOf = () => import('../config/schema.js').TradingConfig;

function fmt(value: number | null): string {
  if (value == null) return 'unknown';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
