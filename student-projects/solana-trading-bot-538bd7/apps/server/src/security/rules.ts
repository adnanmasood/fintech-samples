import type { SecurityConfig } from '../config/schema.js';
import type {
  RiskFlag,
  RiskSeverity,
  TokenMarketSnapshot,
  TokenOnChainInfo,
} from '../core/types.js';
import { sum } from '../core/money.js';

/**
 * The security rules.
 *
 * Each rule is a pure function of the data plus the config, so every one is
 * unit testable in isolation and none of them can reach the network.
 *
 * Severity ladder, and the reasoning behind it:
 *   critical - the token can take your money or trap it. Never tradeable.
 *   high     - a strong rug or manipulation signal. Rejected by default.
 *   medium   - a real concern that should cost score but need not veto.
 *   low/info - worth recording, not worth acting on alone.
 */

export interface SecurityRuleInput {
  address: string;
  market: TokenMarketSnapshot | null;
  onChain: TokenOnChainInfo | null;
  config: SecurityConfig;
  now: number;
  /** Symbols already known to the system, for the impersonation check. */
  knownSymbols?: Map<string, string>;
}

export type SecurityRule = (input: SecurityRuleInput) => RiskFlag | null;

export const SEVERITY_ORDER: Record<RiskSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Score cost per flag. Deliberately steep at the top of the ladder. */
const SEVERITY_PENALTY: Record<RiskSeverity, number> = {
  info: 0,
  low: 4,
  medium: 12,
  high: 28,
  critical: 100,
};

// --- Contract control -------------------------------------------------------

/**
 * A live mint authority means the deployer can print supply at will and dilute
 * every holder to nothing. This is the single most common rug on Solana.
 */
export const mintAuthorityRule: SecurityRule = ({ onChain, config }) => {
  if (!onChain || !config.requireMintAuthorityRevoked) return null;
  if (!onChain.mintAuthority) return null;
  return {
    code: 'MINT_AUTHORITY_ACTIVE',
    severity: 'critical',
    message: 'The deployer can still mint new supply, so holdings can be diluted at any time.',
    evidence: { mintAuthority: onChain.mintAuthority },
  };
};

/**
 * A freeze authority can freeze your token account, which is a honeypot by
 * another name: you can buy and then never sell.
 */
export const freezeAuthorityRule: SecurityRule = ({ onChain, config }) => {
  if (!onChain || !config.requireFreezeAuthorityRevoked) return null;
  if (!onChain.freezeAuthority) return null;
  return {
    code: 'FREEZE_AUTHORITY_ACTIVE',
    severity: 'critical',
    message: 'The deployer can freeze token accounts, which would trap the position.',
    evidence: { freezeAuthority: onChain.freezeAuthority },
  };
};

export const mutableMetadataRule: SecurityRule = ({ onChain }) => {
  if (!onChain || onChain.isMutable !== true) return null;
  return {
    code: 'METADATA_MUTABLE',
    severity: 'low',
    message: 'Token metadata can still be changed after launch.',
  };
};

// --- Taxes and transfer restrictions ---------------------------------------

export const buyTaxRule: SecurityRule = ({ onChain, config }) => {
  const tax = onChain?.buyTaxBps;
  if (tax == null) return null;
  if (tax <= config.maxBuyTaxBps) return null;
  return {
    code: 'BUY_TAX_TOO_HIGH',
    severity: tax >= 2_000 ? 'critical' : 'high',
    message: `Buy tax of ${(tax / 100).toFixed(1)}% is above the ${(config.maxBuyTaxBps / 100).toFixed(1)}% limit.`,
    evidence: { buyTaxBps: tax, limitBps: config.maxBuyTaxBps },
  };
};

export const sellTaxRule: SecurityRule = ({ onChain, config }) => {
  const tax = onChain?.sellTaxBps;
  if (tax == null) return null;
  if (tax <= config.maxSellTaxBps) return null;
  return {
    code: 'SELL_TAX_TOO_HIGH',
    // A punitive sell tax is a honeypot: the exit exists but costs everything.
    severity: tax >= 2_000 ? 'critical' : 'high',
    message: `Sell tax of ${(tax / 100).toFixed(1)}% is above the ${(config.maxSellTaxBps / 100).toFixed(1)}% limit.`,
    evidence: { sellTaxBps: tax, limitBps: config.maxSellTaxBps },
  };
};

