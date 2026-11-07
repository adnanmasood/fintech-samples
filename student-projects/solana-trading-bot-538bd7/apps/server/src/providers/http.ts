import { ProviderError } from '../core/errors.js';
import { activityLog } from '../observability/activity-log.js';

/**
 * One HTTP client for every provider.
 *
 * Free API tiers are the whole point of this build, so this carries the three
 * things that keep a free tier usable: a per-host rate limiter, a short-lived
 * response cache, and retry with backoff on the failures worth retrying.
 */

export interface HttpOptions {
  /** Minimum milliseconds between two calls to the same host. */
  minIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Cache successful GETs for this long. Zero disables caching. */
  cacheTtlMs?: number;
  headers?: Record<string, string>;
  cacheSize?: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpClient {
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly cacheTtlMs: number;
  private readonly cacheSize: number;
  private readonly baseHeaders: Record<string, string>;
  private readonly cache = new Map<string, CacheEntry>();
  /** Per-host promise chain, so calls to one host queue instead of stampeding. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly lastCallAt = new Map<string, number>();

  constructor(
    private readonly providerName: string,
    options: HttpOptions = {},
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 250;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.cacheTtlMs = options.cacheTtlMs ?? 0;
    this.cacheSize = options.cacheSize ?? 500;
    this.baseHeaders = options.headers ?? {};
  }

  async getJson<T>(url: string, init?: RequestInit & { cacheTtlMs?: number }): Promise<T> {
    const ttl = init?.cacheTtlMs ?? this.cacheTtlMs;
    if (ttl > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expiresAt > Date.now()) {
        this.report(url, 'GET', 200, 0, true, null, 0);
        return hit.value as T;
      }
    }
    const value = await this.request<T>(url, { ...init, method: 'GET' });
    if (ttl > 0) this.putCache(url, value, ttl);
    return value;
  }

  /** Same rate limiting, retry and caching as getJson, for endpoints that answer with text (RSS/XML) rather than JSON. */
  async getText(url: string, init?: RequestInit & { cacheTtlMs?: number }): Promise<string> {
    const ttl = init?.cacheTtlMs ?? this.cacheTtlMs;
    if (ttl > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expiresAt > Date.now()) {
        this.report(url, 'GET', 200, 0, true, null, 0);
        return hit.value as string;
      }
    }
    const value = await this.request<string>(
      url,
      {
        ...init,
        method: 'GET',
        headers: { accept: 'application/rss+xml, application/xml, text/xml, */*', ...(init?.headers ?? {}) },
      },
      (res) => res.text(),
    );
    if (ttl > 0) this.putCache(url, value, ttl);
    return value;
  }

  async postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>(url, {
      ...init,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      body: JSON.stringify(body),
    });
  }

  private putCache(key: string, value: unknown, ttlMs: number): void {
    if (this.cache.size >= this.cacheSize) {
      // Cheap eviction: drop the oldest inserted key. Map preserves insertion order.
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Serialise per host and honour the minimum interval between calls. */
  private schedule<T>(host: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const last = this.lastCallAt.get(host) ?? 0;
      const wait = this.minIntervalMs - (Date.now() - last);
      if (wait > 0) await sleep(wait);
      this.lastCallAt.set(host, Date.now());
      return task();
    });
    // Keep the chain alive even when one call rejects.
    this.queues.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Push one call onto the activity feed.
   *
   * The URL is stripped of its query string before it is recorded, because
   * several providers carry their API key there and this feed is served to
   * the browser.
   */
  private report(
    url: string,
    method: string,
    status: number | null,
    durationMs: number,
    cached: boolean,
    error: string | null,
    attempt: number,
  ): void {
    let host = url;
    let path = '';
    try {
      const parsed = new URL(url);
      host = parsed.host;
      path = parsed.pathname;
    } catch {
      /* keep the raw string */
    }
    activityLog.recordHttp({
      provider: this.providerName,
      method,
      url: `${host}${path}`,
      host,
      path,
      status,
      durationMs,
      cached,
      ok: error === null,
      error,
      attempt,
    });
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    parse: (res: Response) => Promise<T> = (res) => res.json() as Promise<T>,
  ): Promise<T> {
    const host = safeHost(url);
    return this.schedule(host, async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
        if (attempt > 0) {
          // Exponential backoff with jitter, so parallel agents do not resynchronise.
          await sleep(2 ** attempt * 400 + Math.random() * 200);
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        const startedAt = Date.now();
        const method = (init.method ?? 'GET').toUpperCase();
        try {
          const res = await fetch(url, {
            ...init,
            signal: controller.signal,
            headers: { accept: 'application/json', ...this.baseHeaders, ...(init.headers ?? {}) },
          });
          if (!res.ok) {
            const body = await res.text().catch(() => '');
            this.report(url, method, res.status, Date.now() - startedAt, false, `HTTP ${res.status}`, attempt);
            if (RETRYABLE_STATUS.has(res.status) && attempt < this.maxRetries) {
              lastError = new ProviderError(this.providerName, `HTTP ${res.status}`, {
                status: res.status,
              });
              continue;
            }
            throw new ProviderError(this.providerName, `HTTP ${res.status}`, {
              status: res.status,
              // Truncated: provider errors can echo a whole HTML page.
              body: body.slice(0, 300),
            });
          }
          const parsed = await parse(res);
          this.report(url, method, res.status, Date.now() - startedAt, false, null, attempt);
          return parsed;
        } catch (err) {
          if (!(err instanceof ProviderError)) {
            this.report(url, method, null, Date.now() - startedAt, false, describeError(err), attempt);
          }
          lastError = err;
          const retryable =
            err instanceof ProviderError
              ? RETRYABLE_STATUS.has(Number((err.details as { status?: number })?.status))
              : true;
          if (!retryable || attempt === this.maxRetries) break;
        } finally {
          clearTimeout(timer);
        }
      }
      if (lastError instanceof ProviderError) throw lastError;
      throw new ProviderError(this.providerName, describeError(lastError));
    });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
