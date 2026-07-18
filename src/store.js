/**
 * Persistent store of already-processed thread IDs -> created Linear issue.
 *
 * This is the duplicate-prevention backbone: before creating an issue for a
 * thread we check here, and after creating one we record it. The data lives
 * in a small JSON file so it survives restarts.
 *
 * Writes are atomic and durable: we write to a randomly-named temp file in the
 * same directory (0600, exclusive-create so a symlink can't be pre-planted),
 * fsync it, then rename it over the real file, so a crash mid-write never
 * corrupts or reverts the store. Writes are serialized through a promise chain
 * so concurrent saves cannot interleave, and a failed write REJECTS to the
 * caller so the caller can react instead of silently losing the entry.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { childLogger } from './logger.js';

const log = childLogger('store');

export class ProcessedStore {
  /** @param {string} filePath Path to the JSON store file. */
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    /** @type {Map<string, object>} threadId -> issue record */
    this.entries = new Map();
    /** Serializes writes so they never interleave. */
    this._writeChain = Promise.resolve();
  }

  /** Load existing entries from disk. Missing file = fresh empty store. */
  async load() {
    try {
      const text = await fs.readFile(this.filePath, 'utf8');
      const data = JSON.parse(text);
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        // Wrong shape is treated like corruption: refuse to start rather than
        // silently overwrite (and lose) whatever dedupe history it encodes.
        throw new Error(
          `Store file ${this.filePath} has an unexpected shape (expected a JSON object). Fix or remove it before starting (removing it may cause duplicate issues).`,
        );
      }
      this.entries = new Map(Object.entries(data));
      log.info({ path: this.filePath, count: this.entries.size }, 'Loaded processed-thread store');
    } catch (err) {
      if (err.code === 'ENOENT') {
        log.info({ path: this.filePath }, 'No existing store file; starting fresh');
      } else if (err instanceof SyntaxError) {
        // Corrupt JSON: refuse to silently wipe history. A human should look.
        throw new Error(
          `Store file ${this.filePath} contains invalid JSON. Fix or remove it before starting (removing it may cause duplicate issues).`,
        );
      } else {
        throw err;
      }
    }
    return this;
  }

  /** Has this thread already produced a Linear issue? */
  has(threadId) {
    return this.entries.has(threadId);
  }

  /** The stored record for a thread, if any. */
  get(threadId) {
    return this.entries.get(threadId);
  }

  /**
   * Record a processed thread and persist to disk.
   * Resolves once the entry is durably written; REJECTS if the write fails
   * (the entry is still held in memory, so dedupe holds until the next restart).
   */
  async set(threadId, record) {
    this.entries.set(threadId, record);
    return this._save();
  }

  /** Queue an atomic write of the current state; rejects to the caller on failure. */
  _save() {
    const write = this._writeChain.then(() => this._writeToDisk());
    // Keep the chain alive regardless of this write's outcome so one failure
    // doesn't wedge every future save; the caller still sees the real error.
    this._writeChain = write.catch(() => {});
    return write;
  }

  async _writeToDisk() {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    // Random, exclusive-create temp name: unpredictable (no symlink pre-plant),
    // collision-free, and 0600 so the dedupe file isn't world-readable.
    const tmpPath = path.join(dir, `.${path.basename(this.filePath)}.${randomBytes(6).toString('hex')}.tmp`);
    const payload = `${JSON.stringify(Object.fromEntries(this.entries), null, 2)}\n`;
    const handle = await fs.open(tmpPath, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync(); // flush to disk before the rename so a crash can't lose the entry
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, this.filePath); // atomic on POSIX within one filesystem
  }

  /** Wait for any in-flight writes to finish (used during shutdown). */
  async flush() {
    await this._writeChain;
  }
}
