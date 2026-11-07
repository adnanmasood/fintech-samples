import { desc, eq } from 'drizzle-orm';
import type { ConfigService } from '../config/config-service.js';
import type { Clock } from '../core/clock.js';
import type {
  Chain,
  RiskFlag,
  SecurityAssessment,
  TokenMarketSnapshot,
  TokenOnChainInfo,
} from '../core/types.js';
import type { Db } from '../db/client.js';
import { securityChecks, tokens } from '../db/schema.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { TokenSecurityProvider } from '../providers/interfaces.js';
import type { ListService } from './list-service.js';
import { ALL_RULES, SEVERITY_ORDER, runRules, scoreFromFlags, worstSeverity } from './rules.js';

/**
 * The security gate.
 *
 * This is a gate, not a score contribution. Nothing downstream may trade a
 * token this refuses, whatever the rest of its numbers look like. The score it
 * returns feeds the overall score as one dimension, but the verdict is
 * separate and absolute.
 *
 * Three ways to be refused:
 *   1. On the blacklist.
 *   2. Carrying a flag at or above the configured reject severity.
 *   3. No security provider reachable, with failClosed on.
 */
export class SecurityAgent {
  constructor(
    private readonly db: Db,
    private readonly config: ConfigService,
    private readonly provider: TokenSecurityProvider,
    private readonly lists: ListService,
    private readonly log: DecisionLog,
    private readonly clock: Clock,
  ) {}

  /** Cached assessment when one is fresh enough, otherwise null. */
  getCached(address: string): SecurityAssessment | null {
    const ttlMs = this.config.get().security.cacheTtlSec * 1_000;
    if (ttlMs <= 0) return null;
    const row = this.db
      .select()
      .from(securityChecks)
      .where(eq(securityChecks.tokenAddress, address))
      .orderBy(desc(securityChecks.checkedAt))
      .limit(1)
      .get();
    if (!row) return null;
    if (this.clock.now() - row.checkedAt > ttlMs) return null;
    // Never serve a stale pass for a token that has since been blacklisted.
    if (this.lists.isBlacklisted(address) && row.verdict !== 'reject') return null;
    return {
      address,
      chain: 'solana',
      verdict: row.verdict as SecurityAssessment['verdict'],
      score: row.score,
      flags: row.flags as RiskFlag[],
      listMatch: row.listMatch as SecurityAssessment['listMatch'],
      checkedAt: row.checkedAt,
      degraded: row.degraded,
    };
  }

