import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { resolveDbPath } from '../db/client.js';
import { secrets } from '../db/schema.js';

/**
 * Encrypted secret storage.
 *
 * A private key pasted into the dashboard has to survive a restart, which
 * means it has to be written down somewhere. Writing it into the settings
 * document would put it in every `GET /config` response, so it goes here
 * instead: AES-256-GCM ciphertext in its own table, with the master key in a
 * separate 0600 file beside the database.
 *
 * What that buys: a copied or backed-up `usf.db` carries no usable key, and
 * nothing in the API, the logs or the config document can leak one. What it
 * does not buy: protection from someone who can already read the whole data
 * directory. That is the same trust boundary as a `.env` file, which is where
 * the key lived before.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_FILE = '.secret-key';

export class SecretStore {
  private masterKey: Buffer | null = null;

  constructor(
    private readonly db: Db,
    /** Where the master key lives. Null keeps it in memory, for tests. */
    private readonly keyPath: string | null,
  ) {}

  /** Derive the key file's location from the database URL. */
  static keyPathFor(databaseUrl: string): string | null {
    const dbPath = resolveDbPath(databaseUrl);
    if (dbPath === ':memory:') return null;
    return resolve(dirname(dbPath), KEY_FILE);
  }

  get(name: string): string | null {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get();
    if (!row) return null;
    try {
      return this.decrypt(row.value);
    } catch {
      // A key file that was replaced or lost makes old ciphertext unreadable.
      // Report it as absent rather than throwing on every read.
      return null;
    }
  }

  set(name: string, value: string): void {
    const encrypted = this.encrypt(value);
    this.db
      .insert(secrets)
      .values({ name, value: encrypted, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: secrets.name,
        set: { value: encrypted, updatedAt: Date.now() },
      })
      .run();
  }

  delete(name: string): void {
    this.db.delete(secrets).where(eq(secrets.name, name)).run();
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join(':');
  }

  private decrypt(payload: string): string {
    const [version, iv, tag, body] = payload.split(':');
    if (version !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised ciphertext.');
    const decipher = createDecipheriv(ALGORITHM, this.key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Read the master key, creating it on first use. */
  private key(): Buffer {
    if (this.masterKey) return this.masterKey;
    if (!this.keyPath) {
      this.masterKey = randomBytes(32);
      return this.masterKey;
    }
    if (existsSync(this.keyPath)) {
      const material = Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64');
      if (material.length === 32) {
        this.masterKey = material;
        return this.masterKey;
      }
    }
    const fresh = randomBytes(32);
    mkdirSync(dirname(this.keyPath), { recursive: true });
    writeFileSync(this.keyPath, fresh.toString('base64'), { mode: 0o600 });
    // writeFileSync only applies the mode when it creates the file, so a
    // pre-existing file with the wrong permissions is tightened explicitly.
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      // Windows has no POSIX mode bits. Not fatal.
    }
    this.masterKey = fresh;
    return this.masterKey;
  }
}
