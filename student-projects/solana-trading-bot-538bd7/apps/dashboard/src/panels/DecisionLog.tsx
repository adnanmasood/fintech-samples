import { useState } from 'react';
import { AGENT_LABELS, type EventRow } from '../api';
import { Card, Empty, time } from '../ui';

const CATEGORIES = ['all', 'execution', 'risk', 'security', 'signal', 'scheduler', 'system'] as const;

/**
 * The decision log.
 *
 * This is the panel that answers "why did that happen". Every accepted and
 * refused trade is here with the numbers that produced it, so a decision can
 * be replayed rather than guessed at.
 */
export function DecisionLog({ events }: { events: EventRow[] }) {
  const [category, setCategory] = useState<string>('all');
  const filtered = category === 'all' ? events : events.filter((e) => e.category === category);

  return (
    <Card
      title="Decision log"
      action={
        <div className="row">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className="btn ghost"
              style={{
                padding: '4px 10px',
                fontSize: 11,
                borderColor: category === c ? 'var(--cyan-dim)' : undefined,
                color: category === c ? 'var(--cyan)' : undefined,
              }}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      }
    >
      {filtered.length === 0 ? (
        <Empty>Nothing logged in this category yet.</Empty>
      ) : (
        filtered.map((event, i) => {
          // Events arrive newest first. A separator whenever the calendar day
          // changes keeps yesterday's 8pm from reading like it sorts below
          // today's 4pm - it doesn't, the log is fine, but "04:09:02 PM" with
          // no date next to it looks exactly like that kind of bug.
          const prev = filtered[i - 1];
          const showDaySeparator = i === 0 || dayKey(event.createdAt) !== dayKey(prev!.createdAt);
          return (
            <div key={event.id}>
              {showDaySeparator && <div className="log-day">{dayLabel(event.createdAt)}</div>}
              <div className="log-entry">
                <div className="log-head">
                  <span className="log-time">{time(event.createdAt)}</span>
                  <span className={`tag ${toneFor(event)}`}>{event.category}</span>
                  {event.agent && <span className="tag">{AGENT_LABELS[event.agent] ?? event.agent}</span>}
                </div>
                <div className="log-msg">{event.message}</div>
                {event.payload && Object.keys(event.payload).length > 0 && (
                  <details>
                    <summary>Show the numbers behind this</summary>
                    <div className="log-payload">{format(event.payload)}</div>
                  </details>
                )}
              </div>
            </div>
          );
        })
      )}
    </Card>
  );
}

function dayKey(ts: number): string {
  return new Date(ts).toDateString();
}

function dayLabel(ts: number): string {
  const day = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
  return day.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function toneFor(event: EventRow): string {
  if (event.level === 'error') return 'bad';
  if (event.level === 'warn') return 'warn';
  if (event.category === 'execution') return 'ok';
  return '';
}

/** Readable rather than raw: a wall of JSON is not an explanation. */
function format(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) continue;
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${label}:`);
      for (const item of value.slice(0, 12)) {
        lines.push(`  • ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`);
      }
    } else if (typeof value === 'object') {
      lines.push(`${label}: ${JSON.stringify(value)}`);
    } else if (typeof value === 'number') {
      lines.push(`${label}: ${Number.isInteger(value) ? value : value.toFixed(4)}`);
    } else {
      lines.push(`${label}: ${String(value)}`);
    }
  }
  return lines.join('\n');
}
