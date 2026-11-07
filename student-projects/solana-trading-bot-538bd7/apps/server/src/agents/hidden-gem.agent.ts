import type { AgentId, TokenMarketSnapshot } from '../core/types.js';
import { median } from '../scoring/dimensions.js';
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
 * Hidden Gem Agent.
 *
 * Looks for tokens with real traction that the market has not repriced yet:
 * growing holders and volume, honest liquidity, an age that proves it survived
 * its own launch, and no smell of manufactured hype.
 *
 * Its distinguishing output is the explanation. Every gem it surfaces says why
 * it was chosen, what looked good, what looked risky, and what drove the score.
 */
export class HiddenGemAgent extends BaseAgent {
  readonly id: AgentId = 'hidden_gem';

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
    return this.deps.config.get().agents.hidden_gem.enabled;
  }

  intervalMs(): number {
    return this.deps.config.get().agents.hidden_gem.intervalSec * 1_000;
  }

  protected async scan(): Promise<AgentRunResult> {
    const cfg = this.deps.config.get().agents.hidden_gem;
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

      // On-chain detail is worth the extra call here: a gem thesis lives or
      // dies on holder distribution, and this agent runs infrequently.
      const onChain = this.securityProvider.isConfigured()
        ? await this.securityProvider.getOnChainInfo(token.address, token.chain).catch(() => null)
        : null;
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
      const explanation = this.explain(token, score, security.score);

      // The explanation is logged whether or not the trade later survives risk,
      // because the thesis is the point of this agent.
      this.deps.log.record({
        category: 'signal',
        agent: this.id,
        tokenAddress: token.address,
        message: `Hidden gem found: ${token.symbol || token.address.slice(0, 8)} at ${score.overall.toFixed(0)}/100`,
        payload: { explanation, positives: score.positives, risks: score.risks },
      });

      signals.push(
        this.buildSignal({
          market: token,
          score,
          action: 'BUY',
          confidence,
          requestedSizeUsd: cfg.maxTradeUsd,
          reason: explanation,
          riskFlags: security.flags.filter((f) => f.severity !== 'info'),
          stopLossPct: risk.stopLossPct,
          takeProfitPct: risk.takeProfitPct,
          metadata: { securityScore: security.score, holderCount: onChain?.holderCount ?? null },
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
    cfg: TradingConfig['agents']['hidden_gem'],
    now: number,
  ): { pass: boolean; reason?: string } {
    const mc = token.marketCapUsd ?? token.fdvUsd;
    if (mc == null) return { pass: false, reason: 'no market cap' };
    if (mc < cfg.minMarketCapUsd) return { pass: false, reason: 'market cap too small' };
    // Past the cap it is no longer hidden, whatever else is true of it.
    if (mc > cfg.maxMarketCapUsd) return { pass: false, reason: 'market cap too large to be a gem' };
    if (token.liquidityUsd < cfg.minLiquidityUsd) return { pass: false, reason: 'liquidity too thin' };
    if (token.volume24hUsd < cfg.minVolume24hUsd) return { pass: false, reason: 'not enough trading' };

    if (token.pairCreatedAt) {
      const ageHours = (now - token.pairCreatedAt) / 3_600_000;
      if (ageHours < cfg.minTokenAgeHours) return { pass: false, reason: 'too new to have proven anything' };
      // A token this old that is still small has usually already had its
      // chance; the thesis here is early, not forgotten.
      if (ageHours > cfg.maxTokenAgeDays * 24) return { pass: false, reason: 'too old for an early thesis' };
    }

    // Growth against its own baseline is the actual gem signal.
    const history = this.repo.getHistory(token.address);
    if (history.length >= 2) {
      const baseline = median(history.map((h) => h.volume24hUsd).filter((v) => v > 0));
      if (baseline && baseline > 0) {
        const growth = ((token.volume24hUsd - baseline) / baseline) * 100;
        if (growth < cfg.minVolumeGrowthPct) return { pass: false, reason: 'volume is not growing' };
      }
    }

    return { pass: true };
  }

  /** The four questions the brief asks every gem to answer. */
  private explain(token: TokenMarketSnapshot, score: ReturnType<ScoringEngine['score']>, securityScore: number): string {
    const parts: string[] = [];
    parts.push(
      `Selected because ${token.symbol || 'this token'} is still small at $${Math.round(
        token.marketCapUsd ?? token.fdvUsd ?? 0,
      ).toLocaleString()} market cap but trades $${Math.round(token.volume24hUsd).toLocaleString()} a day against $${Math.round(
        token.liquidityUsd,
      ).toLocaleString()} of liquidity.`,
    );
    if (score.positives.length > 0) {
      parts.push(`Positive signals: ${score.positives.join('; ')}.`);
    }
    if (score.risks.length > 0) {
      parts.push(`Risks detected: ${score.risks.join('; ')}.`);
    }
    const top = [...score.components].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3);
    parts.push(
      `The score of ${score.overall.toFixed(0)} was driven mostly by ${top
        .map((c) => `${c.label} at ${c.score.toFixed(0)}`)
        .join(', ')}, with security at ${securityScore.toFixed(0)}.`,
    );
    return parts.join(' ');
  }
}
