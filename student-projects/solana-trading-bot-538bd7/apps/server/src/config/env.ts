import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * `.env` lives at the repo root (that is where `.env.example` and the README
 * point), but this package's scripts run with the working directory set to
 * `apps/server`. Loading `.env` with no path resolves it against `cwd`, which
 * would silently miss the real file and leave every secret unset. Anchoring
 * the lookup to this file's own location, four directories up, finds the
 * repo root regardless of where the process was launched from.
 *
 * Tests are the one exception: they must never pick up a developer's real
 * wallet key or API keys from a local `.env`, or a suite's outcome would
 * depend on whoever's machine it runs on. Vitest sets NODE_ENV to `test`
 * before this module loads, so the file is simply never read there.
 */
if (process.env.NODE_ENV !== 'test') {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const rootEnvPath = resolve(repoRoot, '.env');
  loadDotenv({ path: existsSync(rootEnvPath) ? rootEnvPath : undefined });
}

/**
 * Secrets and machine-level settings.
 *
 * Nothing here is ever serialised to the API, written to the database, or
 * logged. `describeEnv()` is the only thing allowed out, and it reports
 * presence rather than values.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().default('file:./data/usf.db'),

  TRADING_MODE: z.enum(['paper', 'live']).default('paper'),

  SOLANA_RPC_URL: z.string().url().default('https://api.mainnet-beta.solana.com'),
  SOLANA_RPC_API_KEY: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),

  WALLET_PRIVATE_KEY: z.string().optional(),

  LUNARCRUSH_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('meta-llama/llama-3.3-70b-instruct:free'),

  CORS_ORIGINS: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test seam. Never called by the running app. */
export function resetEnvCache(): void {
  cached = null;
}

export function hasWallet(env = getEnv()): boolean {
  return typeof env.WALLET_PRIVATE_KEY === 'string' && env.WALLET_PRIVATE_KEY.length > 0;
}

/** Safe to serve over the API: presence only, never a value. */
export interface EnvReport {
  nodeEnv: string;
  walletConfigured: boolean;
  providers: Record<string, boolean>;
}

export function describeEnv(env = getEnv()): EnvReport {
  return {
    nodeEnv: env.NODE_ENV,
    walletConfigured: hasWallet(env),
    providers: {
      solanaRpc: Boolean(env.SOLANA_RPC_URL),
      helius: Boolean(env.HELIUS_API_KEY),
      lunarcrush: Boolean(env.LUNARCRUSH_API_KEY),
      openrouter: Boolean(env.OPENROUTER_API_KEY),
      dexscreener: true,
      jupiter: true,
    },
  };
}

/**
 * Redact anything that looks like a secret before it reaches a log line.
 * Belt and braces: secrets are not supposed to be passed to the logger at all.
 */
const SECRET_KEY_PATTERN = /(secret|private|password|api[_-]?key|token|authorization|mnemonic|seed)/i;

export function redact<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redact(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redact(val);
    }
    return out as unknown as T;
  }
  return value;
}
