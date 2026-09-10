import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from './Logger';

/**
 * Lightweight JSON-file storage rooted at Electron's userData directory.
 *
 * Why JSON files instead of SQLite: this app's persisted state (settings,
 * proxy list, browser->proxy assignments, provider health) is small,
 * infrequently written, and naturally document-shaped. SQLite would add a
 * native-module build dependency that complicates cross-platform CI
 * (prebuilt binaries per Electron ABI/arch) for no real benefit at this
 * data size. If persisted state grows into relational queries or large
 * volumes, StorageManager's interface (get/set/atomic write) is the single
 * seam to swap in a real database without touching callers.
 */
export class StorageManager {
  private readonly dir: string;
  private readonly cache = new Map<string, unknown>();

  constructor(baseDir?: string) {
    this.dir = baseDir ?? path.join(app.getPath('userData'), 'store');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private fileFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async read<T>(key: string, fallback: T): Promise<T> {
    if (this.cache.has(key)) return this.cache.get(key) as T;
    try {
      const raw = await fs.readFile(this.fileFor(key), 'utf8');
      const parsed = JSON.parse(raw) as T;
      this.cache.set(key, parsed);
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('storage', `Failed to read ${key}: ${(err as Error).message}`);
      }
      return fallback;
    }
  }

  /** Atomic write: write to a temp file then rename, so a crash mid-write never corrupts the store. */
  async write<T>(key: string, value: T): Promise<void> {
    this.cache.set(key, value);
    await fs.mkdir(this.dir, { recursive: true });
    const finalPath = this.fileFor(key);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmpPath, finalPath);
  }

  /** Encrypts a secret (e.g. a proxy password) using the OS keychain via Electron's safeStorage,
   *  falling back to a clearly-marked reversible encoding only when OS encryption is unavailable
   *  (e.g. some Linux CI environments without a keyring). */
  encryptSecret(plainText: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return `enc:${safeStorage.encryptString(plainText).toString('base64')}`;
    }
    logger.warn('storage', 'OS secure storage unavailable; secret stored with reversible encoding only.');
    return `plain:${Buffer.from(plainText, 'utf8').toString('base64')}`;
  }

  decryptSecret(stored: string): string {
    if (stored.startsWith('enc:')) {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    }
    if (stored.startsWith('plain:')) {
      return Buffer.from(stored.slice(6), 'base64').toString('utf8');
    }
    return stored;
  }
}
