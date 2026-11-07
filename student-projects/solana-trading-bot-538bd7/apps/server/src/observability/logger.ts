import pino, { type Logger } from 'pino';
import { getEnv, redact } from '../config/env.js';
import { activityLog } from './activity-log.js';

/**
 * Structured logging.
 *
 * The redaction list is the second line of defence. Secrets are never meant to
 * be handed to the logger in the first place, but a stray object spread should
 * not be able to print a private key.
 */
export function createLogger(): Logger {
  const env = getEnv();
  const pretty = env.NODE_ENV === 'development';

  // Mirror every log line into the activity feed as it is written, so the
  // dashboard shows the same stream the terminal does. The hook runs after
  // pino's own redaction, so nothing sensitive reaches the ring buffer.
  const mirror = {
    logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void, levelNum: number) {
      try {
        const [first, second] = args;
        const context = typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : null;
        const message = typeof first === 'string' ? first : typeof second === 'string' ? second : '';
        if (message) {
          activityLog.recordLog(pino.levels.labels[levelNum] ?? 'info', message, context ? redact(context) : null);
        }
      } catch {
        // The feed is a convenience. It must never break logging.
      }
      return method.apply(this, args as never);
    },
  };

  return pino({
    level: env.LOG_LEVEL,
    hooks: mirror,
    redact: {
      paths: [
        'privateKey',
        'secretKey',
        'apiKey',
        'api_key',
        'authorization',
        'headers.authorization',
        'headers["x-api-key"]',
        'env.WALLET_PRIVATE_KEY',
        'env.HELIUS_API_KEY',
        'env.LUNARCRUSH_API_KEY',
        'env.OPENROUTER_API_KEY',
        'env.SOLANA_RPC_API_KEY',
        '*.privateKey',
        '*.secretKey',
      ],
      censor: '[redacted]',
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };
export { redact };
