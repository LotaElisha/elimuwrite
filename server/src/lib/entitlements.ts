import type { Db } from '../db.js';
import { one } from '../db.js';
import { HttpError, period } from './misc.js';

export type Limits = { documents?: number | null; storage_mb?: number | null; words_per_month?: number | null; similarity_checks_per_month?: number | null; seats?: number | null };

/** Which subscription pays for work: the institution for assignment work, otherwise the individual. */
export async function payer(db: Db, userId: string, orgId: string | null) {
  const sub = orgId
    ? await one(db, `select s.*, p.code, p.name as plan_name, p.limits, p.features from subscriptions s join plans p on p.id=s.plan_id where s.org_id=$1 and s.status in ('active','trialing','past_due') order by s.created_at desc limit 1`, [orgId])
    : await one(db, `select s.*, p.code, p.name as plan_name, p.limits, p.features from subscriptions s join plans p on p.id=s.plan_id where s.owner_user_id=$1 and s.status in ('active','trialing','past_due') order by s.created_at desc limit 1`, [userId]);
  if (sub) return { orgId, userId: orgId ? null : userId, plan: sub.code, planName: sub.plan_name, limits: sub.limits as Limits, features: sub.features, subscription: sub };
  const free = await one(db, `select code, name, limits, features from plans where code='free'`);
  return { orgId, userId: orgId ? null : userId, plan: 'free', planName: free?.name ?? 'Free', limits: (free?.limits ?? {}) as Limits, features: free?.features ?? {}, subscription: null };
}

export async function usageThisPeriod(db: Db, p: { orgId: string | null; userId: string | null }) {
  const r = await db.query(
    `select kind, sum(quantity)::int as qty from usage_records where period=$1 and ${p.orgId ? 'org_id=$2' : 'owner_user_id=$2 and org_id is null'} group by kind`,
    [period(), p.orgId ?? p.userId],
  );
  const pending = await one(db,
    `select count(*)::int as n from analysis_jobs where kind='similarity' and status in ('queued','processing') and ${p.orgId ? 'org_id=$1' : 'owner_user_id=$1 and org_id is null'}`,
    [p.orgId ?? p.userId]);
  return { ...Object.fromEntries(r.rows.map((x) => [x.kind, x.qty])), pending_similarity: pending?.n ?? 0 } as Record<string, number>;
}

/** Quota check before starting a similarity scan; pending scans count against the allowance. */
export async function assertSimilarityQuota(db: Db, userId: string, orgId: string | null) {
  const p = await payer(db, userId, orgId);
  const limit = p.limits.similarity_checks_per_month;
  if (limit == null) return p;
  const u = await usageThisPeriod(db, p);
  if ((u.similarity_check ?? 0) + u.pending_similarity >= limit) {
    throw new HttpError(402, 'quota_exceeded', `Your ${p.planName} plan includes ${limit} similarity checks per month, and they are used up.`);
  }
  return p;
}

/** Records usage idempotently: the same key can never be charged twice. */
export async function recordUsage(db: Db, u: { userId: string | null; orgId: string | null; kind: string; quantity: number; jobId?: string; key: string }) {
  await db.query(
    `insert into usage_records(owner_user_id, org_id, kind, quantity, job_id, idempotency_key, period) values ($1,$2,$3,$4,$5,$6,$7) on conflict (idempotency_key) do nothing`,
    [u.orgId ? null : u.userId, u.orgId, u.kind, u.quantity, u.jobId ?? null, u.key, period()],
  );
}
