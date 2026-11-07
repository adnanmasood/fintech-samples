import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

/**
 * A stable key for duplicate-trade protection: the same agent buying the same
 * token in the same direction inside the cooldown window is one intent, not two.
 */
export function dedupeKey(parts: Array<string | number>): string {
  return parts.map((p) => String(p)).join(':');
}
