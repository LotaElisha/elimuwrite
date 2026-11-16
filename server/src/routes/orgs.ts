import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveTxt } from 'node:dns/promises';
import { one, many, type Db } from '../db.js';
import { requireOrgRole, type OrgRole } from '../lib/authz.js';
import { audit, newToken, notFound, badRequest, conflict, forbidden } from '../lib/misc.js';
import { sha256 } from '../lib/text.js';
import { indexSource } from '../jobs/queue.js';
import { tokenize } from '../engines/similarity.js';
import { config } from '../config.js';

const uuid = z.string().uuid();
const ROLE = z.enum(['student', 'instructor', 'reviewer', 'org_admin', 'billing_admin']);

let dnsResolver: (d: string) => Promise<string[][]> = resolveTxt;
export function setDnsResolver(f: typeof dnsResolver) { dnsResolver = f; }

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export async function previewImport(db: Db, orgId: string, csv: string) {
  const rows = parseCsv(csv);
  if (!rows.length) throw badRequest('The CSV file is empty.');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const ei = header.indexOf('email'), ni = header.indexOf('name'), ri = header.indexOf('role');
  if (ei < 0) throw badRequest('The CSV needs an "email" column. Optional columns: name, role.');
  const seen = new Set<string>();
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const email = (rows[i][ei] ?? '').trim().toLowerCase();
    const name = ni >= 0 ? (rows[i][ni] ?? '').trim() : '';
    const roleRaw = ri >= 0 ? (rows[i][ri] ?? '').trim().toLowerCase() || 'student' : 'student';
    let status: 'new_invitation' | 'add_existing_user' | 'already_member' | 'duplicate_in_file' | 'invalid_email' | 'invalid_role' | 'admin_role_requires_manual' = 'new_invitation';
    if (!z.string().email().safeParse(email).success) status = 'invalid_email';
    else if (!ROLE.safeParse(roleRaw).success) status = 'invalid_role';
    else if (roleRaw === 'org_admin' || roleRaw === 'billing_admin') status = 'admin_role_requires_manual';
    else if (seen.has(email)) status = 'duplicate_in_file';
    else {
      const u = await one(db, `select u.id, m.id as mid from users u left join memberships m on m.user_id=u.id and m.org_id=$2 where u.email=$1`, [email, orgId]);
      if (u?.mid) status = 'already_member';
      else if (u) status = 'add_existing_user';
    }
    seen.add(email);
    out.push({ line: i + 1, email, name, role: roleRaw, status });
  }
  const summary: Record<string, number> = {};
  for (const r of out) summary[r.status] = (summary[r.status] ?? 0) + 1;
  // The commit must reference this exact preview so nothing changes between review and confirm.
  return { rows: out, summary, preview_hash: sha256(orgId + csv) };
}

