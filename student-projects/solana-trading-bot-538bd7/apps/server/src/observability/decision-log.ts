import { desc, eq, and, gte, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { systemEvents } from '../db/schema.js';
import type { Logger } from './logger.js';
import { redact } from '../config/env.js';

export type EventCategory =
  | 'signal'
  | 'security'
  | 'risk'
  | 'portfolio'
  | 'execution'
  | 'scheduler'
  | 'config'
  | 'system';

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface DecisionEvent {
  level?: EventLevel;
  category: EventCategory;
  agent?: string | null;
  tokenAddress?: string | null;
  signalId?: string | null;
  message: string;
  payload?: Record<string, unknown> | null;
}

/**
 * The audit trail.
 *
 * Every accepted trade and every refused one lands here with the numbers that
 * produced the decision, so any row in the dashboard can be traced back to the
 * scores, the security flags and the risk checks that caused it.
 *
 * Writes are best effort: a full disk must never stop the risk manager from
 * refusing a trade.
 */
export class DecisionLog {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  record(event: DecisionEvent): void {
    const level = event.level ?? 'info';
    const payload = event.payload ? redact(event.payload) : null;
    try {
      this.db
        .insert(systemEvents)
        .values({
          level,
          category: event.category,
          agent: event.agent ?? null,
          tokenAddress: event.tokenAddress ?? null,
          signalId: event.signalId ?? null,
          message: event.message,
          payload,
          createdAt: Date.now(),
        })
        .run();
    } catch (err) {
      this.logger.error({ err }, 'failed to persist decision event');
    }
    const line = { category: event.category, agent: event.agent, token: event.tokenAddress, payload };
    if (level === 'error') this.logger.error(line, event.message);
    else if (level === 'warn') this.logger.warn(line, event.message);
    else if (level === 'debug') this.logger.debug(line, event.message);
    else this.logger.info(line, event.message);
  }

  list(options: {
    limit?: number;
    category?: EventCategory;
    agent?: string;
    since?: number;
    before?: number;
  } = {}) {
    const conditions = [];
    if (options.category) conditions.push(eq(systemEvents.category, options.category));
    if (options.agent) conditions.push(eq(systemEvents.agent, options.agent));
    if (options.since) conditions.push(gte(systemEvents.createdAt, options.since));
    if (options.before) conditions.push(lt(systemEvents.createdAt, options.before));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return this.db
      .select()
      .from(systemEvents)
      .where(where)
      .orderBy(desc(systemEvents.createdAt))
      .limit(Math.min(options.limit ?? 100, 500))
      .all();
  }

  /** Trim the log so a long paper run cannot grow the database without bound. */
  prune(keepDays: number): number {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    const result = this.db.run(
      sql`DELETE FROM system_events WHERE created_at < ${cutoff}`,
    );
    return Number(result.changes ?? 0);
  }
}
