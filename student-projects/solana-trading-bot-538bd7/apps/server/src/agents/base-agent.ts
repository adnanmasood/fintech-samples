import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import { newId } from '../core/id.js';
import { clamp } from '../core/money.js';
import type {
  AgentId,
  BucketId,
  RiskFlag,
  SignalAction,
  TokenMarketSnapshot,
  TokenScore,
  TradeSignal,
} from '../core/types.js';
import { AGENT_BUCKET } from '../core/types.js';
import type { Db } from '../db/client.js';
import { agentRuns } from '../db/schema.js';
import type { DecisionLog } from '../observability/decision-log.js';

/**
 * The contract every agent honours.
 *
 * An agent's whole job is to look at data and emit signals. It cannot execute,
 * cannot touch the wallet, cannot move value. That separation is what lets a
 * new strategy be added without re-auditing the money path.
 */
export interface Agent {
  readonly id: AgentId;
  readonly bucket: BucketId | null;
  isEnabled(): boolean;
  intervalMs(): number;
  run(): Promise<AgentRunResult>;
}

export interface AgentRunResult {
  agent: AgentId;
  tokensScanned: number;
  signals: TradeSignal[];
  rejected: number;
  avgScore: number | null;
  notes?: Record<string, unknown>;
}

export interface AgentDeps {
  db: Db;
  config: ConfigService;
  log: DecisionLog;
  clock: Clock;
}

export abstract class BaseAgent implements Agent {
  abstract readonly id: AgentId;

  constructor(protected readonly deps: AgentDeps) {}

  get bucket(): BucketId | null {
    return AGENT_BUCKET[this.id];
  }

  abstract isEnabled(): boolean;
  abstract intervalMs(): number;
  /** One scan. Returns signals; it has no way to act on them. */
  protected abstract scan(): Promise<AgentRunResult>;

  /** Wraps scan() with run bookkeeping, so every run is on the record. */
  async run(): Promise<AgentRunResult> {
    const startedAt = this.deps.clock.now();
    const runRow = this.deps.db
      .insert(agentRuns)
      .values({ agent: this.id, status: 'running', startedAt })
      .returning({ id: agentRuns.id })
      .get();

    try {
      const result = await this.scan();
      const finishedAt = this.deps.clock.now();
      this.deps.db
        .update(agentRuns)
        .set({
          status: 'ok',
          finishedAt,
          durationMs: finishedAt - startedAt,
          tokensScanned: result.tokensScanned,
          signalsGenerated: result.signals.length,
          rejected: result.rejected,
          avgScore: result.avgScore,
          notes: result.notes ?? null,
        })
        .where(eqId(runRow.id))
        .run();
      return result;
    } catch (err) {
      const finishedAt = this.deps.clock.now();
      const message = err instanceof Error ? err.message : String(err);
      this.deps.db
        .update(agentRuns)
        .set({
          status: 'error',
          finishedAt,
          durationMs: finishedAt - startedAt,
          error: message,
        })
        .where(eqId(runRow.id))
        .run();
      this.deps.log.record({
        level: 'error',
        category: 'signal',
        agent: this.id,
        message: `${this.id} run failed: ${message}`,
      });
      // A failing agent is contained: it reports an empty run rather than
      // taking the scheduler or the other agents down with it.
      return { agent: this.id, tokensScanned: 0, signals: [], rejected: 0, avgScore: null };
    }
  }

  /** Build a signal from a score. The one place a signal is constructed. */
  protected buildSignal(params: {
    market: TokenMarketSnapshot;
    score: TokenScore;
    action: SignalAction;
    confidence: number;
    requestedSizeUsd: number | null;
    reason: string;
    riskFlags?: RiskFlag[];
    stopLossPct: number;
    takeProfitPct: number;
    metadata?: Record<string, unknown>;
  }): TradeSignal {
    const bucket = this.bucket;
    if (!bucket) {
      throw new Error(`${this.id} has no bucket and cannot emit trade signals`);
    }
    const price = params.market.priceUsd;
    return {
      id: newId('sig'),
      agent: this.id,
      bucket,
      chain: params.market.chain,
      tokenAddress: params.market.address,
      tokenSymbol: params.market.symbol,
      action: params.action,
      score: params.score.overall,
      confidence: clamp(params.confidence, 0, 1),
      entryPriceUsd: price,
      targetPriceUsd: price > 0 ? price * (1 + params.takeProfitPct / 100) : null,
      stopLossUsd: price > 0 ? price * (1 - params.stopLossPct / 100) : null,
      requestedSizeUsd: params.requestedSizeUsd,
      reason: params.reason,
      riskFlags: params.riskFlags ?? [],
      metadata: {
        ...params.metadata,
        scoreComponents: params.score.components.map((c) => ({
          key: c.key,
          score: c.score,
          weight: c.weight,
          reason: c.reason,
        })),
        positives: params.score.positives,
        risks: params.score.risks,
        dataCoverage: params.score.dataCoverage,
      },
      createdAt: this.deps.clock.now(),
    };
  }

  /**
   * Record why one candidate did not become a signal.
   *
   * A scan structurally filters far more tokens than it ever turns into a
   * signal, and every one of those early `continue`s used to vanish with no
   * trace - the only rejections on the record were the handful of signals
   * that made it all the way to the signal engine. Debug level so the normal
   * decision-log view is not dominated by them, but they are on the record
   * for anyone actually debugging why a scan produced nothing.
   */
  protected logRejection(
    token: { address: string; symbol: string },
    reason: string,
    payload?: Record<string, unknown>,
  ): void {
    this.deps.log.record({
      level: 'debug',
      category: 'signal',
      agent: this.id,
      tokenAddress: token.address,
      message: `${this.id} passed on ${token.symbol || token.address.slice(0, 8)}: ${reason}`,
      payload,
    });
  }

  /**
   * How much to trust this score.
   *
   * Three parts, and each one is there for a reason:
   *   - the score itself, because a better token is a better bet;
   *   - data coverage, because a score built on neutral placeholders is a
   *     guess wearing a number;
   *   - headroom above the agent's threshold, so a token that only just
   *     scraped through reads as marginal rather than as a conviction buy.
   *
   * Coverage is weighted heavily on purpose. A perfect score with half its
   * dimensions missing should not clear a confidence gate that a merely good
   * score with full data would.
   */
  protected confidenceFrom(score: TokenScore, minScore: number): number {
    const quality = score.overall / 100;
    const headroom = clamp((score.overall - minScore) / Math.max(1, 100 - minScore), 0, 1);
    return clamp(0.5 * quality + 0.35 * score.dataCoverage + 0.15 * headroom, 0, 1);
  }
}

// Small local helper so the base class does not need a drizzle import in
// every subclass.
import { eq } from 'drizzle-orm';
function eqId(id: number) {
  return eq(agentRuns.id, id);
}
