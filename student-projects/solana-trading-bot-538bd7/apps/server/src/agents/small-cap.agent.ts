import type { AgentId, TokenMarketSnapshot } from '../core/types.js';
import { sum } from '../core/money.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { SecurityAgent } from '../security/security-agent.js';
import type { MarketService } from '../market/market-service.js';
import type { TokenRepository } from '../market/token-repository.js';
import type { TokenSecurityProvider } from '../providers/interfaces.js';
import type { SocialAgent } from './social.agent.js';
import type { SmartMoneyIndex } from './copy-trade/smart-money-index.js';
import { BaseAgent, type AgentDeps, type AgentRunResult } from './base-agent.js';
import type { TradingConfig } from '../config/schema.js';

/**
 * Small Market Cap Agent.
 *
 * The highest-risk bucket, so it is the strictest agent. It layers its own
 * security floor on top of the global gate, insists on real on-chain data
 * rather than trading blind, and refuses anything where a handful of wallets
 * could exit into the pool and take the price with them.
 */
export class SmallCapAgent extends BaseAgent {
  readonly id: AgentId = 'small_market_cap';

  constructor(
    deps: AgentDeps,
    private readonly market: MarketService,
    private readonly repo: TokenRepository,
    private readonly scoring: ScoringEngine,
    private readonly security: SecurityAgent,
    private readonly securityProvider: TokenSecurityProvider,
    private readonly social: SocialAgent,
    private readonly smartMoney: SmartMoneyIndex,
  ) {
    super(deps);
  }

  isEnabled(): boolean {
    return this.deps.config.get().agents.small_market_cap.enabled;
  }

  intervalMs(): number {
    return this.deps.config.get().agents.small_market_cap.intervalSec * 1_000;
  }

  protected async scan(): Promise<AgentRunResult> {
    const cfg = this.deps.config.get().agents.small_market_cap;
    const now = this.deps.clock.now();
    const candidates = await this.market.discover();

    const scores: number[] = [];
    const signals = [];
    let rejected = 0;

    for (const token of candidates) {
      const screened = this.screen(token, cfg, now);
      if (!screened.pass) {
        rejected += 1;
        this.logRejection(token, screened.reason ?? 'failed the structural screen');
        continue;
      }

      const security = await this.security.assess(token.address, token);
      if (security.verdict === 'reject') {
        rejected += 1;
        this.logRejection(token, security.flags[0]?.message ?? 'failed security checks', {
          securityScore: security.score,
        });
        continue;
      }
      // The agent's own floor, above the global one. A small cap that only
      // just scrapes past the general gate is not good enough here.
      if (security.score < cfg.minSecurityScore) {
        rejected += 1;
        this.logRejection(
          token,
          `security score ${security.score.toFixed(0)} is below this agent's own ${cfg.minSecurityScore} floor`,
        );
        continue;
      }

      const onChain = this.securityProvider.isConfigured()
        ? await this.securityProvider.getOnChainInfo(token.address, token.chain).catch(() => null)
        : null;

      // Trading a micro cap with no visibility into who holds it is the exact
      // situation this agent exists to avoid, so it declines rather than guesses.
      if (!onChain) {
        rejected += 1;
        this.logRejection(token, 'no on-chain holder data available, and this agent will not trade blind');
        continue;
      }

      const concentration = sum(onChain.topHolderShares.slice(0, 10)) * 100;
      if (concentration > cfg.maxWalletConcentrationPct) {
        rejected += 1;
        this.logRejection(token, `top ten wallets hold ${concentration.toFixed(1)}% of supply`);
        continue;
      }

      const social = await this.social.getSnapshot(token.address, token.symbol, token.name);
      const smart = this.smartMoney.countsFor(token.address, now - 7 * 24 * 60 * 60 * 1000);

      const score = this.scoring.score(
        token.address,
        cfg.weights,
        {
          market: token,
          onChain,
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
      signals.push(
        this.buildSignal({
          market: token,
          score,
          action: 'BUY',
          confidence,
          requestedSizeUsd: cfg.maxTradeUsd,
          reason:
            `Small cap at $${Math.round(token.marketCapUsd ?? token.fdvUsd ?? 0).toLocaleString()} with ` +
            `$${Math.round(token.liquidityUsd).toLocaleString()} liquidity, top ten wallets at ` +
            `${concentration.toFixed(1)}% and security ${security.score.toFixed(0)}/100.`,
          riskFlags: security.flags.filter((f) => f.severity !== 'info'),
          // Small caps get a tighter stop: the downside arrives faster here.
          stopLossPct: Math.min(risk.stopLossPct, 12),
          takeProfitPct: risk.takeProfitPct,
          metadata: {
            securityScore: security.score,
            walletConcentrationPct: concentration,
            holderCount: onChain.holderCount,
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
    };
  }

  screen(
    token: TokenMarketSnapshot,
    cfg: TradingConfig['agents']['small_market_cap'],
    now: number,
  ): { pass: boolean; reason?: string } {
    const mc = token.marketCapUsd ?? token.fdvUsd;
    if (mc == null) return { pass: false, reason: 'no market cap' };
    if (mc < cfg.minMarketCapUsd) return { pass: false, reason: 'below the floor, too illiquid to exit' };
    if (mc > cfg.maxMarketCapUsd) return { pass: false, reason: 'not a small cap' };
    if (token.liquidityUsd < cfg.minLiquidityUsd) return { pass: false, reason: 'liquidity too thin' };
    if (token.volume24hUsd < cfg.minVolume24hUsd) return { pass: false, reason: 'not enough trading' };
    if (token.pairCreatedAt) {
      const ageHours = (now - token.pairCreatedAt) / 3_600_000;
      if (ageHours < cfg.minTokenAgeHours) return { pass: false, reason: 'too new' };
    }
    return { pass: true };
  }
}
