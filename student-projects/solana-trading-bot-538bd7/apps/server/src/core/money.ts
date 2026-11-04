/**
 * Money helpers.
 *
 * USD amounts are held as numbers but always rounded to cents before being
 * stored or compared, so repeated float arithmetic across a long paper run
 * cannot drift the books.
 */

export const CENTS = 100;

export function roundUsd(value: number): number {
  return Math.round(value * CENTS) / CENTS;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Clamp into 0..100 and round to one decimal, the shape every score takes. */
export function normaliseScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(clamp(value, 0, 100) * 10) / 10;
}

export function bpsToFraction(bps: number): number {
  return bps / 10_000;
}

export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

/**
 * Map a value onto 0..100 using a piecewise-linear curve.
 * Points must be sorted ascending by input. Values outside the curve clamp to
 * the nearest end, which keeps every scorer bounded no matter what a provider
 * returns.
 */
export function curveScore(value: number, points: Array<[number, number]>): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (value <= first[0]) return first[1];
  if (value >= last[0]) return last[1];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (value >= a[0] && value <= b[0]) {
      const span = b[0] - a[0];
      if (span === 0) return b[1];
      const t = (value - a[0]) / span;
      return a[1] + (b[1] - a[1]) * t;
    }
  }
  return last[1];
}

/** Sum an array of numbers, treating null and undefined as zero. */
export function sum(values: Array<number | null | undefined>): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}