export const transferFeeRule: SecurityRule = ({ onChain }) => {
  const fee = onChain?.transferFeeBps;
  if (fee == null || fee === 0) return null;
  return {
    code: 'TRANSFER_FEE',
    severity: fee > 1_000 ? 'high' : 'medium',
    message: `Every transfer is charged ${(fee / 100).toFixed(1)}%.`,
    evidence: { transferFeeBps: fee },
  };
};

// --- Liquidity --------------------------------------------------------------

export const liquidityFloorRule: SecurityRule = ({ market, config }) => {
  if (!market) return null;
  if (market.liquidityUsd >= config.minLiquidityUsd) return null;
  return {
    code: 'LIQUIDITY_TOO_LOW',
    severity: market.liquidityUsd < config.minLiquidityUsd / 4 ? 'critical' : 'high',
    message: `Pool holds $${Math.round(market.liquidityUsd).toLocaleString()}, below the $${config.minLiquidityUsd.toLocaleString()} floor.`,
    evidence: { liquidityUsd: market.liquidityUsd, floor: config.minLiquidityUsd },
  };
};

/**
 * Liquidity that is not locked or burned can be pulled by whoever holds the LP
 * tokens, which is the classic rug. Unknown lock state is not a flag; the
 * provider simply may not report it.
 */
export const lpLockRule: SecurityRule = ({ onChain, config }) => {
  const locked = onChain?.lpLockedFraction;
  if (locked == null || config.minLpLockedFraction <= 0) return null;
  if (locked >= config.minLpLockedFraction) return null;
  return {
    code: 'LP_NOT_LOCKED',
    severity: locked < 0.1 ? 'critical' : 'high',
    message: `Only ${(locked * 100).toFixed(0)}% of the pool is locked or burned, so the rest can be withdrawn.`,
    evidence: { lpLockedFraction: locked, required: config.minLpLockedFraction },
  };
};

// --- Holder distribution ----------------------------------------------------

export const topHolderRule: SecurityRule = ({ onChain, config }) => {
  const top = onChain?.topHolderShares?.[0];
  if (top == null) return null;
  const pct = top * 100;
  if (pct <= config.maxTopHolderPct) return null;
  return {
    code: 'TOP_HOLDER_CONCENTRATION',
    severity: pct > 50 ? 'critical' : 'high',
    message: `One wallet holds ${pct.toFixed(1)}% of supply and could exit into the pool alone.`,
    evidence: { topHolderPct: pct, limit: config.maxTopHolderPct },
  };
};

export const top10HolderRule: SecurityRule = ({ onChain, config }) => {
  const shares = onChain?.topHolderShares;
  if (!shares || shares.length === 0) return null;
  const pct = sum(shares.slice(0, 10)) * 100;
  if (pct <= config.maxTop10HolderPct) return null;
  return {
    code: 'TOP10_HOLDER_CONCENTRATION',
    severity: pct > 85 ? 'high' : 'medium',
    message: `The ten largest wallets hold ${pct.toFixed(1)}% of supply.`,
    evidence: { top10Pct: pct, limit: config.maxTop10HolderPct },
  };
};

// --- Age --------------------------------------------------------------------

export const tokenAgeRule: SecurityRule = ({ market, config, now }) => {
  const created = market?.pairCreatedAt;
  if (created == null) return null;
  const ageMinutes = (now - created) / 60_000;
  if (ageMinutes >= config.minTokenAgeMinutes) return null;
  return {
    code: 'TOKEN_TOO_NEW',
    severity: ageMinutes < config.minTokenAgeMinutes / 3 ? 'high' : 'medium',
    message: `Pair is ${Math.max(0, Math.round(ageMinutes))} minutes old, below the ${config.minTokenAgeMinutes} minute floor.`,
    evidence: { ageMinutes, floor: config.minTokenAgeMinutes },
  };
};

// --- Manipulation -----------------------------------------------------------

/**
 * Volume many times the pool's own depth usually means the same coins are
 * being cycled to fake activity, because real buyers would have moved the
 * price long before turning the pool over that many times.
 */
