import { eq } from 'drizzle-orm';
import { ConfigError } from '../core/errors.js';
import type { Db } from '../db/client.js';
import { settings, settingsHistory } from '../db/schema.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { tradingConfigSchema, type TradingConfig } from './schema.js';
import { getEnv, hasWallet } from './env.js';

export type ConfigListener = (config: TradingConfig, previous: TradingConfig) => void;

/**
 * The single source of truth for every tunable parameter.
 *
 * Held in one database row, validated by zod on every write, and versioned so
 * a bad edit can be traced. Nothing else in the system reads a hard-coded
 * trading number: they all call `get()`.
 *
 * The mode is special. Setting it to live in here is necessary but not
 * sufficient; a wallet private key has to be configured too, and
 * `effectiveMode()` is what the rest of the system actually asks.
 */
export class ConfigService {
  private current: TradingConfig;
  private readonly listeners = new Set<ConfigListener>();
  /**
   * Whether a usable wallet exists. Defaults to the environment so the service
   * is constructible on its own; `app.ts` replaces it with the WalletService's
   * own view, which also covers a key saved from the dashboard.
   */
  private walletArmed: () => boolean = () => hasWallet(getEnv());

  private constructor(
    private readonly db: Db,
    initial: TradingConfig,
  ) {
    this.current = initial;
  }

  static load(db: Db): ConfigService {
    const row = db.select().from(settings).where(eq(settings.id, 1)).get();
    if (!row) {
      const parsed = tradingConfigSchema.parse(DEFAULT_CONFIG);
      db.insert(settings)
        .values({ id: 1, config: parsed as unknown as Record<string, unknown>, version: parsed.version, updatedAt: Date.now() })
        .run();
      return new ConfigService(db, parsed);
    }
    const parsed = tradingConfigSchema.safeParse(row.config);
    if (!parsed.success) {
      // A stored config that no longer validates (an older shape, a hand edit)
      // must not stop the app. Merge it over the defaults and re-validate; if
      // it still fails, fall back to defaults entirely rather than guessing.
      const merged = tradingConfigSchema.safeParse({
        ...DEFAULT_CONFIG,
        ...(row.config as object),
      });
      const recovered = merged.success ? merged.data : tradingConfigSchema.parse(DEFAULT_CONFIG);
      db.update(settings)
        .set({ config: recovered as unknown as Record<string, unknown>, updatedAt: Date.now() })
        .where(eq(settings.id, 1))
        .run();
      return new ConfigService(db, recovered);
    }
    return new ConfigService(db, parsed.data);
  }

  get(): TradingConfig {
    return this.current;
  }

  /** Point the wallet check at the real WalletService. */
  setWalletProbe(probe: () => boolean): void {
    this.walletArmed = probe;
  }

  /** Live trading requires a wallet AND explicit server-side operator opt-in. */
  effectiveMode(): 'paper' | 'live' {
    if (this.current.mode !== 'live') return 'paper';
    if (getEnv().LIVE_TRADING_OPT_IN !== 'I_ACCEPT_REAL_FINANCIAL_RISK') return 'paper';
    return this.walletArmed() ? 'live' : 'paper';
  }

  /** True when a live request is blocked by the operator opt-in or wallet gate. */
  isLiveRequestedButNotArmed(): boolean {
    return this.current.mode === 'live' && this.effectiveMode() !== 'live';
  }

  onChange(listener: ConfigListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Deep-merge a partial update, validate the result, and persist it. */
  update(patch: DeepPartial<TradingConfig>, changedBy = 'api', note = ''): TradingConfig {
    const candidate = deepMerge(this.current, patch);
    const parsed = tradingConfigSchema.safeParse({
      ...candidate,
      version: this.current.version + 1,
    });
    if (!parsed.success) {
      throw new ConfigError('Configuration is not valid', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const previous = this.current;
    const next = parsed.data;

    this.db.transaction((tx) => {
      tx.update(settings)
        .set({
          config: next as unknown as Record<string, unknown>,
          version: next.version,
          updatedAt: Date.now(),
        })
        .where(eq(settings.id, 1))
        .run();
      tx.insert(settingsHistory)
        .values({
          version: next.version,
          config: next as unknown as Record<string, unknown>,
          changedBy,
          note,
          createdAt: Date.now(),
        })
        .run();
    });

    this.current = next;
    for (const listener of this.listeners) {
      // A misbehaving listener must not roll back a valid config change.
      try {
        listener(next, previous);
      } catch {
        /* ignore */
      }
    }
    return next;
  }

  /** Flip the kill switch without going through a full config patch. */
  setKillSwitch(on: boolean, changedBy = 'api'): TradingConfig {
    return this.update(
      { risk: { killSwitch: on } },
      changedBy,
      on ? 'kill switch engaged' : 'kill switch released',
    );
  }

  history(limit = 20) {
    return this.db.select().from(settingsHistory).orderBy(settingsHistory.version).limit(limit).all();
  }

  resetToDefaults(changedBy = 'api'): TradingConfig {
    const next = tradingConfigSchema.parse({
      ...DEFAULT_CONFIG,
      version: this.current.version + 1,
    });
    this.db.transaction((tx) => {
      tx.update(settings)
        .set({
          config: next as unknown as Record<string, unknown>,
          version: next.version,
          updatedAt: Date.now(),
        })
        .where(eq(settings.id, 1))
        .run();
      tx.insert(settingsHistory)
        .values({
          version: next.version,
          config: next as unknown as Record<string, unknown>,
          changedBy,
          note: 'reset to defaults',
          createdAt: Date.now(),
        })
        .run();
    });
    const previous = this.current;
    this.current = next;
    for (const listener of this.listeners) {
      try {
        listener(next, previous);
      } catch {
        /* ignore */
      }
    }
    return next;
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Merge a patch into a config. Arrays replace rather than concatenate, which
 * is what a caller means by "here is my new wallet list".
 */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch)) return patch as unknown as T;
  if (typeof base !== 'object' || base === null) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing, value as DeepPartial<unknown>);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}
