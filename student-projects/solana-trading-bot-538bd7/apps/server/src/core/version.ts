import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which build is actually running.
 *
 * This exists so "am I looking at the new version" is a question the app can
 * answer, rather than something to infer from whether a feature seems to be
 * there. The console shows it, the status route reports it, and the landing
 * page footer prints it.
 */

const here = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  // src/core -> apps/server, and dist/core -> apps/server too.
  for (const candidate of [
    resolve(here, '..', '..', 'package.json'),
    resolve(here, '..', '..', '..', 'package.json'),
  ]) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // Try the next candidate.
    }
  }
  return 'unknown';
}

export const APP_VERSION = readVersion();

/** When this process started. A restart is visible without reading a log. */
export const STARTED_AT = Date.now();