export const washTradingRule: SecurityRule = ({ market, config }) => {
  if (!market || market.liquidityUsd <= 0) return null;
  const ratio = market.volume24hUsd / market.liquidityUsd;
  if (ratio <= config.maxVolumeToLiquidityRatio) return null;
  return {
    code: 'VOLUME_LOOKS_MANIPULATED',
    severity: ratio > config.maxVolumeToLiquidityRatio * 2.5 ? 'high' : 'medium',
    message: `24h volume is ${ratio.toFixed(1)}x the pool size, which is a wash-trading pattern.`,
    evidence: { volumeToLiquidity: ratio, limit: config.maxVolumeToLiquidityRatio },
  };
};

/**
 * Buys hugely outnumbering sells (or the reverse) with no organic middle is
 * what a bot cycle looks like. Real trading is messier than that.
 */
export const buySellImbalanceRule: SecurityRule = ({ market, config }) => {
  if (!market) return null;
  const buys = market.buys24h;
  const sells = market.sells24h;
  if (buys == null || sells == null) return null;
  if (buys + sells < 50) return null; // Too small a sample to read anything into.
  const ratio = sells === 0 ? Number.POSITIVE_INFINITY : buys / sells;
  const inverse = buys === 0 ? Number.POSITIVE_INFINITY : sells / buys;
  const worst = Math.max(ratio, inverse);
  if (worst <= config.maxBuySellImbalance) return null;
  return {
    code: 'BUY_SELL_IMBALANCE',
    severity: 'medium',
    message: `Buys and sells are ${Number.isFinite(worst) ? worst.toFixed(1) : 'extremely'}x apart, which looks automated.`,
    evidence: { buys, sells, ratio: Number.isFinite(worst) ? worst : null },
  };
};

/**
 * A token whose symbol matches something already known but whose address does
 * not is impersonating it. This is how fake versions of popular tokens get
 * bought by accident.
 */
export const impersonationRule: SecurityRule = ({ market, address, knownSymbols }) => {
  if (!market || !knownSymbols) return null;
  const symbol = market.symbol.trim().toUpperCase();
  if (!symbol) return null;
  const knownAddress = knownSymbols.get(symbol);
  if (!knownAddress || knownAddress === address) return null;
  return {
    code: 'DUPLICATE_SYMBOL',
    severity: 'high',
    message: `Another token already trades as ${symbol}, so this one may be impersonating it.`,
    evidence: { symbol, knownAddress, thisAddress: address },
  };
};

/** A missing symbol or name is not fatal, but it is a poor sign. */
export const missingMetadataRule: SecurityRule = ({ market }) => {
  if (!market) return null;
  if (market.symbol.trim() && market.name.trim()) return null;
  return {
    code: 'INCOMPLETE_METADATA',
    severity: 'low',
    message: 'Token is missing a name or a symbol.',
  };
};

/**
 * A price of zero means nothing can be sized, priced or stopped correctly.
 * Treat it as unusable rather than cheap.
 */
export const priceSanityRule: SecurityRule = ({ market }) => {
  if (!market) return null;
  if (market.priceUsd > 0) return null;
  return {
    code: 'NO_USABLE_PRICE',
    severity: 'critical',
    message: 'No usable USD price, so the position could not be sized or stopped.',
  };
};

export const ALL_RULES: SecurityRule[] = [
  mintAuthorityRule,
  freezeAuthorityRule,
  mutableMetadataRule,
  buyTaxRule,
  sellTaxRule,
  transferFeeRule,
  liquidityFloorRule,
  lpLockRule,
  topHolderRule,
  top10HolderRule,
  tokenAgeRule,
  washTradingRule,
  buySellImbalanceRule,
  impersonationRule,
  missingMetadataRule,
  priceSanityRule,
];

export function runRules(input: SecurityRuleInput, rules: SecurityRule[] = ALL_RULES): RiskFlag[] {
  const flags: RiskFlag[] = [];
  for (const rule of rules) {
    const flag = rule(input);
    if (flag) flags.push(flag);
  }
  return flags.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}

/** 100 minus the penalties, floored at zero. */
export function scoreFromFlags(flags: RiskFlag[]): number {
  const penalty = flags.reduce((acc, f) => acc + SEVERITY_PENALTY[f.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

export function worstSeverity(flags: RiskFlag[]): RiskSeverity | null {
  if (flags.length === 0) return null;
  return flags.reduce<RiskSeverity>(
    (worst, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[worst] ? f.severity : worst),
    'info',
  );
}
