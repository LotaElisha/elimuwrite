import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256 } from './text.js';
import type { Db } from '../db.js';
import { config } from '../config.js';

// ---------------------------------------------------------------- errors
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}
// 404 for resources the caller cannot see, so identifiers from other tenants can't be probed.
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg: string, detail?: unknown) => new HttpError(400, 'bad_request', msg, detail);
export const conflict = (code: string, msg: string, detail?: unknown) => new HttpError(409, code, msg, detail);

// ---------------------------------------------------------------- passwords & sessions
const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string) {
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const derived = await scrypt(pw, Buffer.from(salt, 'base64'), 64);
  const expected = Buffer.from(key, 'base64');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export async function createSession(db: Db, userId: string) {
  const token = newToken();
  await db.query(
    `insert into sessions(user_id, token_hash, expires_at) values ($1,$2, now() + ($3 || ' days')::interval)`,
    [userId, sha256(token), String(config.sessionDays)],
  );
  return token;
}

// ---------------------------------------------------------------- audit
export async function audit(
  db: Db,
  e: { orgId?: string | null; actorId?: string | null; action: string; targetType?: string; targetId?: string; detail?: object },
) {
  // Never put manuscript content in detail: audit records are operational metadata only.
  await db.query(
    `insert into audit_events(org_id, actor_id, action, target_type, target_id, detail) values ($1,$2,$3,$4,$5,$6)`,
    [e.orgId ?? null, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, JSON.stringify(e.detail ?? {})],
  );
}

export const period = (d = new Date()) => d.toISOString().slice(0, 7);
