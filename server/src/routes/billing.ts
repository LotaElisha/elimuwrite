import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { one, many, withDb } from '../db.js';
import { config } from '../config.js';
import { requireOrgRole } from '../lib/authz.js';
import { payer, usageThisPeriod } from '../lib/entitlements.js';
import { audit, conflict, forbidden, HttpError, notFound } from '../lib/misc.js';

const uuid = z.string().uuid();

/** Signature = hex HMAC-SHA256(secret, raw body). Real providers plug their scheme in here. */
export function verifySignature(raw: string, signature: string | undefined, secret: string) {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function billingRoutes(app: FastifyInstance) {
  app.get('/billing', async (req) => {
    const u = req.me();
    const q = z.object({ org: uuid.optional() }).parse(req.query);
    return req.db(async (db) => {
      if (q.org) await requireOrgRole(db, q.org, u.id, ['billing_admin', 'org_admin']);
      const p = await payer(db, u.id, q.org ?? null);
      const usage = await usageThisPeriod(db, p);
      const seatsUsed = q.org ? (await one(db, `select count(*)::int as n from memberships where org_id=$1 and status='active'`, [q.org])).n : null;
      return {
        plan: p.plan, plan_name: p.planName, limits: p.limits, features: p.features, subscription: p.subscription && { status: p.subscription.status, interval: p.subscription.billing_interval, seats: p.subscription.seats, current_period_end: p.subscription.current_period_end, cancel_at_period_end: p.subscription.cancel_at_period_end },
        usage, seats_used: seatsUsed,
        invoices: q.org ? await many(db, `select id, number, amount, currency, status, due_at, paid_at from invoices where org_id=$1 order by created_at desc`, [q.org]) : [],
        payment_provider: config.providers.payments.provider && config.providers.payments.webhookSecret ? 'configured' : 'not_configured',
        usage_policy: 'Similarity checks are charged once per completed scan. Failed, cancelled, retried and duplicate requests are not charged.',
      };
    });
  });

  app.post('/billing/checkout', async (req) => {
    req.me();
    z.object({ plan: z.string(), interval: z.enum(['monthly', 'annual']), currency: z.enum(['TZS', 'USD']), org: uuid.optional() }).parse(req.body);
    if (!config.providers.payments.provider) {
      return { status: 'not_configured', message: 'Online payment is not configured yet. Institutions can request an invoice for bank payment.' };
    }
    // Paid access is activated only by a verified webhook, never by the browser returning from checkout.
    return { status: 'pending_provider', message: 'Provider integration pending merchant verification.' };
  });

  app.post('/billing/cancel', async (req) => {
    const u = req.me();
    const b = z.object({ org: uuid.optional() }).parse(req.body ?? {});
    return req.db(async (db) => {
      if (b.org) await requireOrgRole(db, b.org, u.id, ['billing_admin']);
      const r = await one(db, `update subscriptions set cancel_at_period_end=true where ${b.org ? 'org_id' : 'owner_user_id'}=$1 and status in ('active','trialing') returning current_period_end`, [b.org ?? u.id]);
      if (!r) throw notFound('Subscription');
      await audit(db, { orgId: b.org ?? null, actorId: u.id, action: 'subscription.cancel_requested' });
      return { cancel_at_period_end: true, access_until: r.current_period_end };
    });
  });

  app.put('/orgs/:id/seats', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ seats: z.number().int().min(1).max(100000) }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['billing_admin']);
      const used = (await one(db, `select count(*)::int as n from memberships where org_id=$1 and status='active'`, [id])).n;
      if (b.seats < used) throw conflict('seats_in_use', `${used} seats are in use. Remove members before reducing seats.`);
      await db.query(`update subscriptions set seats=$2 where org_id=$1 and status in ('active','trialing','past_due')`, [id, b.seats]);
      await db.query(`update organizations set seat_limit=$2 where id=$1`, [id, b.seats]);
      await audit(db, { orgId: id, actorId: u.id, action: 'subscription.seats_changed', detail: { seats: b.seats } });
      return { seats: b.seats };
    });
  });

  // Institution requests an invoice (bank transfer). Amount is set by the platform admin; prices are not invented.
  app.post('/orgs/:id/invoice-requests', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['billing_admin']);
      await audit(db, { orgId: id, actorId: u.id, action: 'invoice.requested' });
      return { requested: true, message: 'The platform team will issue an invoice. Payment is confirmed by an administrator after bank reconciliation.' };
    });
  });

  /**
   * Payment webhook. Signature verified on the raw body; events processed exactly once via the
   * (provider, provider_event_id) unique key, so provider retries cannot duplicate entitlements.
   */
  app.post('/webhooks/payments/:provider', { config: { rawBody: true } as any }, async (req, reply) => {
    const provider = (req.params as any).provider as string;
    const secret = config.providers.payments.webhookSecret;
    if (!config.providers.payments.provider || provider !== config.providers.payments.provider) return reply.status(404).send({ error: 'not_configured' });
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (!verifySignature(raw, req.headers['x-signature'] as string | undefined, secret)) throw new HttpError(401, 'bad_signature', 'Invalid signature');
    const ev = z.object({ id: z.string(), type: z.string(), data: z.object({ subscription_owner: z.object({ user_id: uuid.optional(), org_id: uuid.optional() }), plan: z.string(), interval: z.enum(['monthly', 'annual']).default('monthly') }) }).parse(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
    return withDb({}, async (db) => {
      const ins = await one(db, `insert into payment_events(provider, provider_event_id, type, payload) values ($1,$2,$3,$4) on conflict do nothing returning id`, [provider, ev.id, ev.type, JSON.stringify(ev)]);
      if (!ins) return { received: true, duplicate: true };
      if (ev.type === 'payment.succeeded') {
        const plan = await one(db, `select id from plans where code=$1`, [ev.data.plan]);
        if (!plan) throw new HttpError(400, 'unknown_plan', 'Unknown plan');
        const owner = ev.data.subscription_owner;
        const period = ev.data.interval === 'annual' ? '1 year' : '1 month';
        const existing = await one(db, `select id from subscriptions where ${owner.org_id ? 'org_id' : 'owner_user_id'}=$1 and status in ('active','trialing','past_due') for update`, [owner.org_id ?? owner.user_id]);
        if (existing) await db.query(`update subscriptions set plan_id=$2, status='active', billing_interval=$3, current_period_start=now(), current_period_end=now() + $4::interval, cancel_at_period_end=false where id=$1`, [existing.id, plan.id, ev.data.interval, period]);
        else await db.query(`insert into subscriptions(owner_user_id, org_id, plan_id, status, billing_interval, current_period_end) values ($1,$2,$3,'active',$4, now() + $5::interval)`, [owner.org_id ? null : owner.user_id, owner.org_id ?? null, plan.id, ev.data.interval, period]);
      }
      await db.query(`update payment_events set processed_at=now() where id=$1`, [ins.id]);
      return { received: true, duplicate: false };
    });
  });
}
