/**
 * The activity log.
 *
 * A window onto what the system is actually doing between decisions: every
 * outbound provider call and every application log line, in one place and in
 * order.
 *
 * It is a fixed-size in-memory ring rather than a table on purpose. These
 * entries arrive at hundreds per minute, they are only ever interesting while
 * they are recent, and writing each one to SQLite would put provider chatter
 * on the same disk path as the trade ledger. The decision log is the durable
 * record; this is the live feed.
 */

export type ActivityKind = 'http' | 'log';

export interface HttpActivity {
  id: number;
  kind: 'http';
  at: number;
  provider: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status: number | null;
  durationMs: number;
  /** True when the response came from the client's own cache, costing no call. */
  cached: boolean;
  ok: boolean;
  error: string | null;
  attempt: number;
}

export interface LogActivity {
  id: number;
  kind: 'log';
  at: number;
  level: string;
  message: string;
  context: Record<string, unknown> | null;
}

export type ActivityEntry = HttpActivity | LogActivity;

export interface ProviderCallStats {
  provider: string;
  calls: number;
  cached: number;
  errors: number;
  avgMs: number;
  lastAt: number | null;
}

const DEFAULT_CAPACITY = 600;

export class ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private nextId = 1;

  constructor(private readonly capacity = DEFAULT_CAPACITY) {}

  recordHttp(entry: Omit<HttpActivity, 'id' | 'kind' | 'at'> & { at?: number }): void {
    const { at, ...rest } = entry;
    this.push({ id: this.nextId++, kind: 'http', at: at ?? Date.now(), ...rest });
  }

  recordLog(level: string, message: string, context?: Record<string, unknown> | null): void {
    this.push({
      id: this.nextId++,
      kind: 'log',
      at: Date.now(),
      level,
      message,
      context: context ?? null,
    });
  }

  private push(entry: ActivityEntry): void {
    this.entries.push(entry);
    // Trim from the front once over capacity. shift() on a few hundred entries
    // is cheap and keeps the array in chronological order for free.
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  /** Newest first, which is how anyone reads a live feed. */
  list(options: { kind?: ActivityKind; limit?: number; provider?: string; since?: number } = {}): ActivityEntry[] {
    const limit = Math.min(options.limit ?? 200, this.capacity);
    const out: ActivityEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const entry = this.entries[i]!;
      if (options.kind && entry.kind !== options.kind) continue;
      if (options.since && entry.at < options.since) continue;
      if (options.provider && (entry.kind !== 'http' || entry.provider !== options.provider)) continue;
      out.push(entry);
    }
    return out;
  }

  /** Per-provider totals, so a rate limit or a dead endpoint is obvious. */
  stats(): ProviderCallStats[] {
    const byProvider = new Map<string, { calls: number; cached: number; errors: number; total: number; lastAt: number }>();
    for (const entry of this.entries) {
      if (entry.kind !== 'http') continue;
      const acc = byProvider.get(entry.provider) ?? { calls: 0, cached: 0, errors: 0, total: 0, lastAt: 0 };
      acc.calls += 1;
      if (entry.cached) acc.cached += 1;
      if (!entry.ok) acc.errors += 1;
      acc.total += entry.durationMs;
      acc.lastAt = Math.max(acc.lastAt, entry.at);
      byProvider.set(entry.provider, acc);
    }
    return [...byProvider.entries()]
      .map(([provider, a]) => ({
        provider,
        calls: a.calls,
        cached: a.cached,
        errors: a.errors,
        avgMs: a.calls > 0 ? Math.round(a.total / a.calls) : 0,
        lastAt: a.lastAt || null,
      }))
      .sort((a, b) => b.calls - a.calls);
  }

  clear(): void {
    this.entries.length = 0;
  }

  size(): number {
    return this.entries.length;
  }
}

/**
 * One shared instance.
 *
 * The HTTP client is constructed deep inside individual providers, well below
 * the composition root, and threading a logger through every one of them would
 * mean changing each provider's constructor to observe them. A module-level
 * sink is the pragmatic seam; tests can clear it between runs.
 */
export const activityLog = new ActivityLog();
