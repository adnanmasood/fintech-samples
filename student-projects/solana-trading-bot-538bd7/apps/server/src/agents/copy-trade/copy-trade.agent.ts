import { desc, eq } from 'drizzle-orm';
import type { AgentId, TraderScore, WalletTrade } from '../../core/types.js';
import type { Db } from '../../db/client.js';
import { traderScores, traderTrades, traders } from '../../db/schema.js';
import type { BlockchainProvider } from '../../providers/interfaces.js';
import type { MarketService } from '../../market/market-service.js';
import type { TokenRepository } from '../../market/token-repository.js';
import type { ScoringEngine } from '../../scoring/scoring-engine.js';
import type { SecurityAgent } from '../../security/security-agent.js';
import type { SocialAgent } from '../social.agent.js';
import { BaseAgent, type AgentDeps, type AgentRunResult } from '../base-agent.js';
import { scoreTrader } from './trader-scoring.js';
import type { SmartMoneyIndex } from './smart-money-index.js';

/**
 * Copy Trade Agent.
 *
 * Watches a list of wallets, rates them on their own record, and turns their
 * new trades into signals. It never copies blindly: every candidate passes
 *
 *     trader score + token score + security + risk manager
 *
 * and any one of them can stop it.
 */
export class CopyTradeAgent extends BaseAgent {
  readonly id: AgentId = 'copy_trade';

  constructor(
    deps: AgentDeps,
    private readonly db: Db,
    private readonly blockchain: BlockchainProvider,
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
    return this.deps.config.get().agents.copy_trade.enabled;
  }

  intervalMs(): number {
    return this.deps.config.get().agents.copy_trade.intervalSec * 1_000;
  }

