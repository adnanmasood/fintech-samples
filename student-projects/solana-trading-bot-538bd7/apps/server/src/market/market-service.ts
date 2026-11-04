import type { ConfigService } from '../config/config-service.js';
import type { Chain, TokenMarketSnapshot } from '../core/types.js';
import type { DecisionLog } from '../observability/decision-log.js';
import type { MarketDataProvider } from '../providers/interfaces.js';
import type { TokenRepository } from './token-repository.js';
import { checkMarketSnapshot } from './sanity.js';

/**
 * Discovery and refresh.
 *
 * Sits between the raw market provider and the agents so that every agent
 * shares one candidate list per cycle instead of each hammering the provider
 * with its own sweep. Everything it returns is already stored, so the history
 * the scoring engine needs builds up as a side effect of normal operation.
 */
export class MarketService {
  constructor(
    private readonly provider: MarketDataProvider,
    private readonly repo: TokenRepository,
    private readonly config: ConfigService,
    private readonly log: DecisionLog,
  ) {}

  /**
   * The shared candidate list. Search results and new pairs, de-duplicated,
   * sanity-checked, filtered by the discovery liquidity floor and capped.
   */
  async discover(chain: Chain = 'solana'): Promise<TokenMarketSnapshot[]> {
    const cfg = this.config.get().discovery;
    const [searched, fresh] = await Promise.all([
      this.provider.searchTokens(cfg.searchTerms, chain, cfg.maxTokensPerScan).catch(() => []),
      this.provider.getNewPairs(chain, Math.ceil(cfg.maxTokensPerScan / 2)).catch(() => []),
    ]);

    const byAddress = new Map<string, TokenMarketSnapshot>();
    for (const snapshot of [...searched, ...fresh]) {
      if (snapshot.liquidityUsd < cfg.minLiquidityUsd) continue;

      // A search endpoint with no sanity checking of its own will happily
      // hand back an impostor "USDC" or a feed row with a trillion-dollar
      // market cap on $20 of volume. Catch it here, once, rather than trust
      // every downstream stage to notice.
      const bad = checkMarketSnapshot(snapshot);
      if (bad) {
        this.log.record({
          level: 'warn',
          category: 'security',
          tokenAddress: snapshot.address,
          message: `Discarded ${snapshot.symbol || snapshot.address.slice(0, 8)} at ingestion: ${bad.message}`,
          payload: { code: bad.code, snapshot },
        });
        continue;
      }

      // Keep whichever copy has the deeper pool; the two feeds can disagree.
      const existing = byAddress.get(snapshot.address);
      if (!existing || snapshot.liquidityUsd > existing.liquidityUsd) {
        byAddress.set(snapshot.address, snapshot);
      }
    }

    const list = [...byAddress.values()]
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, cfg.maxTokensPerScan);

    this.repo.upsertMany(list);
    return list;
  }

  /** Refresh specific tokens, for marking open positions to market. */
  async refresh(addresses: string[], chain: Chain = 'solana'): Promise<Map<string, TokenMarketSnapshot>> {
    if (addresses.length === 0) return new Map();
    const snapshots = await this.provider.getTokenSnapshots(addresses, chain).catch(() => []);
    this.repo.upsertMany(snapshots);
    const out = new Map<string, TokenMarketSnapshot>();
    for (const snapshot of snapshots) out.set(snapshot.address, snapshot);
    // Anything the provider could not price falls back to the last stored
    // snapshot, so a provider blip cannot make a position look worthless.
    for (const address of addresses) {
      if (out.has(address)) continue;
      const stored = this.repo.get(address);
      if (stored) out.set(address, stored);
    }
    return out;
  }

  async getOne(address: string, chain: Chain = 'solana'): Promise<TokenMarketSnapshot | null> {
    const snapshot = await this.provider.getTokenSnapshot(address, chain).catch(() => null);
    if (snapshot) {
      this.repo.upsert(snapshot);
      return snapshot;
    }
    return this.repo.get(address);
  }
}
