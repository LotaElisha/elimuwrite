import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, many, pool } from '../db.js';
import { providerStatuses } from '../config.js';
import { audit, forbidden, notFound, conflict } from '../lib/misc.js';

const uuid = z.string().uuid();

function admin(req: FastifyRequest) {
  const u = req.me();
  if (!u.is_platform_admin) throw notFound('Page');
  return u;
}

/**
 * Platform administration works on operational metadata. It has NO implicit access to
 * document content: reading a document requires a time-limited, justified, audited grant,
 * which the database RLS policy enforces as well.
 */
export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/health', async (req) => {
    admin(req);
    const t = Date.now();
    await pool.query('select 1');
    const jobs = await pool.query(`select status, count(*)::int as n from analysis_jobs where created_at > now() - interval '7 days' group by status`);
    const oldest = await pool.query(`select extract(epoch from now() - min(created_at))::int as s from analysis_jobs where status='queued'`);
    return { database: { ok: true, latency_ms: Date.now() - t }, jobs_last_7_days: jobs.rows, oldest_queued_seconds: oldest.rows[0].s, providers: providerStatuses() };
  });

  app.get('/admin/plans', async (req) => { admin(req); return (await pool.query(`select * from plans order by code`)).rows; });
  app.patch('/admin/plans/:code', async (req) => {
    const u = admin(req);
    const b = z.object({
      name: z.string().optional(),
      prices: z.record(z.enum(['USD', 'TZS']), z.object({ monthly: z.number().nonnegative().nullable(), annual: z.number().nonnegative().nullable() })).optional(),
      limits: z.record(z.string(), z.number().int().nullable()).optional(),
      features: z.record(z.string(), z.boolean()).optional(),
      active: z.boolean().optional(),
    }).parse(req.body);
    return req.db(async (db) => {
      const p = await one(db, `select * from plans where code=$1`, [(req.params as any).code]);
      if (!p) throw notFound('Plan');
      const out = await one(db, `update plans set name=coalesce($2,name), prices=coalesce($3,prices), limits=coalesce($4,limits), features=coalesce($5,features), active=coalesce($6,active), updated_at=now() where code=$1 returning *`,
        [p.code, b.name ?? null, b.prices ? JSON.stringify({ ...p.prices, ...b.prices }) : null, b.limits ? JSON.stringify({ ...p.limits, ...b.limits }) : null, b.features ? JSON.stringify({ ...p.features, ...b.features }) : null, b.active ?? null]);
      await audit(db, { actorId: u.id, action: 'plan.updated', targetType: 'plan', targetId: p.code, detail: b });
      return out;
    });
  });

  app.get('/admin/orgs', async (req) => {
    admin(req);
    return (await pool.query(`select o.id, o.name, o.kind, o.is_demo, o.created_at, o.seat_limit, (select count(*)::int from memberships m where m.org_id=o.id) as members, (select p.code from subscriptions s join plans p on p.id=s.plan_id where s.org_id=o.id order by s.created_at desc limit 1) as plan from organizations o order by o.created_at desc`)).rows;
  });

  app.get('/admin/flags', async (req) => { admin(req); return (await pool.query(`select * from feature_flags order by key`)).rows; });
  app.patch('/admin/flags/:key', async (req) => {
    const u = admin(req);
    const b = z.object({ enabled: z.boolean() }).parse(req.body);
    return req.db(async (db) => {
      const r = await one(db, `update feature_flags set enabled=$2 where key=$1 returning *`, [(req.params as any).key, b.enabled]);
      if (!r) throw notFound('Flag');
      await audit(db, { actorId: u.id, action: 'flag.changed', targetType: 'flag', targetId: r.key, detail: b });
      return r;
    });
  });

  app.get('/admin/invoices', async (req) => { admin(req); return (await pool.query(`select i.*, o.name as org_name from invoices i join organizations o on o.id=i.org_id order by i.created_at desc`)).rows; });
  app.post('/admin/invoices', async (req) => {
    const u = admin(req);
    const b = z.object({ org_id: uuid, amount: z.number().positive(), currency: z.enum(['TZS', 'USD']), due_in_days: z.number().int().min(1).max(120).default(30) }).parse(req.body);
    return req.db(async (db) => {
      const n = `INV-${new Date().getFullYear()}-${String((await one(db, `select count(*)::int + 1 as n from invoices`)).n).padStart(5, '0')}`;
      const inv = await one(db, `insert into invoices(org_id, number, amount, currency, due_at, subscription_id) values ($1,$2,$3,$4, now() + ($5 || ' days')::interval, (select id from subscriptions where org_id=$1 order by created_at desc limit 1)) returning *`, [b.org_id, n, b.amount, b.currency, String(b.due_in_days)]);
      await audit(db, { orgId: b.org_id, actorId: u.id, action: 'invoice.issued', targetType: 'invoice', targetId: inv.id });
      return inv;
    });
  });
  // Administrator-approved bank-payment reconciliation; activates the subscription once.
  app.post('/admin/invoices/:id/reconcile', async (req) => {
    const u = admin(req);
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ bank_reference: z.string().min(3).max(100), amount_received: z.number().positive(), received_on: z.string() }).parse(req.body);
    return req.db(async (db) => {
      const inv = await one(db, `select * from invoices where id=$1 for update`, [id]);
      if (!inv) throw notFound('Invoice');
      if (inv.status === 'paid') throw conflict('already_paid', 'This invoice is already reconciled.');
      if (Number(b.amount_received) < Number(inv.amount)) throw conflict('underpaid', 'The amount received is less than the invoice amount.');
      await db.query(`update invoices set status='paid', paid_at=now(), reconciliation=$2 where id=$1`, [id, JSON.stringify({ ...b, approved_by: u.id })]);
      await db.query(`update subscriptions set status='active', current_period_start=now(), current_period_end=now() + interval '1 year' where id=$1`, [inv.subscription_id]);
      await audit(db, { orgId: inv.org_id, actorId: u.id, action: 'invoice.reconciled', targetType: 'invoice', targetId: id, detail: { bank_reference: b.bank_reference } });
      return { reconciled: true };
    });
  });

  // ---------------------------------------------------------------- audited support access
  app.post('/admin/support-access', async (req) => {
    const u = admin(req);
    const b = z.object({ document_id: uuid, justification: z.string().min(20).max(2000), hours: z.number().int().min(1).max(24).default(2) }).parse(req.body);
    return req.db(async (db) => {
      const exists = await one(db, `select org_id from support_lookup_document($1)`, [b.document_id]);
      if (!exists) throw notFound('Document');
      const g = await one(db, `insert into support_access_grants(platform_admin_id, document_id, justification, expires_at) values ($1,$2,$3, now() + ($4 || ' hours')::interval) returning *`, [u.id, b.document_id, b.justification, String(b.hours)]);
      await audit(db, { orgId: exists.org_id, actorId: u.id, action: 'support.access_granted', targetType: 'document', targetId: b.document_id, detail: { justification: b.justification, expires_at: g.expires_at } });
      return g;
    });
  });
  app.get('/admin/support-access', async (req) => { admin(req); return (await pool.query(`select g.*, u.name as admin_name from support_access_grants g join users u on u.id=g.platform_admin_id order by g.created_at desc limit 200`)).rows; });
  app.delete('/admin/support-access/:id', async (req) => {
    const u = admin(req);
    return req.db(async (db) => {
      await db.query(`update support_access_grants set revoked_at=now() where id=$1`, [(req.params as any).id]);
      await audit(db, { actorId: u.id, action: 'support.access_revoked', targetType: 'grant', targetId: (req.params as any).id });
      return { revoked: true };
    });
  });
  app.get('/admin/support/documents/:id', async (req) => {
    const u = admin(req);
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      // RLS returns the row only while a live grant exists for this admin.
      const d = await one(db, `select d.id, d.title, d.org_id, v.version_no, v.content_html from documents d join document_versions v on v.id=d.current_version_id where d.id=$1`, [id]);
      if (!d) throw forbidden('No active support access grant for this document.');
      await audit(db, { orgId: d.org_id, actorId: u.id, action: 'support.document_viewed', targetType: 'document', targetId: id });
      return d;
    });
  });
  app.get('/admin/audit', async (req) => {
    admin(req);
    return (await pool.query(`select a.*, u.name as actor from audit_events a left join users u on u.id=a.actor_id order by a.created_at desc limit 300`)).rows;
  });
}