  protected async scan(): Promise<AgentRunResult> {
    const cfg = this.deps.config.get().agents.copy_trade;
    const now = this.deps.clock.now();
    const wallets = cfg.followedWallets.filter((w) => w.enabled);

    if (wallets.length === 0) {
      return {
        agent: this.id,
        tokensScanned: 0,
        signals: [],
        rejected: 0,
        avgScore: null,
        notes: { reason: 'no wallets are being followed' },
      };
    }

    if (!this.blockchain.isConfigured()) {
      this.deps.log.record({
        level: 'warn',
        category: 'signal',
        agent: this.id,
        message: 'Copy trading is on but no blockchain provider is configured, so no wallets can be read.',
      });
      return { agent: this.id, tokensScanned: 0, signals: [], rejected: 0, avgScore: null };
    }

    // 1. Pull recent activity and remember it. The stored history is what
    // every later scoring pass runs on.
    const lookbackMs = 14 * 24 * 60 * 60 * 1000;
    const freshTrades: WalletTrade[] = [];
    for (const wallet of wallets) {
      this.ensureTraderRow(wallet.address, wallet.label);
      const observed = await this.blockchain
        .getWalletTrades(wallet.address, now - lookbackMs, 100)
        .catch(() => []);
      const inserted = this.storeTrades(observed);
      freshTrades.push(...inserted);
    }

    // 2. Rate every wallet on its full stored record.
    const scoresByWallet = new Map<string, TraderScore>();
    for (const wallet of wallets) {
      const history = this.loadTrades(wallet.address);
      const score = scoreTrader(wallet.address, history, { now });
      scoresByWallet.set(wallet.address, score);
      this.storeTraderScore(score);
    }

    // Feed the rated set back into the shared index so every other agent
    // benefits from knowing which wallets are worth watching.
    this.smartMoney.setRatedWallets(
      [...scoresByWallet.values()].filter((s) => s.overall >= cfg.minTraderScore).map((s) => s.wallet),
    );
    this.smartMoney.rebuild(now - 30 * 24 * 60 * 60 * 1000);

    // 3. Turn qualifying new trades into signals.
    const signals = [];
    let rejected = 0;
    const scored: number[] = [];
    const seen = new Set<string>();

    for (const trade of freshTrades.sort((a, b) => b.timestamp - a.timestamp)) {
      // Only follow entries. Exits are handled by mirrorExits below, which
      // closes positions rather than opening them.
      if (trade.side !== 'buy') continue;
      const candidate = { address: trade.tokenAddress, symbol: '' };
      if (now - trade.timestamp > cfg.maxTradeAgeSec * 1_000) {
        rejected += 1;
        this.logRejection(candidate, `the leader's trade is older than ${cfg.maxTradeAgeSec}s`);
        continue;
      }
      if (trade.amountUsd < cfg.minTradeUsdToCopy) {
        rejected += 1;
        this.logRejection(
          candidate,
          `leader only traded $${trade.amountUsd.toFixed(2)}, below the $${cfg.minTradeUsdToCopy} floor to copy`,
        );
        continue;
      }
      // One signal per token per run, however many leaders piled in.
      if (seen.has(trade.tokenAddress)) continue;

      const traderScore = scoresByWallet.get(trade.wallet);
      if (!traderScore || traderScore.overall < cfg.minTraderScore) {
        rejected += 1;
        this.logRejection(
          candidate,
          `leader wallet ${shorten(trade.wallet)} scores ${(traderScore?.overall ?? 0).toFixed(0)}, ` +
            `below the ${cfg.minTraderScore} floor`,
        );
        continue;
      }

      const token = await this.market.getOne(trade.tokenAddress);
      if (!token || token.priceUsd <= 0) {
        rejected += 1;
        this.logRejection(candidate, 'no usable market price for this token');
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

      const social = await this.social.getSnapshot(token.address, token.symbol, token.name);
      const smart = this.smartMoney.countsFor(token.address, now - 7 * 24 * 60 * 60 * 1000);
      const score = this.scoring.score(
        token.address,
        cfg.weights,
        {
          market: token,
          onChain: null,
          social,
          security,
          trader: traderScore,
          history: this.repo.getHistory(token.address),
          smartMoneyBuys: smart.buys,
          smartMoneySells: smart.sells,
          now,
        },
        this.id,
      );
      scored.push(score.overall);

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

      seen.add(trade.tokenAddress);
      const risk = this.deps.config.get().risk;
      // Size in proportion to the leader's own conviction, then cap it.
      const proportional = trade.amountUsd * cfg.copyRatio;
      const requested = Math.min(cfg.maxTradeUsd, Math.max(risk.minPositionUsd, proportional));

      signals.push(
        this.buildSignal({
          market: token,
          score,
          action: 'BUY',
          confidence,
          requestedSizeUsd: requested,
          reason:
            `Followed wallet ${shorten(trade.wallet)} bought $${Math.round(trade.amountUsd).toLocaleString()} of ` +
            `${token.symbol || shorten(token.address)}. ${traderScore.reason} Token scored ${score.overall.toFixed(0)}/100 ` +
            `with security ${security.score.toFixed(0)}/100.`,
          riskFlags: [...traderScore.flags, ...security.flags.filter((f) => f.severity !== 'info')],
          stopLossPct: risk.stopLossPct,
          takeProfitPct: risk.takeProfitPct,
          metadata: {
            leaderWallet: trade.wallet,
            leaderTradeUsd: trade.amountUsd,
            leaderSignature: trade.signature,
            traderScore: traderScore.overall,
            securityScore: security.score,
          },
        }),
      );
    }

    return {
      agent: this.id,
      tokensScanned: freshTrades.length,
      signals,
      rejected,
      avgScore: scored.length > 0 ? scored.reduce((a, b) => a + b, 0) / scored.length : null,
      notes: {
        wallets: wallets.length,
        traderScores: Object.fromEntries([...scoresByWallet].map(([w, s]) => [shorten(w), s.overall])),
      },
    };
  }

  /**
   * Tokens a qualifying leader has just sold out of. The position manager uses
   * this to mirror exits when `mirrorExits` is on.
   */
  recentLeaderExits(sinceMs: number): Set<string> {
    const cfg = this.deps.config.get().agents.copy_trade;
    if (!cfg.mirrorExits) return new Set();
    const rows = this.db.select().from(traderTrades).all();
    const exits = new Set<string>();
    for (const row of rows) {
      if (row.side !== 'sell' || row.timestamp < sinceMs) continue;
      exits.add(row.tokenAddress);
    }
    return exits;
  }

  private ensureTraderRow(address: string, label: string): void {
    this.db
      .insert(traders)
      .values({ address, label, isFollowed: true, firstSeenAt: this.deps.clock.now() })
      .onConflictDoUpdate({ target: traders.address, set: { label, isFollowed: true } })
      .run();
  }

  /** Insert only the trades we have not already recorded, and return those. */
  private storeTrades(trades: WalletTrade[]): WalletTrade[] {
    const inserted: WalletTrade[] = [];
    for (const trade of trades) {
      const result = this.db
        .insert(traderTrades)
        .values({
          signature: trade.signature,
          wallet: trade.wallet,
          tokenAddress: trade.tokenAddress,
          side: trade.side,
          amountTokens: trade.amountTokens,
          amountUsd: trade.amountUsd,
          priceUsd: trade.priceUsd,
          timestamp: trade.timestamp,
        })
        .onConflictDoNothing()
        .run();
      // changes === 0 means we had already seen it, so it is not new activity.
      if (Number(result.changes ?? 0) > 0) inserted.push(trade);
    }
    if (inserted.length > 0) {
      const latest = Math.max(...inserted.map((t) => t.timestamp));
      const wallet = inserted[0]!.wallet;
      this.db
        .update(traders)
        .set({ lastTradeAt: latest, lastCheckedAt: this.deps.clock.now() })
        .where(eq(traders.address, wallet))
        .run();
    }
    return inserted;
  }

  private loadTrades(wallet: string): WalletTrade[] {
    return this.db
      .select()
      .from(traderTrades)
      .where(eq(traderTrades.wallet, wallet))
      .orderBy(desc(traderTrades.timestamp))
      .limit(500)
      .all()
      .map((r) => ({
        signature: r.signature,
        wallet: r.wallet,
        tokenAddress: r.tokenAddress,
        side: r.side as 'buy' | 'sell',
        amountTokens: r.amountTokens,
        amountUsd: r.amountUsd,
        priceUsd: r.priceUsd,
        timestamp: r.timestamp,
      }));
  }

  private storeTraderScore(score: TraderScore): void {
    this.db
      .insert(traderScores)
      .values({
        wallet: score.wallet,
        overall: score.overall,
        winRate: score.winRate,
        avgReturnPct: score.avgReturnPct,
        maxDrawdownPct: score.maxDrawdownPct,
        consistency: score.consistency,
        tradeCount: score.tradeCount,
        automationLikelihood: score.automationLikelihood,
        flags: score.flags,
        reason: score.reason,
        scoredAt: score.scoredAt,
      })
      .run();
  }
}

function shorten(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}