export async function orgRoutes(app: FastifyInstance) {
  // Institutional onboarding: details, timezone, departments, seats → trial workspace.
  app.post('/orgs', async (req) => {
    const u = req.me();
    const b = z.object({
      name: z.string().min(2).max(200),
      kind: z.enum(['school', 'college', 'university', 'training', 'research']).default('university'),
      timezone: z.string().max(60).default('Africa/Dar_es_Salaam'),
      logo_url: z.string().url().optional(),
      departments: z.array(z.string().min(1).max(120)).max(50).default([]),
      seats: z.number().int().min(1).max(100000).default(50),
    }).parse(req.body);
    try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw badRequest('Unknown timezone.'); }
    return req.db(async (db) => {
      const slug = b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + newToken().slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
      const o = await one(db, `insert into organizations(name, slug, kind, timezone, logo_url, seat_limit, trial_ends_at) values ($1,$2,$3,$4,$5,$6, now() + interval '30 days') returning *`,
        [b.name, slug, b.kind, b.timezone, b.logo_url ?? null, b.seats]);
      await db.query(`insert into memberships(org_id, user_id, roles) values ($1,$2,'{org_admin,billing_admin}')`, [o.id, u.id]);
      for (const d of b.departments) await db.query(`insert into departments(org_id, name) values ($1,$2)`, [o.id, d]);
      const plan = await one(db, `select id from plans where code='institution'`);
      if (plan) await db.query(`insert into subscriptions(org_id, plan_id, status, seats, current_period_end) values ($1,$2,'trialing',$3, now() + interval '30 days')`, [o.id, plan.id, b.seats]);
      await audit(db, { orgId: o.id, actorId: u.id, action: 'org.created', targetType: 'organization', targetId: o.id });
      return o;
    });
  });

  app.get('/orgs/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const roles = await requireOrgRole(db, id, u.id, 'any');
      const o = await one(db, `select id, name, slug, kind, logo_url, timezone, seat_limit, trial_ends_at, is_demo, settings, created_at from organizations where id=$1`, [id]);
      const counts = await one(db, `select (select count(*)::int from memberships where org_id=$1 and status='active') as members, (select count(*)::int from courses where org_id=$1) as courses`, [id]);
      return { ...o, my_roles: roles, counts, departments: await many(db, `select id, name from departments where org_id=$1 order by name`, [id]) };
    });
  });

  app.patch('/orgs/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({
      name: z.string().min(2).max(200).optional(), timezone: z.string().optional(), logo_url: z.string().url().nullable().optional(),
      settings: z.object({
        anonymous_marking: z.boolean().optional(),
        repository_inclusion: z.enum(['none', 'opt_in', 'all_submissions']).optional(),
        cross_institution_comparison: z.literal(false).optional(), // not available until agreements exist
        retention_days: z.number().int().min(30).max(3650).optional(),
        offline_drafts_allowed: z.boolean().optional(),
        default_assistance_preset: z.string().optional(),
      }).optional(),
    }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      if (b.name) await db.query(`update organizations set name=$2 where id=$1`, [id, b.name]);
      if (b.timezone) await db.query(`update organizations set timezone=$2 where id=$1`, [id, b.timezone]);
      if (b.logo_url !== undefined) await db.query(`update organizations set logo_url=$2 where id=$1`, [id, b.logo_url]);
      if (b.settings) await db.query(`update organizations set settings = settings || $2::jsonb where id=$1`, [id, JSON.stringify(b.settings)]);
      await audit(db, { orgId: id, actorId: u.id, action: 'org.settings_changed', targetType: 'organization', targetId: id, detail: { fields: Object.keys(b.settings ?? {}).concat(Object.keys(b).filter((k) => k !== 'settings')) } });
      return { ok: true };
    });
  });

  app.post('/orgs/:id/departments', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['org_admin']); return one(db, `insert into departments(org_id, name) values ($1,$2) returning *`, [id, b.name]); });
  });

  // ---------------------------------------------------------------- members
  app.get('/orgs/:id/members', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin', 'instructor']);
      return many(db, `select u.id, u.name, u.email, m.roles, m.status, m.created_at from memberships m join users u on u.id=m.user_id where m.org_id=$1 order by u.name`, [id]);
    });
  });

  app.patch('/orgs/:id/members/:uid', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, uid: uuid }).parse(req.params);
    const b = z.object({ roles: z.array(ROLE).min(1).optional(), status: z.enum(['active', 'suspended']).optional() }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, p.id, u.id, ['org_admin']);
      if (p.uid === u.id && b.roles && !b.roles.includes('org_admin')) {
        const admins = await one(db, `select count(*)::int as n from memberships where org_id=$1 and 'org_admin'=any(roles) and status='active'`, [p.id]);
        if (admins.n <= 1) throw conflict('last_admin', 'You are the only administrator. Add another administrator first.');
      }
      const r = await one(db, `update memberships set roles=coalesce($3, roles), status=coalesce($4, status) where org_id=$1 and user_id=$2 returning roles, status`, [p.id, p.uid, b.roles ?? null, b.status ?? null]);
      if (!r) throw notFound('Member');
      await audit(db, { orgId: p.id, actorId: u.id, action: 'membership.changed', targetType: 'user', targetId: p.uid, detail: r });
      return r;
    });
  });

  app.post('/orgs/:id/invitations', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ email: z.string().email().optional(), roles: z.array(ROLE).min(1).default(['student']), max_uses: z.number().int().min(1).max(1000).default(1), expires_in_days: z.number().int().min(1).max(60).default(14) }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      if (!b.email && b.roles.some((r) => r === 'org_admin' || r === 'billing_admin')) throw badRequest('Administrator invitations must be addressed to a specific email.');
      const token = newToken();
      const inv = await one(db, `insert into invitations(org_id, email, roles, token_hash, expires_at, max_uses, created_by) values ($1,$2,$3,$4, now() + ($5 || ' days')::interval, $6, $7) returning id, email, roles, expires_at, max_uses`,
        [id, b.email ?? null, b.roles, sha256(token), String(b.expires_in_days), b.max_uses, u.id]);
      await audit(db, { orgId: id, actorId: u.id, action: 'invitation.created', targetType: 'invitation', targetId: inv.id, detail: { roles: b.roles, max_uses: b.max_uses } });
      return { ...inv, token, link: `${config.brand.domain}/invite/${token}` };
    });
  });

  app.post('/orgs/:id/members/import/preview', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ csv: z.string().min(1).max(2_000_000) }).parse(req.body);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['org_admin']); return previewImport(db, id, b.csv); });
  });

  app.post('/orgs/:id/members/import/commit', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ csv: z.string().min(1).max(2_000_000), preview_hash: z.string() }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      const p = await previewImport(db, id, b.csv);
      if (p.preview_hash !== b.preview_hash) throw conflict('preview_mismatch', 'The file changed since the preview. Preview it again.');
      const links: { email: string; link: string }[] = [];
      let added = 0;
      for (const r of p.rows) {
        if (r.status === 'add_existing_user') {
          const usr = await one(db, `select id from users where email=$1`, [r.email]);
          await db.query(`insert into memberships(org_id, user_id, roles) values ($1,$2,$3) on conflict do nothing`, [id, usr.id, [r.role]]);
          added++;
        } else if (r.status === 'new_invitation') {
          const token = newToken();
          await db.query(`insert into invitations(org_id, email, roles, token_hash, expires_at, created_by) values ($1,$2,$3,$4, now() + interval '30 days', $5)`, [id, r.email, [r.role], sha256(token), u.id]);
          links.push({ email: r.email, link: `${config.brand.domain}/invite/${token}` });
        }
      }
      await audit(db, { orgId: id, actorId: u.id, action: 'members.bulk_import', targetType: 'organization', targetId: id, detail: p.summary });
      return { added_existing: added, invitations: links, skipped: p.rows.filter((r) => !['add_existing_user', 'new_invitation'].includes(r.status)).length, note: 'Email delivery is not configured; share the invitation links with each person.' };
    });
  });

  // ---------------------------------------------------------------- domains (verify authority before provisioning)
  app.get('/orgs/:id/domains', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['org_admin']); return many(db, `select * from org_domains where org_id=$1`, [id]); });
  });
  app.post('/orgs/:id/domains', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ domain: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i) }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      const d = await one(db, `insert into org_domains(org_id, domain, verification_token) values ($1,$2,$3) returning *`, [id, b.domain.toLowerCase(), 'elimuwrite-verify=' + newToken().slice(0, 24)]);
      return { ...d, instructions: `Add a DNS TXT record on ${b.domain} with the value ${d.verification_token}, then press Verify.` };
    });
  });
  app.post('/orgs/:id/domains/:did/verify', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, did: uuid }).parse(req.params);
    return req.db(async (db) => {
      await requireOrgRole(db, p.id, u.id, ['org_admin']);
      const d = await one(db, `select * from org_domains where id=$1 and org_id=$2`, [p.did, p.id]);
      if (!d) throw notFound('Domain');
      let records: string[] = [];
      try { records = (await dnsResolver(d.domain)).map((r) => r.join('')); } catch { /* treated as not found */ }
      if (!records.includes(d.verification_token)) return { verified: false, message: 'The TXT record was not found yet. DNS changes can take up to 48 hours.' };
      await db.query(`update org_domains set verified_at=now() where id=$1`, [d.id]);
      await audit(db, { orgId: p.id, actorId: u.id, action: 'domain.verified', targetType: 'domain', targetId: d.id, detail: { domain: d.domain } });
      return { verified: true };
    });
  });
  app.patch('/orgs/:id/domains/:did', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, did: uuid }).parse(req.params);
    const b = z.object({ provisioning_enabled: z.boolean() }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, p.id, u.id, ['org_admin']);
      const d = await one(db, `select * from org_domains where id=$1 and org_id=$2`, [p.did, p.id]);
      if (!d) throw notFound('Domain');
      if (b.provisioning_enabled && !d.verified_at) throw conflict('domain_unverified', 'Verify the domain before enabling account provisioning.');
      await db.query(`update org_domains set provisioning_enabled=$2 where id=$1`, [d.id, b.provisioning_enabled]);
      await audit(db, { orgId: p.id, actorId: u.id, action: 'domain.provisioning_changed', targetType: 'domain', targetId: d.id, detail: b });
      return { ok: true, note: 'Provisioned accounts join as students only. Administrator roles are never granted by email domain.' };
    });
  });

  // ---------------------------------------------------------------- terminology & repository
  app.get('/orgs/:id/terminology', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, 'any'); return many(db, `select * from org_terminology where org_id=$1 order by term`, [id]); });
  });
  app.post('/orgs/:id/terminology', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ term: z.string().min(1).max(100), preferred: z.string().max(100).nullable().optional(), note: z.string().max(300).optional() }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      return one(db, `insert into org_terminology(org_id, term, preferred, note) values ($1,$2,$3,$4) on conflict (org_id, term) do update set preferred=excluded.preferred, note=excluded.note returning *`, [id, b.term, b.preferred ?? null, b.note ?? null]);
    });
  });

  // Repository inclusion is an explicit, explained action, separate from uploading.
  app.get('/orgs/:id/repository', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin', 'instructor']);
      return many(db, `select id, title, url, author, token_count, inclusion_reason, created_at from sources where org_id=$1 and scope='institution_repository' order by created_at desc`, [id]);
    });
  });
  app.post('/orgs/:id/repository', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ title: z.string().min(1).max(300), text: z.string().min(50).max(2_000_000), url: z.string().url().optional(), author: z.string().max(300).optional(), inclusion_reason: z.string().min(10).max(500), rights_confirmed: z.literal(true) }).parse(req.body);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      const s = await one(db, `insert into sources(owner_user_id, org_id, scope, title, url, author, content_text, token_count, inclusion_reason) values ($1,$2,'institution_repository',$3,$4,$5,$6,$7,$8) returning id, title, token_count`,
        [u.id, id, b.title, b.url ?? null, b.author ?? null, b.text, tokenize(b.text).length, b.inclusion_reason]);
      await indexSource(db, s.id, b.text, u.id, id);
      await audit(db, { orgId: id, actorId: u.id, action: 'repository.item_added', targetType: 'source', targetId: s.id, detail: { reason: b.inclusion_reason } });
      return s;
    });
  });
  app.delete('/orgs/:id/repository/:sid', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, sid: uuid }).parse(req.params);
    return req.db(async (db) => {
      await requireOrgRole(db, p.id, u.id, ['org_admin']);
      const r = await db.query(`delete from sources where id=$1 and org_id=$2 and scope='institution_repository'`, [p.sid, p.id]);
      if (!r.rowCount) throw notFound('Source');
      await audit(db, { orgId: p.id, actorId: u.id, action: 'repository.item_removed', targetType: 'source', targetId: p.sid });
      return { deleted: true };
    });
  });

  // ---------------------------------------------------------------- analytics (aggregated; no student ranking)
  app.get('/orgs/:id/analytics', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      return {
        adoption: await many(db, `select r as role, count(*)::int as members from memberships, unnest(roles) r where org_id=$1 and status='active' group by r`, [id]),
        submission_completion: await many(db,
          `select a.id, a.title, c.code as course, a.due_at,
             (select count(*)::int from course_members cm where cm.course_id=a.course_id and cm.role='student') as enrolled,
             (select count(distinct student_id)::int from submissions s where s.assignment_id=a.id) as submitted
           from assignments a join courses c on c.id=a.course_id where a.org_id=$1 order by a.due_at nulls last`, [id]),
        marking_workload: await one(db,
          `select count(*) filter (where g.id is null or g.status='draft')::int as awaiting_marking, count(*) filter (where g.status='approved')::int as awaiting_release, count(*) filter (where g.status='released')::int as released
           from (select distinct on (assignment_id, student_id) id from submissions where org_id=$1 order by assignment_id, student_id, attempt_no desc) s left join grades g on g.submission_id=s.id`, [id]),
        // Aggregated across students; categories only, never per-student.
        common_writing_difficulties: await many(db,
          `select le.category, count(*)::int as occurrences, count(distinct le.user_id)::int as students from learning_events le
           join memberships m on m.user_id=le.user_id and m.org_id=$1 and 'student'=any(m.roles) where le.outcome='flagged' and le.created_at > now() - interval '90 days'
           group by 1 having count(distinct le.user_id) >= 3 order by 2 desc limit 10`, [id]),
        resource_consumption: await many(db, `select kind, period, sum(quantity)::int as quantity from usage_records where org_id=$1 group by 1,2 order by 2 desc, 1`, [id]),
        note: 'Writing difficulties are shown only for categories affecting at least 3 students, to protect individuals.',
      };
    });
  });

  app.get('/orgs/:id/audit', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      return many(db, `select a.action, a.target_type, a.target_id, a.detail, a.created_at, u.name as actor from audit_events a left join users u on u.id=a.actor_id where a.org_id=$1 order by a.created_at desc limit 300`, [id]);
    });
  });

  app.get('/orgs/:id/exports/submissions.csv', async (req, reply) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const rows = await req.db(async (db) => {
      await requireOrgRole(db, id, u.id, ['org_admin']);
      await audit(db, { orgId: id, actorId: u.id, action: 'export.submissions_csv', targetType: 'organization', targetId: id });
      return many(db, `select c.code as course, a.title as assignment, u.email as student, s.attempt_no, s.received_at, s.is_late, s.content_hash, g.status as grade_status, g.total, g.max_total
        from submissions s join assignments a on a.id=s.assignment_id join courses c on c.id=a.course_id join users u on u.id=s.student_id left join grades g on g.submission_id=s.id where s.org_id=$1 order by c.code, a.title, u.email, s.attempt_no`, [id]);
    });
    const esc = (v: any) => { const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
    const head = ['course', 'assignment', 'student', 'attempt_no', 'received_at', 'is_late', 'content_hash', 'grade_status', 'total', 'max_total'];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="submissions.csv"');
    return [head.join(','), ...rows.map((r) => head.map((h) => esc(r[h])).join(','))].join('\n');
  });
}
