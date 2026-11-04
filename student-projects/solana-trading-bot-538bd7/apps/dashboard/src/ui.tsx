import type { ReactNode } from 'react';

/** Shared presentational bits, so every panel formats money the same way. */

export function usd(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `$${Math.round(value).toLocaleString()}`;
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return '—';
  if (value >= 1) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(3)}`;
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function ago(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 0) return `in ${duration(-diff)}`;
  return `${duration(diff)} ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function shorten(address: string, size = 4): string {
  if (address.length <= size * 2 + 3) return address;
  return `${address.slice(0, size)}…${address.slice(-size)}`;
}

export function Money({ value, digits = 2 }: { value: number | null; digits?: number }) {
  if (value == null) return <span className="dim">—</span>;
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'dim';
  return <span className={cls}>{value > 0 ? '+' : ''}{usd(value, digits)}</span>;
}

export function Pct({ value }: { value: number | null }) {
  if (value == null) return <span className="dim">—</span>;
  const cls = value > 0 ? 'up' : value < 0 ? 'down' : 'dim';
  return <span className={cls}>{pct(value)}</span>;
}

export function Score({ value }: { value: number | null }) {
  if (value == null) return <span className="dim">—</span>;
  const cls = value >= 75 ? 'high' : value >= 55 ? 'mid' : 'low';
  return <span className={`score ${cls}`}>{value.toFixed(0)}</span>;
}

export function Stat({
  label, value, sub, tone,
}: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' }) {
  return (
    <div className="card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ?? ''}`}>{value}</div>
      {sub != null && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="card">
      {(title || action) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function BrandMark() {
  // The agent ring: six nodes feeding one core, the same idea as the hero.
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="2.6" fill="#ff5c7a" />
      {[0, 60, 120, 180, 240, 300].map((deg) => {
        const rad = (deg * Math.PI) / 180;
        const x = 12 + Math.cos(rad) * 8.6;
        const y = 12 + Math.sin(rad) * 8.6;
        return (
          <g key={deg}>
            <line x1="12" y1="12" x2={x} y2={y} stroke="#2a7d89" strokeWidth="1" />
            <circle cx={x} cy={y} r="1.7" fill="#4fd8e8" />
          </g>
        );
      })}
    </svg>
  );
}