  async assess(
    address: string,
    market: TokenMarketSnapshot | null,
    options: { chain?: Chain; force?: boolean } = {},
  ): Promise<SecurityAssessment> {
    const chain = options.chain ?? 'solana';
    if (!options.force) {
      const cached = this.getCached(address);
      if (cached) return cached;
    }

    const cfg = this.config.get().security;
    const now = this.clock.now();

    // The blacklist short-circuits everything. It is the cheapest check and
    // the most absolute, so it runs before any provider call.
    if (this.lists.isBlacklisted(address)) {
      return this.persist({
        address,
        chain,
        verdict: 'reject',
        score: 0,
        flags: [
          {
            code: 'BLACKLISTED',
            severity: 'critical',
            message: 'Token is on the blacklist.',
          },
        ],
        listMatch: 'blacklist',
        checkedAt: now,
        degraded: false,
      });
    }

    let onChain: TokenOnChainInfo | null = null;
    let providerFailed = false;
    if (this.provider.isConfigured()) {
      try {
        onChain = await this.provider.getOnChainInfo(address, chain);
        if (!onChain) providerFailed = true;
      } catch {
        providerFailed = true;
      }
    } else {
      providerFailed = true;
    }

    const flags = runRules(
      { address, market, onChain, config: cfg, now, knownSymbols: this.knownSymbols() },
      ALL_RULES,
    );

    // Without on-chain data the authority and holder rules simply cannot run,
    // so a clean sheet here means "we did not look", not "it is safe".
    //
    // Missing *data* is not a failed *check*, and the two must not be
    // conflated: a live mint or freeze authority is a real flaw and stays
    // `critical` in every mode via its own rule, unaffected by this branch.
    // This branch only covers the provider being unreachable, and live mode
    // always fails closed on that regardless of the stored setting — a config
    // mistake must not be able to fail live trading open. Paper mode honours
    // `cfg.failClosed` so the pipeline stays observable while a provider is
    // being wired up, without ever touching the live path.
    const degraded = providerFailed;
    if (degraded) {
      // The configured mode, not effectiveMode(): live must fail closed the
      // instant the config asks for it, not only once a wallet also happens
      // to be armed. Nothing about missing data should ever depend on that.
      const failClosed = this.config.get().mode === 'live' ? true : cfg.failClosed;
      flags.push({
        code: 'SECURITY_DATA_UNAVAILABLE',
        severity: failClosed ? 'critical' : 'medium',
        message: failClosed
          ? 'On-chain security data is unavailable, so the token is refused rather than assumed safe.'
          : 'On-chain security data is unavailable; contract checks could not run. Continuing in paper ' +
            'mode with a score penalty rather than a hard refusal.',
        evidence: { provider: this.provider.name, configured: this.provider.isConfigured() },
      });
    }

    const score = scoreFromFlags(flags);
    const worst = worstSeverity(flags);
    const rejectThreshold = SEVERITY_ORDER[cfg.rejectAtSeverity];

    let verdict: SecurityAssessment['verdict'] = 'pass';
    if (worst && SEVERITY_ORDER[worst] >= rejectThreshold) verdict = 'reject';
    else if (worst && SEVERITY_ORDER[worst] >= SEVERITY_ORDER.medium) verdict = 'warn';

    // The whitelist can lift a rules-based rejection, because a user vouching
    // for a token is a deliberate act. It cannot lift a critical flag: those
    // are the ones that take your money, and no amount of vouching changes it.
    let listMatch: SecurityAssessment['listMatch'] = null;
    if (this.lists.isWhitelisted(address)) {
      listMatch = 'whitelist';
      if (verdict === 'reject' && worst !== 'critical') {
        verdict = 'warn';
        flags.push({
          code: 'WHITELIST_OVERRIDE',
          severity: 'info',
          message: 'Token is whitelisted, so a non-critical rejection was downgraded to a warning.',
        });
      }
    }

    const assessment: SecurityAssessment = {
      address,
      chain,
      verdict,
      score,
      flags,
      listMatch,
      checkedAt: now,
      degraded,
    };

    if (verdict === 'reject') {
      this.log.record({
        level: 'warn',
        category: 'security',
        tokenAddress: address,
        message: `Security refused ${market?.symbol || address.slice(0, 8)}: ${flags[0]?.message ?? 'failed checks'}`,
        payload: { score, flags, degraded },
      });
      // A critical contract flag is permanent, so remember it rather than
      // paying for the same provider call again on the next scan.
      if (worst === 'critical' && !degraded) {
        this.lists.add('blacklist', address, {
          symbol: market?.symbol ?? '',
          reason: flags[0]?.message ?? 'critical security flag',
          source: 'security-agent',
        });
      }
    }

    return this.persist(assessment);
  }

  private persist(assessment: SecurityAssessment): SecurityAssessment {
    try {
      this.db
        .insert(securityChecks)
        .values({
          tokenAddress: assessment.address,
          verdict: assessment.verdict,
          score: assessment.score,
          flags: assessment.flags,
          listMatch: assessment.listMatch,
          degraded: assessment.degraded,
          checkedAt: assessment.checkedAt,
        })
        .run();
    } catch {
      // The verdict is what matters; a failed audit write must not block it.
    }
    return assessment;
  }

  /** Symbol to canonical address, for the impersonation rule. */
  private knownSymbols(): Map<string, string> {
    const rows = this.db
      .select({ address: tokens.address, symbol: tokens.symbol })
      .from(tokens)
      .all();
    const map = new Map<string, string>();
    for (const row of rows) {
      const symbol = row.symbol.trim().toUpperCase();
      if (!symbol) continue;
      // First seen wins: the older token is treated as the real one.
      if (!map.has(symbol)) map.set(symbol, row.address);
    }
    return map;
  }
}
