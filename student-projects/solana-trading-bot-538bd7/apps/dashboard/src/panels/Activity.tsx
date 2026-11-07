import { useState } from 'react';
import type { ActivityResponse } from '../api';
import { Card, Empty, time } from '../ui';

/**
 * The live feed.
 *
 * Everything the system does between decisions: which provider it called, how
 * long the call took, whether the answer came from cache, and every log line
 * the terminal saw. Useful for spotting a rate limit, a dead endpoint or a key
 * that is not being picked up.
 */
export function Activity({
  data, onClear,
}: { data: ActivityResponse | null; onClear: () => void }) {
  const [filter, setFilter] = useState<'all' | 'http' | 'log' | 'errors'>('all');

  if (!data) return <Empty>Loading the feed…</Empty>;

  const entries = data.entries.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'errors') return entry.kind === 'http' ? !entry.ok : entry.level === 'error' || entry.level === 'warn';
    return entry.kind === filter;
  });

  return (
    <>
      <div className="section grid k4">
        {data.stats.length === 0 ? (
          <Card><Empty>No provider calls yet.</Empty></Card>
        ) : (
          data.stats.map((stat) => (
            <div className="card" key={stat.provider}>
              <div className="stat-label">{stat.provider}</div>
              <div className="stat-value" style={{ fontSize: 22 }}>{stat.calls.toLocaleString()}</div>
              <div className="stat-sub">
                {stat.avgMs}ms average
                {stat.cached > 0 && <> · {stat.cached} from cache</>}
                {stat.errors > 0 && <> · <span className="down">{stat.errors} failed</span></>}
              </div>
            </div>
          ))
        )}
      </div>

      <Card
        title={`Live feed (${entries.length})`}
        action={
          <div className="row">
            {(['all', 'http', 'log', 'errors'] as const).map((f) => (
              <button
                key={f}
                className="btn ghost"
                style={{
                  padding: '4px 10px', fontSize: 11,
                  borderColor: filter === f ? 'var(--cyan-dim)' : undefined,
                  color: filter === f ? 'var(--cyan)' : undefined,
                }}
                onClick={() => setFilter(f)}
              >
                {f === 'http' ? 'api calls' : f}
              </button>
            ))}
            <button className="btn ghost" style={{ padding: '4px 10px', fontSize: 11 }} onClick={onClear}>
              Clear
            </button>
          </div>
        }
      >
        {entries.length === 0 ? (
          <Empty>
            Nothing here yet. Trigger a scan from the Agents page and the calls will appear as they happen.
          </Empty>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Time</th><th>Source</th><th>What</th>
                  <th className="num">Status</th><th className="num">Took</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) =>
                  entry.kind === 'http' ? (
                    <tr key={entry.id}>
                      <td className="mono faint" style={{ fontSize: 11 }}>{time(entry.at)}</td>
                      <td><span className="tag">{entry.provider}</span></td>
                      <td className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>
                        <span className="faint">{entry.method}</span> {entry.url}
                        {entry.error && <div className="down" style={{ fontSize: 11 }}>{entry.error}</div>}
                      </td>
                      <td className="num">
                        {entry.cached ? (
                          <span className="tag">cached</span>
                        ) : (
                          <span className={entry.ok ? 'up' : 'down'}>{entry.status ?? 'failed'}</span>
                        )}
                      </td>
                      <td className="num faint">{entry.cached ? '—' : `${entry.durationMs}ms`}</td>
                    </tr>
                  ) : (
                    <tr key={entry.id}>
                      <td className="mono faint" style={{ fontSize: 11 }}>{time(entry.at)}</td>
                      <td><span className={`tag ${logTone(entry.level)}`}>{entry.level}</span></td>
                      <td colSpan={3}>
                        {entry.message}
                        {entry.context && Object.keys(entry.context).length > 0 && (
                          <div className="faint mono" style={{ fontSize: 10.5, marginTop: 3, wordBreak: 'break-all' }}>
                            {JSON.stringify(entry.context)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function logTone(level: string): string {
  if (level === 'error' || level === 'fatal') return 'bad';
  if (level === 'warn') return 'warn';
  return '';
}
