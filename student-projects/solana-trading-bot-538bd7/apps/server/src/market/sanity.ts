import type { TokenMarketSnapshot } from '../core/types.js';

/**
 * Ingestion sanity checks.
 *
 * DexScreener's symbol search returns whatever anyone named their mint; a scam
 * deployer can call their token "USDC" or "SOL" and dexscreener will hand it
 * back like any other result. Nothing downstream is safe from that on its
 * own: the security gate assesses the token it is given, it does not ask
 * whether the token is the one the symbol claims to be.
 *
 * These checks run once, at the point candidates enter the system, so a
 * garbage row never reaches an agent, let alone a score or a signal.
 */

/** Mint address for a handful of symbols people impersonate constantly. */
export const CANONICAL_MINTS: Record<string, string> = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
};

/**
 * No legitimate token this platform would ever consider trades anywhere near
 * these numbers. They are deliberately far above what a real small or
 * mid-cap pair looks like, so this only ever catches feed garbage, never a
 * real candidate having a genuinely wild day.
 */
const MAX_PLAUSIBLE_MARKET_CAP_USD = 50_000_000_000;
const MAX_PLAUSIBLE_ABS_24H_CHANGE_PCT = 2_000;
/** A claimed cap this many times the pool behind it is not a real price. */
const MAX_MARKET_CAP_TO_LIQUIDITY_RATIO = 100_000;

export interface SanityRejection {
  code: string;
  message: string;
}

/**
 * `null` means the row passes. A non-null result is the reason it was
 * dropped, so a caller can log it rather than silently discarding it.
 */
export function checkMarketSnapshot(snapshot: TokenMarketSnapshot): SanityRejection | null {
  const symbol = snapshot.symbol.trim().toUpperCase();
  const canonical = symbol ? CANONICAL_MINTS[symbol] : undefined;
  if (canonical && canonical !== snapshot.address) {
    return {
      code: 'IMPOSTOR_SYMBOL',
      message: `Claims to be ${symbol} but its mint does not match the real ${symbol} address.`,
    };
  }

  if (snapshot.marketCapUsd != null && snapshot.marketCapUsd > MAX_PLAUSIBLE_MARKET_CAP_USD) {
    return {
      code: 'IMPLAUSIBLE_MARKET_CAP',
      message: `Reports a $${snapshot.marketCapUsd.toLocaleString()} market cap, which is not credible for a pair discovered this way.`,
    };
  }

  if (
    snapshot.priceChange24h != null &&
    Math.abs(snapshot.priceChange24h) > MAX_PLAUSIBLE_ABS_24H_CHANGE_PCT
  ) {
    return {
      code: 'IMPLAUSIBLE_PRICE_CHANGE',
      message: `Reports a ${snapshot.priceChange24h.toFixed(0)}% 24h move, which reads as a bad feed rather than a real price.`,
    };
  }

  if (
    snapshot.marketCapUsd != null &&
    snapshot.marketCapUsd > 1_000_000 &&
    snapshot.liquidityUsd < snapshot.marketCapUsd / MAX_MARKET_CAP_TO_LIQUIDITY_RATIO
  ) {
    return {
      code: 'MARKET_CAP_LIQUIDITY_MISMATCH',
      message:
        `Reports a $${Math.round(snapshot.marketCapUsd).toLocaleString()} market cap on ` +
        `$${snapshot.liquidityUsd.toLocaleString()} of liquidity, too thin to back that price.`,
    };
  }

  return null;
}
