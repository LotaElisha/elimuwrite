import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, many } from '../db.js';
import { config } from '../config.js';
import { SESSION_COOKIE } from '../app.js';
import { hashPassword, verifyPassword, createSession, audit, HttpError, notFound, badRequest } from '../lib/misc.js';
import { sha256 } from '../lib/text.js';

const cookieOpts = () => ({ path: '/', httpOnly: true, sameSite: 'lax' as const, secure: config.cookieSecure, maxAge: config.sessionDays * 86400 });

export async function authRoutes(app: FastifyInstance) {
  // Personal onboarding asks only for what is necessary; goals, language and level are optional.
  app.post('/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({
      email: z.string().email().max(200),
      name: z.string().min(1).max(120),
      password: z.string().min(8).max(200),
      locale: z.enum(['en', 'sw']).optional(),
      english_variant: z.enum(['en-US', 'en-GB']).optional(),
      academic_level: z.string().max(60).optional(),
      writing_goals: z.array(z.string().max(60)).max(10).optional(),
      invitation_token: z.string().optional(),
    }).parse(req.body);
    const pw = await hashPassword(b.password);
    const out = await req.db(async (db) => {
      const exists = await one(db, `select 1 from users where email=$1`, [b.email]);
      if (exists) throw new HttpError(409, 'email_taken', 'An account with this email already exists.');
      const u = await one(db,
        `insert into users(email, name, password_hash, locale, english_variant, academic_level, writing_goals) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [b.email, b.name, pw, b.locale ?? 'en', b.english_variant ?? 'en-US', b.academic_level ?? null, b.writing_goals ?? []]);
      // Domain-wide provisioning only for VERIFIED domains with provisioning switched on, and only as student.
      // An email on a school domain never grants administrator rights.
      const domain = b.email.split('@')[1].toLowerCase();
      const orgs = await many(db, `select org_id from org_domains where domain=$1 and verified_at is not null and provisioning_enabled`, [domain]);
      for (const o of orgs) {
        await db.query(`insert into memberships(org_id, user_id, roles) values ($1,$2,'{student}') on conflict do nothing`, [o.org_id, u.id]);
        await audit(db, { orgId: o.org_id, actorId: u.id, action: 'membership.domain_provisioned', targetType: 'user', targetId: u.id });
      }
      if (b.invitation_token) await acceptInvitation(db, b.invitation_token, u.id, b.email);
      return { id: u.id, token: await createSession(db, u.id) };
    });
    reply.setCookie(SESSION_COOKIE, out.token, cookieOpts());
    return { id: out.id, token: out.token };
  });

  app.post('/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const out = await req.db(async (db) => {
      const u = await one(db, `select id, password_hash from users where email=$1`, [b.email]);
      if (!u || !(await verifyPassword(b.password, u.password_hash))) throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect.');
      return { id: u.id, token: await createSession(db, u.id) };
    });
    reply.setCookie(SESSION_COOKIE, out.token, cookieOpts());
    return out;
  });

  app.post('/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await req.db((db) => db.query(`delete from sessions where token_hash=$1`, [sha256(t)]));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const u = req.me();
    return req.db(async (db) => {
      const full = await one(db, `select id, email, name, locale, english_variant, academic_level, writing_goals, is_platform_admin, is_demo, created_at from users where id=$1`, [u.id]);
      return { ...full, workspaces: await workspaces(db, u.id) };
    });
  });

  app.patch('/me', async (req) => {
    const u = req.me();
    const b = z.object({ name: z.string().min(1).max(120).optional(), locale: z.enum(['en', 'sw']).optional(), english_variant: z.enum(['en-US', 'en-GB']).optional(), academic_level: z.string().max(60).nullable().optional(), writing_goals: z.array(z.string()).optional() }).parse(req.body);
    return req.db(async (db) => {
      for (const [k, v] of Object.entries(b)) if (v !== undefined) await db.query(`update users set ${k}=$2 where id=$1`, [u.id, v]);
      return { ok: true };
    });
  });

  // Personal data export (documents, versions metadata, references). Institutional records are exported by the institution.
  app.get('/me/export', async (req, reply) => {
    const u = req.me();
    const data = await req.db(async (db) => ({
      exported_at: new Date().toISOString(),
      user: await one(db, `select email, name, locale, english_variant, academic_level, writing_goals, created_at from users where id=$1`, [u.id]),
      documents: await many(db, `select d.id, d.title, d.created_at, v.version_no, v.content_html from documents d left join document_versions v on v.id=d.current_version_id where d.owner_user_id=$1 and d.org_id is null and d.deleted_at is null`, [u.id]),
      references: await many(db, `select csl, tags, notes from refs where owner_user_id=$1 and org_id is null`, [u.id]),
      dictionary: (await many(db, `select word from personal_dictionary where user_id=$1`, [u.id])).map((r) => r.word),
    }));
    reply.header('content-disposition', 'attachment; filename="elimuwrite-export.json"');
    return data;
  });

  app.get('/invitations/:token', async (req) => {
    const t = (req.params as any).token;
    const inv = await req.db((db) => one(db, `select i.email, i.roles, i.expires_at, o.name as org_name from invitations i join organizations o on o.id=i.org_id where token_hash=$1 and expires_at > now() and uses < max_uses`, [sha256(t)]));
    if (!inv) throw notFound('Invitation');
    return inv;
  });

  app.post('/invitations/:token/accept', async (req) => {
    const u = req.me();
    return req.db(async (db) => acceptInvitation(db, (req.params as any).token, u.id, u.email));
  });
}

export async function acceptInvitation(db: any, token: string, userId: string, email: string) {
  const inv = await one(db, `select * from invitations where token_hash=$1 for update`, [sha256(token)]);
  if (!inv || new Date(inv.expires_at) < new Date() || inv.uses >= inv.max_uses) throw notFound('Invitation');
  if (inv.email && inv.email.toLowerCase() !== email.toLowerCase()) throw badRequest('This invitation was sent to a different email address.');
  await db.query(
    `insert into memberships(org_id, user_id, roles) values ($1,$2,$3)
     on conflict (org_id, user_id) do update set roles = (select array(select distinct unnest(memberships.roles || excluded.roles)))`,
    [inv.org_id, userId, inv.roles]);
  await db.query(`update invitations set uses = uses + 1 where id=$1`, [inv.id]);
  await audit(db, { orgId: inv.org_id, actorId: userId, action: 'invitation.accepted', targetType: 'invitation', targetId: inv.id });
  return { org_id: inv.org_id, roles: inv.roles };
}

export async function workspaces(db: any, userId: string) {
  const orgs = await many(db,
    `select o.id, o.name, o.slug, o.logo_url, o.timezone, o.is_demo, m.roles from memberships m join organizations o on o.id=m.org_id where m.user_id=$1 and m.status='active' order by o.name`, [userId]);
  return [{ kind: 'personal', id: 'personal', name: 'Personal workspace' }, ...orgs.map((o) => ({ kind: 'institution', ...o }))];
}
