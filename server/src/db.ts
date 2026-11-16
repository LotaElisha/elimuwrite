import pg from 'pg';
import { config } from './config.js';

// bigint (int8) as string by default; we parse fingerprints manually.
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15 });

export type Db = pg.PoolClient;
export type Ctx = { userId?: string | null; jobUser?: string | null; jobOrg?: string | null };

/**
 * Run fn inside a transaction with row-level-security context set.
 * Every application query goes through here so RLS policies always see who is asking.
 */
export async function withDb<T>(ctx: Ctx, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.user_id', $1, true), set_config('app.job_user', $2, true), set_config('app.job_org', $3, true)`,
      [ctx.userId ?? '', ctx.jobUser ?? '', ctx.jobOrg ?? ''],
    );
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query(sql, params);
  return (r.rows[0] as T) ?? null;
}
export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(sql, params);
  return r.rows as T[];
}
