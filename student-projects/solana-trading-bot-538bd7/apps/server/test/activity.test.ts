import { describe, expect, it, beforeEach } from 'vitest';
import { ActivityLog } from '../src/observability/activity-log.js';

describe('activity log', () => {
  let log: ActivityLog;
  beforeEach(() => {
    log = new ActivityLog(5);
  });

  function call(overrides: Partial<Parameters<ActivityLog['recordHttp']>[0]> = {}) {
    log.recordHttp({
      provider: 'dexscreener', method: 'GET', url: 'api.dexscreener.com/x',
      host: 'api.dexscreener.com', path: '/x', status: 200, durationMs: 40,
      cached: false, ok: true, error: null, attempt: 0, ...overrides,
    });
  }

  it('returns entries newest first', () => {
    call({ path: '/one' });
    call({ path: '/two' });
    const [first] = log.list();
    expect(first && first.kind === 'http' && first.path).toBe('/two');
  });

  it('never grows past its capacity', () => {
    for (let i = 0; i < 20; i += 1) call({ path: `/${i}` });
    expect(log.size()).toBe(5);
    // The oldest were dropped, the newest survived.
    const paths = log.list().map((e) => (e.kind === 'http' ? e.path : ''));
    expect(paths).toContain('/19');
    expect(paths).not.toContain('/0');
  });

  it('filters by kind', () => {
    call();
    log.recordLog('info', 'hello');
    expect(log.list({ kind: 'http' })).toHaveLength(1);
    expect(log.list({ kind: 'log' })).toHaveLength(1);
  });

  it('filters by provider', () => {
    call({ provider: 'jupiter' });
    call({ provider: 'dexscreener' });
    expect(log.list({ provider: 'jupiter' })).toHaveLength(1);
  });

  it('summarises calls, cache hits and failures per provider', () => {
    call({ durationMs: 100 });
    call({ durationMs: 200 });
    call({ cached: true, durationMs: 0 });
    call({ ok: false, status: 429, error: 'HTTP 429', durationMs: 0 });
    const stats = log.stats();
    const ds = stats.find((s) => s.provider === 'dexscreener');
    expect(ds?.calls).toBe(4);
    expect(ds?.cached).toBe(1);
    expect(ds?.errors).toBe(1);
    expect(ds?.avgMs).toBe(75);
  });

  it('keeps log lines with their context', () => {
    log.recordLog('warn', 'rate limited', { provider: 'lunarcrush' });
    const [entry] = log.list({ kind: 'log' });
    expect(entry && entry.kind === 'log' && entry.level).toBe('warn');
    expect(entry && entry.kind === 'log' && entry.context).toEqual({ provider: 'lunarcrush' });
  });

  it('clears on request', () => {
    call();
    log.clear();
    expect(log.size()).toBe(0);
    expect(log.stats()).toHaveLength(0);
  });
});

describe('activity log records provider calls without leaking keys', () => {
  it('strips the query string, where several providers carry their key', async () => {
    const { HttpClient } = await import('../src/providers/http.js');
    const { activityLog } = await import('../src/observability/activity-log.js');
    activityLog.clear();

    const client = new HttpClient('secret-provider', { maxRetries: 0, timeoutMs: 200, minIntervalMs: 0 });
    // Nothing is listening, so this fails; the point is what gets recorded.
    await client
      .getJson('http://127.0.0.1:1/rpc?api-key=SUPERSECRET&id=1')
      .catch(() => undefined);

    const entries = activityLog.list({ kind: 'http' });
    expect(entries.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain('SUPERSECRET');
    expect(serialised).not.toContain('api-key');
  });
});
