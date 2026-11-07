import { eq } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import type { RejectionStage, TradeSignal } from '../core/types.js';
import type { Db } from '../db/client.js';
import { signals as signalsTable } from '../db/schema.js';
import type { MarketService } from '../market/market-service.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { RiskManager } from '../risk/risk-manager.js';
import type { SecurityAgent } from '../security/security-agent.js';
import type { ExecutionService } from '../execution/execution-service.js';
import type { LlmProvider } from '../providers/interfaces.js';

/**
 * Signal Engine.
 *
 * The one path from an agent's idea to a trade:
 *
 *   agent -> signal engine -> security -> risk -> portfolio -> execution
 *
 * Every stage can stop a signal, every stop is recorded with its reason, and
 * an agent has no way to skip a stage because agents never call execution.
 */
export class SignalEngine {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly security: SecurityAgent,
    private readonly risk: RiskManager,
    private readonly portfolio: PortfolioManager,
    private readonly execution: ExecutionService,
    private readonly market: MarketService,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
    private readonly llm: LlmProvider,
  ) {}

  async process(signal: TradeSignal): Promise<{ executed: boolean; stage: RejectionStage | null }> {
    this.persist(signal);

    if (signal.action !== 'BUY') {
      // HOLD and IGNORE are recorded for the log and go no further, which is
      // most of what a healthy system produces.
      this.resolve(signal.id, signal.action === 'SELL' ? 'pending' : 'rejected', null, `Action was ${signal.action}.`);
      return { executed: false, stage: null };
    }

    // --- Stage 1: security. A hard gate, re-checked here even though the
    // agent already asked, because time has passed and the agent is not
    // trusted to have asked at all.
    const market = await this.market.getOne(signal.tokenAddress);
    const assessment = await this.security.assess(signal.tokenAddress, market);
    if (assessment.verdict === 'reject') {
      const reason = assessment.flags[0]?.message ?? 'failed security checks';
      this.reject(signal, 'security', reason, { securityScore: assessment.score, flags: assessment.flags });
      return { executed: false, stage: 'security' };
    }
    if (assessment.score < this.config.get().risk.minSecurityScore) {
      const reason = `Security score ${assessment.score.toFixed(0)} is below the ${this.config.get().risk.minSecurityScore} floor.`;
      this.reject(signal, 'security', reason, { securityScore: assessment.score });
      return { executed: false, stage: 'security' };
    }

    // --- Stage 2: risk. May reject, may shrink.
    const decision = this.risk.evaluate(signal, market);
    if (!decision.approved) {
      this.reject(signal, 'risk', decision.reasons.join(' '), { checks: decision.checks });
      return { executed: false, stage: 'risk' };
    }

    // --- Stage 3: portfolio. The bucket has to actually hold the cash.
    const available = this.portfolio.getBucketCash(signal.bucket);
    if (available < decision.approvedSizeUsd) {
      this.reject(
        signal,
        'portfolio',
        `Bucket holds $${available.toFixed(2)} but the trade needs $${decision.approvedSizeUsd.toFixed(2)}.`,
        { available, required: decision.approvedSizeUsd },
      );
      return { executed: false, stage: 'portfolio' };
    }

    const price = market?.priceUsd ?? signal.entryPriceUsd ?? 0;
    if (price <= 0) {
      this.reject(signal, 'portfolio', 'No usable price at execution time.');
      return { executed: false, stage: 'portfolio' };
    }

    // --- Stage 4: execution.
    const { result, position } = await this.execution.openPosition(signal, decision.approvedSizeUsd, price);
    if (!result.ok || !position) {
      this.reject(signal, 'execution', result.error ?? 'Execution did not complete.', {
        txSignature: result.txSignature,
      });
      return { executed: false, stage: 'execution' };
    }

    this.resolve(signal.id, 'executed', null, decision.reasons.join(' '));

    // The full explanation, in the shape the brief asks for.
    const explanation = await this.narrate(signal, assessment.score, decision.approvedSizeUsd, result.filledPriceUsd);
    this.log.record({
      category: 'execution',
      agent: signal.agent,
      signalId: signal.id,
      tokenAddress: signal.tokenAddress,
      message: `${labelFor(signal.agent)} bought ${signal.tokenSymbol || signal.tokenAddress.slice(0, 8)} for $${decision.approvedSizeUsd.toFixed(2)}`,
      payload: {
        mode: this.config.effectiveMode(),
        score: signal.score,
        securityScore: assessment.score,
        confidence: signal.confidence,
        bucket: signal.bucket,
        positionUsd: decision.approvedSizeUsd,
        filledPriceUsd: result.filledPriceUsd,
        slippageBps: result.slippageBps,
        feesUsd: result.feesUsd,
        riskChecks: decision.checks.filter((c) => !c.passed).map((c) => c.message),
        reason: signal.reason,
        explanation,
        txSignature: result.txSignature,
      },
    });

    return { executed: true, stage: null };
  }

  /**
   * A plain-language summary. The deterministic reason is always present; the
   * model only rephrases it, and a failure changes nothing.
   */
  private async narrate(
    signal: TradeSignal,
    securityScore: number,
    sizeUsd: number,
    fillPrice: number,
  ): Promise<string> {
    const base =
      `${labelFor(signal.agent)} bought ${signal.tokenSymbol} at $${fillPrice.toPrecision(4)} for $${sizeUsd.toFixed(2)} ` +
      `in the ${signal.bucket.replace(/_/g, ' ')} bucket, mode ${this.config.effectiveMode()}. ` +
      `Score ${signal.score.toFixed(0)}/100, security ${securityScore.toFixed(0)}/100. ${signal.reason}`;

    if (!this.llm.isConfigured()) return base;
    const rephrased = await this.llm.explain(
      `Summarise this automated trade for a dashboard in at most three short sentences:\n${base}`,
    );
    return rephrased ?? base;
  }

  private persist(signal: TradeSignal): void {
    this.db
      .insert(signalsTable)
      .values({
        id: signal.id,
        agent: signal.agent,
        bucket: signal.bucket,
        chain: signal.chain,
        tokenAddress: signal.tokenAddress,
        tokenSymbol: signal.tokenSymbol,
        action: signal.action,
        score: signal.score,
        confidence: signal.confidence,
        entryPriceUsd: signal.entryPriceUsd,
        targetPriceUsd: signal.targetPriceUsd,
        stopLossUsd: signal.stopLossUsd,
        requestedSizeUsd: signal.requestedSizeUsd,
        reason: signal.reason,
        riskFlags: signal.riskFlags,
        metadata: signal.metadata,
        status: 'pending',
        createdAt: signal.createdAt,
      })
      .onConflictDoNothing()
      .run();
  }

  private reject(
    signal: TradeSignal,
    stage: RejectionStage,
    reason: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.resolve(signal.id, 'rejected', stage, reason);
    this.log.record({
      level: 'info',
      category: stage === 'security' ? 'security' : stage === 'risk' ? 'risk' : 'signal',
      agent: signal.agent,
      signalId: signal.id,
      tokenAddress: signal.tokenAddress,
      message: `Rejected at ${stage}: ${signal.tokenSymbol || signal.tokenAddress.slice(0, 8)} - ${reason}`,
      payload: { ...payload, score: signal.score, agentReason: signal.reason },
    });
  }

  private resolve(
    id: string,
    status: 'executed' | 'rejected' | 'pending',
    stage: RejectionStage | null,
    reason: string,
  ): void {
    this.db
      .update(signalsTable)
      .set({
        status,
        rejectionStage: stage,
        rejectionReason: status === 'rejected' ? reason : null,
        resolvedAt: this.clock.now(),
      })
      .where(eq(signalsTable.id, id))
      .run();
  }
}

const AGENT_LABELS: Record<string, string> = {
  copy_trade: 'COPY TRADE AGENT',
  hot_trade: 'HOT TRADE AGENT',
  hidden_gem: 'HIDDEN GEM AGENT',
  small_market_cap: 'SMALL MARKET CAP AGENT',
};

function labelFor(agent: string): string {
  return AGENT_LABELS[agent] ?? agent.toUpperCase();
}

export { labelFor };
