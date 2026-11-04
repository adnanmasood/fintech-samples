import type { Env } from '../config/env.js';
import { DexScreenerProvider } from './market/dexscreener.js';
import { HeliusProvider } from './blockchain/helius.js';
import { JupiterProvider } from './dex/jupiter.js';
import { LunarCrushProvider } from './social/lunarcrush.js';
import { NewsFeedSocialProvider } from './social/news-feed.js';
import { CompositeSocialProvider } from './social/composite.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import {
  NullBlockchainProvider,
  NullSecurityProvider,
} from './mocks.js';
import type { ProviderRegistry } from './interfaces.js';
import { WSOL_MINT } from '../config/defaults.js';

/**
 * The composition point for every outside dependency.
 *
 * A missing key does not crash the app and does not silently fake data: it
 * wires a null provider whose `isConfigured()` is false, which the security
 * gate and the health endpoint both read. The system runs with nothing
 * configured at all; it simply refuses to trade, which is the correct answer.
 */
export function buildProviderRegistry(env: Env): ProviderRegistry {
  const market = new DexScreenerProvider();
  const dex = new JupiterProvider();

  // Both the copy agent and the security agent need SOL priced in USD, and
  // Jupiter already answers that, so the blockchain provider borrows it
  // rather than pulling in another vendor.
  const solPriceUsd = () => dex.getPriceUsd(WSOL_MINT);

  const helius = new HeliusProvider(
    env.HELIUS_API_KEY,
    env.SOLANA_RPC_URL,
    env.SOLANA_RPC_API_KEY,
    solPriceUsd,
  );

  // The news feed needs no key and cannot be rate-limited into silence, so it
  // is always wired in. LunarCrush layers on top of it when a key is present:
  // its public v4 endpoints currently answer 402 (payment required) on the
  // free tier, so every call falls through to the news feed until that
  // changes, rather than leaving the social dimension empty.
  const newsFeed = new NewsFeedSocialProvider();
  const social = env.LUNARCRUSH_API_KEY
    ? new CompositeSocialProvider(new LunarCrushProvider(env.LUNARCRUSH_API_KEY), newsFeed)
    : newsFeed;

  const llm = new OpenRouterProvider(env.OPENROUTER_API_KEY, env.OPENROUTER_MODEL);

  return {
    market,
    dex,
    social,
    llm,
    blockchain: helius.isConfigured() ? helius : new NullBlockchainProvider(),
    security: helius.isConfigured() ? helius : new NullSecurityProvider(),
  };
}

export interface ProviderHealth {
  name: string;
  role: string;
  configured: boolean;
  reachable: boolean | null;
}

/** Reports what is wired and what actually answers. Never leaks a key. */
export async function checkProviderHealth(
  registry: ProviderRegistry,
  probe = false,
): Promise<ProviderHealth[]> {
  const entries = Object.entries(registry) as Array<[string, ProviderRegistry[keyof ProviderRegistry]]>;
  return Promise.all(
    entries.map(async ([role, provider]) => {
      const configured = provider.isConfigured();
      let reachable: boolean | null = null;
      if (probe && configured && typeof provider.healthCheck === 'function') {
        reachable = await provider.healthCheck().catch(() => false);
      }
      return { name: provider.name, role, configured, reachable };
    }),
  );
}
