import { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * Private object storage. Phase 1 ships a local-disk driver; the interface matches
 * what an S3-compatible driver needs (put/get/remove by opaque key), so production can
 * swap in S3/MinIO without touching callers. Keys are random and never exposed publicly.
 */
export interface ObjectStore {
  put(buf: Buffer, prefix: string): string;
  get(key: string): Buffer;
  remove(key: string): void;
}

class LocalStore implements ObjectStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }
  private path(key: string) {
    if (!/^[a-z0-9/-]+$/.test(key)) throw new Error('invalid storage key');
    return join(this.root, key);
  }
  put(buf: Buffer, prefix: string) {
    const key = `${prefix}/${randomUUID()}`;
    mkdirSync(join(this.root, prefix), { recursive: true });
    writeFileSync(this.path(key), buf);
    return key;
  }
  get(key: string) {
    return readFileSync(this.path(key));
  }
  remove(key: string) {
    const p = this.path(key);
    if (existsSync(p)) unlinkSync(p);
  }
}

export const store: ObjectStore = new LocalStore(config.storageDir);
