import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { one, many, type Db } from '../db.js';
import { requireOrgRole, courseRole, requireTeaches, ownDocument } from '../lib/authz.js';
import { audit, notFound, badRequest, conflict, forbidden, HttpError } from '../lib/misc.js';
import { sha256 } from '../lib/text.js';
import { resolvePolicy, PRESETS, CAPABILITIES } from '../engines/policy.js';
import { tokenize } from '../engines/similarity.js';
import { enqueue, indexSource } from '../jobs/queue.js';
import { createDocument } from './documents.js';

const uuid = z.string().uuid();

const policyOverrides = z.object(Object.fromEntries([...CAPABILITIES, 'disclosure_required'].map((c) => [c, z.boolean().optional()]))).partial();

async function enqueueSubmissionScan(db: Db, sub: any, settings: any, key: string, requestedBy: string) {
  return enqueue(db, { kind: 'similarity', documentId: sub.document_id, versionId: sub.version_id, submissionId: sub.id, orgId: sub.org_id, ownerUserId: sub.student_id, requestedBy, settings, idempotencyKey: key });
}

function anonLabel(assignmentId: string, studentId: string) {
  return 'Student ' + sha256(assignmentId + studentId).slice(0, 4).toUpperCase();
}

export async function teachingRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- courses
  app.get('/orgs/:id/courses', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const roles = await requireOrgRole(db, id, u.id, 'any');
      const all = roles.includes('org_admin');
      return many(db,
        `select c.*, d.name as department, (select count(*)::int from course_members m where m.course_id=c.id and m.role='student') as students,
           (select array_agg(role) from course_members m where m.course_id=c.id and m.user_id=$2) as my_roles
         from courses c left join departments d on d.id=c.department_id where c.org_id=$1 ${all ? '' : 'and exists (select 1 from course_members m where m.course_id=c.id and m.user_id=$2)'} order by c.code`, [id, u.id]);
    });
  });

  app.post('/orgs/:id/courses', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ code: z.string().min(1).max(40), title: z.string().min(1).max(200), term: z.string().max(60).optional(), cohort: z.string().max(60).optional(), department_id: uuid.optional() }).parse(req.body);
    return req.db(async (db) => {
      const roles = await requireOrgRole(db, id, u.id, ['org_admin', 'instructor']);
      const c = await one(db, `insert into courses(org_id, department_id, code, title, term, cohort) values ($1,$2,$3,$4,$5,$6) returning *`, [id, b.department_id ?? null, b.code, b.title, b.term ?? null, b.cohort ?? null]);
      if (roles.includes('instructor')) await db.query(`insert into course_members(org_id, course_id, user_id, role) values ($1,$2,$3,'instructor')`, [id, c.id, u.id]);
      await audit(db, { orgId: id, actorId: u.id, action: 'course.created', targetType: 'course', targetId: c.id });
      return c;
    });
  });

  app.get('/courses/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const cr = await courseRole(db, id, u.id);
      if (!cr.isInstructor && !cr.isStudent) throw notFound('Course');
      const c = await one(db, `select c.*, o.timezone, o.name as org_name from courses c join organizations o on o.id=c.org_id where c.id=$1`, [id]);
      const assignments = await many(db, `select id, title, due_at, assistance_preset, max_attempts from assignments where course_id=$1 order by due_at nulls last`, [id]);
      const members = cr.isInstructor ? await many(db, `select u.id, u.name, u.email, m.role from course_members m join users u on u.id=m.user_id where m.course_id=$1 order by m.role, u.name`, [id]) : undefined;
      return { ...c, assignments, members, is_instructor: cr.isInstructor, is_student: cr.isStudent };
    });
  });

  app.post('/courses/:id/members', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ email: z.string().email(), role: z.enum(['student', 'instructor', 'reviewer']) }).parse(req.body);
    return req.db(async (db) => {
      const cr = await courseRole(db, id, u.id);
      if (!cr.isInstructor) throw forbidden();
      if (b.role !== 'student' && !cr.orgRoles.includes('org_admin')) throw forbidden('Only administrators assign instructors.');
      const m = await one(db, `select u.id, m.roles from users u join memberships m on m.user_id=u.id and m.org_id=$2 and m.status='active' where u.email=$1`, [b.email, cr.orgId]);
      if (!m) throw badRequest('That person is not a member of this institution yet. Invite them first.');
      if (b.role === 'student' && !m.roles.includes('student')) await db.query(`update memberships set roles = array_append(roles, 'student') where org_id=$1 and user_id=$2`, [cr.orgId, m.id]);
      if (b.role !== 'student' && !m.roles.includes('instructor')) await db.query(`update memberships set roles = array_append(roles, 'instructor') where org_id=$1 and user_id=$2`, [cr.orgId, m.id]);
      await db.query(`insert into course_members(org_id, course_id, user_id, role) values ($1,$2,$3,$4) on conflict do nothing`, [cr.orgId, id, m.id, b.role]);
      await audit(db, { orgId: cr.orgId, actorId: u.id, action: 'course.enrolled', targetType: 'course', targetId: id, detail: { user: m.id, role: b.role } });
      return { ok: true };
    });
  });

  app.delete('/courses/:id/members/:uid', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, uid: uuid }).parse(req.params);
    return req.db(async (db) => {
      const cr = await courseRole(db, p.id, u.id);
      if (!cr.isInstructor) throw forbidden();
      await db.query(`delete from course_members where course_id=$1 and user_id=$2 and role='student'`, [p.id, p.uid]);
      return { ok: true };
    });
  });

  // ---------------------------------------------------------------- rubrics
  app.get('/orgs/:id/rubrics', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['org_admin', 'instructor', 'reviewer']); return many(db, `select * from rubrics where org_id=$1 order by created_at desc`, [id]); });
  });
  app.post('/orgs/:id/rubrics', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ title: z.string().min(1).max(200), criteria: z.array(z.object({ id: z.string().min(1).max(40), title: z.string().min(1).max(200), description: z.string().max(1000).default(''), max_points: z.number().positive().max(1000) })).min(1).max(30) }).parse(req.body);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['org_admin', 'instructor']); return one(db, `insert into rubrics(org_id, title, criteria, created_by) values ($1,$2,$3,$4) returning *`, [id, b.title, JSON.stringify(b.criteria), u.id]); });
  });

  // ---------------------------------------------------------------- assignments
  const assignmentBody = z.object({
    title: z.string().min(1).max(200),
    instructions: z.string().max(20000).default(''),
    due_at: z.string().datetime({ offset: true }).nullable().optional(),
    accepted_types: z.array(z.enum(['editor', 'txt', 'docx', 'pdf'])).min(1).default(['editor', 'txt', 'docx', 'pdf']),
    max_attempts: z.number().int().min(1).max(20).default(3),
    similarity_settings: z.object({ exclude_quotes: z.boolean().default(true), exclude_bibliography: z.boolean().default(true), min_match_words: z.number().int().min(5).max(50).default(8), compare_within_class: z.boolean().default(true), include_repository: z.boolean().default(true), include_own_drafts: z.boolean().default(false), show_report_to_students: z.boolean().default(false) }).default({} as any),
    assistance_preset: z.enum(Object.keys(PRESETS) as [string, ...string[]]).default('guided_learning'),
    assistance_overrides: policyOverrides.default({}),
    rubric_id: uuid.nullable().optional(),
    template_text: z.string().max(200000).optional(),
  });

  app.post('/courses/:id/assignments', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = assignmentBody.parse(req.body);
    return req.db(async (db) => {
      const cr = await courseRole(db, id, u.id);
      if (!cr.isInstructor) throw forbidden();
      const policy = resolvePolicy(b.assistance_preset, b.assistance_overrides as any);
      const a = await one(db,
        `insert into assignments(org_id, course_id, title, instructions, due_at, accepted_types, max_attempts, similarity_settings, assistance_preset, assistance_policy, rubric_id, template_text, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
        [cr.orgId, id, b.title, b.instructions, b.due_at ?? null, b.accepted_types, b.max_attempts, JSON.stringify(b.similarity_settings), b.assistance_preset, JSON.stringify(policy), b.rubric_id ?? null, b.template_text ?? null, u.id]);
      await db.query(`insert into assignment_policy_versions(assignment_id, version, preset, policy) values ($1,1,$2,$3)`, [a.id, b.assistance_preset, JSON.stringify(policy)]);
      if (b.template_text) {
        const s = await one(db, `insert into sources(owner_user_id, org_id, scope, title, content_text, token_count, assignment_id) values ($1,$2,'assignment_template',$3,$4,$5,$6) returning id`, [u.id, cr.orgId, `Template: ${b.title}`, b.template_text, tokenize(b.template_text).length, a.id]);
        await indexSource(db, s.id, b.template_text, u.id, cr.orgId);
      }
      await audit(db, { orgId: cr.orgId, actorId: u.id, action: 'assignment.created', targetType: 'assignment', targetId: a.id });
      return a;
    });
  });

  app.patch('/assignments/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = assignmentBody.partial().parse(req.body);
    return req.db(async (db) => {
      const orgId = await requireTeaches(db, id);
      const a = await one(db, `select * from assignments where id=$1`, [id]);
      const simple: Record<string, unknown> = { title: b.title, instructions: b.instructions, due_at: b.due_at, max_attempts: b.max_attempts, rubric_id: b.rubric_id, accepted_types: b.accepted_types };
      for (const [k, v] of Object.entries(simple)) if (v !== undefined) await db.query(`update assignments set ${k}=$2, updated_at=now() where id=$1`, [id, v]);
      if (b.similarity_settings) await db.query(`update assignments set similarity_settings=$2 where id=$1`, [id, JSON.stringify(b.similarity_settings)]);
      if (b.assistance_preset || b.assistance_overrides) {
        // A policy change creates a new immutable policy version; earlier submissions keep theirs.
        const preset = b.assistance_preset ?? a.assistance_preset;
        const policy = resolvePolicy(preset, (b.assistance_overrides ?? {}) as any);
        const nv = a.policy_version + 1;
        await db.query(`update assignments set assistance_preset=$2, assistance_policy=$3, policy_version=$4, updated_at=now() where id=$1`, [id, preset, JSON.stringify(policy), nv]);
        await db.query(`insert into assignment_policy_versions(assignment_id, version, preset, policy) values ($1,$2,$3,$4)`, [id, nv, preset, JSON.stringify(policy)]);
      }
      await audit(db, { orgId, actorId: u.id, action: 'assignment.updated', targetType: 'assignment', targetId: id, detail: { fields: Object.keys(b) } });
      return one(db, `select * from assignments where id=$1`, [id]);
    });
  });

  app.get('/assignments/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const a = await one(db, `select a.*, c.title as course_title, c.code as course_code, o.timezone, o.name as org_name from assignments a join courses c on c.id=a.course_id join organizations o on o.id=a.org_id where a.id=$1`, [id]);
      if (!a) throw notFound('Assignment');
      const cr = await courseRole(db, a.course_id, u.id);
      if (!cr.isInstructor && !cr.isStudent) throw notFound('Assignment');
      const rubric = a.rubric_id ? await one(db, `select id, title, criteria from rubrics where id=$1`, [a.rubric_id]) : null;
      const policy = resolvePolicy(a.assistance_preset, a.assistance_policy);
      const base = { id: a.id, title: a.title, instructions: a.instructions, due_at: a.due_at, timezone: a.timezone, course_title: a.course_title, course_code: a.course_code, org_id: a.org_id, org_name: a.org_name, accepted_types: a.accepted_types, max_attempts: a.max_attempts, assistance_preset: a.assistance_preset, assistance_label: PRESETS[a.assistance_preset]?.label, policy, policy_version: a.policy_version, rubric, is_instructor: cr.isInstructor, policy_scope_note: 'These rules apply to tools used inside this platform for this assignment. They cannot control tools outside the platform.' };
      if (cr.isInstructor) return { ...base, similarity_settings: a.similarity_settings, template_text: a.template_text };
      const doc = await one(db, `select id, current_version_no from documents where assignment_id=$1 and owner_user_id=$2 and deleted_at is null`, [id, u.id]);
      const subs = await many(db, `select s.id, s.attempt_no, s.received_at, s.is_late, s.content_hash, s.policy_version, v.version_no, g.status as grade_status from submissions s join document_versions v on v.id=s.version_id left join grades g on g.submission_id=s.id where s.assignment_id=$1 and s.student_id=$2 order by s.attempt_no desc`, [id, u.id]);
      return { ...base, show_report_to_students: !!a.similarity_settings?.show_report_to_students, my_document: doc, my_submissions: subs.map((s) => ({ ...s, feedback_released: s.grade_status === 'released' || s.grade_status === 'revision_requested' })) };
    });
  });

  // Starts (or returns) the student's assignment document. Policy is shown before this.
  app.post('/assignments/:id/start', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const a = await one(db, `select * from assignments where id=$1`, [id]);
      if (!a) throw notFound('Assignment');
      const cr = await courseRole(db, a.course_id, u.id);
      if (!cr.isStudent) throw notFound('Assignment');
      const existing = await one(db, `select id from documents where assignment_id=$1 and owner_user_id=$2 and deleted_at is null`, [id, u.id]);
      if (existing) return { document_id: existing.id };
      const d = await createDocument(db, { ownerId: u.id, orgId: a.org_id, assignmentId: id, title: a.title, html: '<p></p>', origin: 'edit', variant: u.english_variant });
      return { document_id: d.id };
    });
  });

  /**
   * Submission: freezes the exact current version, records server receipt time, content hash and
   * the assignment policy version, then queues similarity asynchronously. Idempotent by key, so a
   * retried request (e.g. after a dropped connection) never creates a second submission.
   */
  app.post('/assignments/:id/submissions', async (req, reply) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ document_id: uuid, idempotency_key: z.string().min(8).max(100), disclosure: z.string().max(5000).optional(), expected_version_no: z.number().int().optional() }).parse(req.body);
    const out = await req.db(async (db) => {
      const prior = await one(db, `select * from submissions where idempotency_key=$1`, [`${u.id}:${b.idempotency_key}`]);
      if (prior) return { sub: prior, duplicate: true };
      const a = await one(db, `select a.*, o.timezone from assignments a join organizations o on o.id=a.org_id where a.id=$1 for update of a`, [id]);
      if (!a) throw notFound('Assignment');
      const cr = await courseRole(db, a.course_id, u.id);
      if (!cr.isStudent) throw notFound('Assignment');
      const d = await ownDocument(db, b.document_id, u.id);
      if (d.assignment_id !== id) throw badRequest('This document belongs to a different assignment.');
      if (b.expected_version_no !== undefined && b.expected_version_no !== d.current_version_no) throw conflict('version_changed', 'Your document changed after you pressed Submit. Review and submit again.');
      const v = await one(db, `select * from document_versions where id=$1`, [d.current_version_id]);
      if (v.word_count === 0) throw badRequest('The document is empty.');
      const prev = await many(db, `select id, version_id, lineage_id, attempt_no from submissions where assignment_id=$1 and student_id=$2 order by attempt_no`, [id, u.id]);
      if (prev.length >= a.max_attempts) throw conflict('attempts_exhausted', `This assignment allows ${a.max_attempts} submission(s).`);
      if (prev.some((p) => p.version_id === v.id)) throw conflict('already_submitted', 'This exact version has already been submitted.');
      const policy = resolvePolicy(a.assistance_preset, a.assistance_policy);
      if (policy.disclosure_required && !b.disclosure?.trim()) throw new HttpError(400, 'disclosure_required', 'This assignment requires an AI-assistance disclosure.');
      await db.query(`update document_versions set frozen=true where id=$1`, [v.id]);
      const subId = randomUUID();
      const lineage = prev[0]?.lineage_id ?? subId;
      const sub = await one(db,
        `insert into submissions(id, org_id, assignment_id, student_id, document_id, version_id, attempt_no, lineage_id, content_hash, policy_version, is_late, disclosure, idempotency_key)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, coalesce(now() > $11::timestamptz, false), $12, $13) returning *`,
        [subId, a.org_id, id, u.id, d.id, v.id, prev.length + 1, lineage, v.content_hash, a.policy_version, a.due_at, b.disclosure ?? null, `${u.id}:${b.idempotency_key}`]);
      const src = await one(db, `insert into sources(owner_user_id, org_id, scope, title, content_text, token_count, submission_id, assignment_id, student_id, lineage_id) values ($1,$2,'submission',$3,$4,$5,$6,$7,$8,$9) returning id`,
        [u.id, a.org_id, `Submission ${sub.id.slice(0, 8)}`, v.content_text, tokenize(v.content_text).length, sub.id, id, u.id, lineage]);
      await indexSource(db, src.id, v.content_text, u.id, a.org_id);
      await db.query(`insert into document_events(document_id, version_id, user_id, kind, detail) values ($1,$2,$3,'submission',$4)`, [d.id, v.id, u.id, JSON.stringify({ submission_id: sub.id, attempt: sub.attempt_no })]);
      await enqueueSubmissionScan(db, sub, a.similarity_settings, `sub:${sub.id}:similarity`, u.id);
      await audit(db, { orgId: a.org_id, actorId: u.id, action: 'submission.received', targetType: 'submission', targetId: sub.id, detail: { attempt: sub.attempt_no, hash: sub.content_hash } });
      return { sub, duplicate: false, timezone: a.timezone };
    });
    reply.status(out.duplicate ? 200 : 201);
    const s = out.sub;
    return { receipt: { submission_id: s.id, assignment_id: s.assignment_id, attempt_no: s.attempt_no, received_at: s.received_at, content_hash: s.content_hash, policy_version: s.policy_version, is_late: s.is_late, timezone: (out as any).timezone }, duplicate: out.duplicate, note: 'Your submission is received. Similarity analysis runs in the background; your submission stays submitted even if analysis is delayed or fails.' };
  });

  // Instructor inbox: latest attempt per student, with late labels and statuses.
  app.get('/assignments/:id/submissions', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const orgId = await requireTeaches(db, id);
      const anon = (await one(db, `select settings->>'anonymous_marking' as a from organizations where id=$1`, [orgId])).a === 'true';
      const rows = await many(db,
        `select distinct on (s.student_id) s.id, s.student_id, s.attempt_no, s.received_at, s.is_late, u.name, u.email, g.status as grade_status, g.total, g.max_total,
           (select status from analysis_jobs j where j.submission_id=s.id order by created_at desc limit 1) as scan_status,
           (select r.id from reports r where r.submission_id=s.id and r.kind='similarity' order by created_at desc limit 1) as report_id,
           (select r.status from reports r where r.submission_id=s.id and r.kind='similarity' order by created_at desc limit 1) as report_status,
           (select r.result->>'percentage' from reports r where r.submission_id=s.id and r.kind='similarity' order by created_at desc limit 1) as report_pct
         from submissions s join users u on u.id=s.student_id left join grades g on g.submission_id=s.id where s.assignment_id=$1 order by s.student_id, s.attempt_no desc`, [id]);
      const enrolled = await many(db, `select u.id, u.name from course_members m join users u on u.id=m.user_id join assignments a on a.course_id=m.course_id where a.id=$1 and m.role='student'`, [id]);
      const submitted = new Set(rows.map((r) => r.student_id));
      return {
        anonymous: anon,
        submissions: rows.map((r) => ({ ...r, name: anon ? anonLabel(id, r.student_id) : r.name, email: anon ? null : r.email, student_id: anon ? null : r.student_id })),
        not_submitted: anon ? enrolled.filter((e) => !submitted.has(e.id)).length : enrolled.filter((e) => !submitted.has(e.id)).map((e) => e.name),
      };
    });
  });

  app.post('/assignments/:id/recheck', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await requireTeaches(db, id);
      const a = await one(db, `select similarity_settings from assignments where id=$1`, [id]);
      const latest = await many(db, `select distinct on (student_id) * from submissions where assignment_id=$1 order by student_id, attempt_no desc`, [id]);
      const n = (await one(db, `select count(*)::int as n from submissions where assignment_id=$1`, [id])).n;
      let queued = 0;
      for (const s of latest) if (!(await enqueueSubmissionScan(db, s, a.similarity_settings, `sub:${s.id}:recheck:${n}`, u.id)).duplicate) queued++;
      return { queued, note: 'All latest submissions are compared against the same complete set, so submission order does not change treatment.' };
    });
  });

  // ---------------------------------------------------------------- submission review
  app.get('/submissions/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const s = await one(db, `select s.*, a.title as assignment_title, a.rubric_id, a.course_id, o.timezone, o.settings->>'anonymous_marking' as anon from submissions s join assignments a on a.id=s.assignment_id join organizations o on o.id=s.org_id where s.id=$1`, [id]);
      if (!s) throw notFound('Submission');
      const staff = (await one(db, `select app_teaches_assignment($1) as ok`, [s.assignment_id])).ok;
      const receipt = { submission_id: s.id, attempt_no: s.attempt_no, received_at: s.received_at, timezone: s.timezone, content_hash: s.content_hash, policy_version: s.policy_version, is_late: s.is_late, assignment_title: s.assignment_title };
      const grade = await one(db, `select * from grades where submission_id=$1`, [id]);
      if (!staff) {
        if (s.student_id !== u.id) throw notFound('Submission');
        const released = grade && ['released', 'revision_requested'].includes(grade.status);
        return { role: 'student', receipt, feedback: released ? { status: grade.status, rubric_scores: grade.rubric_scores, total: grade.total, max_total: grade.max_total, feedback: grade.feedback, released_at: grade.released_at, ai_assisted: grade.ai_assisted } : null,
          rubric: released && s.rubric_id ? await one(db, `select title, criteria from rubrics where id=$1`, [s.rubric_id]) : null,
          comments: released ? await many(db, `select body, quote, created_at from comments where submission_id=$1 order by created_at`, [id]) : [],
          responses: await many(db, `select id, kind, body, status, decision, created_at, decided_at from feedback_responses where submission_id=$1 order by created_at`, [id]) };
      }
      const v = await one(db, `select version_no, content_html, content_text, word_count from document_versions where id=$1`, [s.version_id]);
      const anon = s.anon === 'true';
      const student = anon ? { name: anonLabel(s.assignment_id, s.student_id) } : await one(db, `select name, email from users where id=$1`, [s.student_id]);
      // Authorship transparency: what the platform observed, without claiming to know external tool use.
      const activity = await many(db, `select kind, count(*)::int as n from document_events where document_id=$1 and created_at <= $2 group by kind`, [s.document_id, s.received_at]);
      const attempts = await many(db, `select id, attempt_no, received_at, is_late from submissions where lineage_id=$1 order by attempt_no`, [s.lineage_id]);
      const reports = await many(db, `select id, kind, status, created_at, result->>'percentage' as percentage, result->>'message' as message from reports where submission_id=$1 order by created_at desc`, [id]);
      const job = await one(db, `select status, error from analysis_jobs where submission_id=$1 order by created_at desc limit 1`, [id]);
      return {
        role: 'staff', org_id: s.org_id, receipt, student, version: v, disclosure: s.disclosure, attempts, reports, scan_status: job?.status ?? null,
        activity, activity_note: 'Counts of events recorded inside this platform. Pasted text has unknown origin, and typed text alone does not prove independent authorship.',
        rubric: s.rubric_id ? await one(db, `select id, title, criteria from rubrics where id=$1`, [s.rubric_id]) : null,
        grade, comments: await many(db, `select c.id, c.body, c.quote, c.created_at, u.name as author from comments c join users u on u.id=c.author_id where c.submission_id=$1 order by c.created_at`, [id]),
        responses: await many(db, `select id, kind, body, status, decision, created_at, decided_at from feedback_responses where submission_id=$1 order by created_at`, [id]),
      };
    });
  });

  const staffSubmission = async (db: Db, id: string) => {
    const s = await one(db, `select s.*, a.rubric_id from submissions s join assignments a on a.id=s.assignment_id where s.id=$1`, [id]);
    if (!s) throw notFound('Submission');
    await requireTeaches(db, s.assignment_id);
    return s;
  };

  app.put('/submissions/:id/grade', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ rubric_scores: z.record(z.string(), z.number().min(0)).default({}), feedback: z.string().max(20000).default(''), ai_assisted: z.boolean().default(false) }).parse(req.body);
    return req.db(async (db) => {
      const s = await staffSubmission(db, id);
      const g0 = await one(db, `select status from grades where submission_id=$1`, [id]);
      if (g0?.status === 'released') throw conflict('already_released', 'Released grades are changed through the review/appeal workflow.');
      let total: number | null = null, max: number | null = null;
      if (s.rubric_id) {
        const r = await one(db, `select criteria from rubrics where id=$1`, [s.rubric_id]);
        max = 0; total = 0;
        for (const c of r.criteria) {
          const pts = b.rubric_scores[c.id];
          if (pts !== undefined && pts > c.max_points) throw badRequest(`"${c.title}" allows at most ${c.max_points} points.`);
          max += c.max_points;
          total += pts ?? 0;
        }
      }
      // Saving always returns the grade to draft: any change needs fresh instructor approval.
      return one(db,
        `insert into grades(org_id, submission_id, rubric_scores, total, max_total, feedback, ai_assisted, graded_by, status) values ($1,$2,$3,$4,$5,$6,$7,$8,'draft')
         on conflict (submission_id) do update set rubric_scores=excluded.rubric_scores, total=excluded.total, max_total=excluded.max_total, feedback=excluded.feedback, ai_assisted=excluded.ai_assisted, graded_by=excluded.graded_by, status='draft', approved_by=null, approved_at=null, updated_at=now() returning *`,
        [s.org_id, id, JSON.stringify(b.rubric_scores), total, max, b.feedback, b.ai_assisted, u.id]);
    });
  });

  app.post('/submissions/:id/grade/approve', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const s = await staffSubmission(db, id);
      const g = await one(db, `update grades set status='approved', approved_by=$2, approved_at=now() where submission_id=$1 and status='draft' returning *`, [id, u.id]);
      if (!g) throw conflict('not_draft', 'Only a saved draft grade can be approved.');
      await audit(db, { orgId: s.org_id, actorId: u.id, action: 'grade.approved', targetType: 'submission', targetId: id });
      return g;
    });
  });

  const release = async (db: Db, s: any, userId: string, status: 'released' | 'revision_requested') => {
    const g = await one(db, `update grades set status=$2, released_at=now() where submission_id=$1 and status='approved' returning *`, [s.id, status]);
    if (!g) throw conflict('not_approved', 'An instructor must approve the grade and feedback before release.');
    await audit(db, { orgId: s.org_id, actorId: userId, action: status === 'released' ? 'grade.released' : 'grade.revision_requested', targetType: 'submission', targetId: s.id });
    return g;
  };
  app.post('/submissions/:id/grade/release', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => release(db, await staffSubmission(db, id), u.id, 'released'));
  });
  app.post('/submissions/:id/request-revision', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => release(db, await staffSubmission(db, id), u.id, 'revision_requested'));
  });
  app.post('/assignments/:id/release-approved', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const orgId = await requireTeaches(db, id);
      const r = await db.query(`update grades g set status='released', released_at=now() from submissions s where s.id=g.submission_id and s.assignment_id=$1 and g.status='approved' returning g.submission_id`, [id]);
      await audit(db, { orgId, actorId: u.id, action: 'grade.bulk_released', targetType: 'assignment', targetId: id, detail: { count: r.rowCount } });
      return { released: r.rowCount };
    });
  });

  app.post('/submissions/:id/comments', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ body: z.string().min(1).max(5000), quote: z.string().max(1000).optional() }).parse(req.body);
    return req.db(async (db) => {
      const s = await staffSubmission(db, id);
      return one(db, `insert into comments(submission_id, org_id, author_id, body, quote) values ($1,$2,$3,$4,$5) returning *`, [id, s.org_id, u.id, b.body, b.quote ?? null]);
    });
  });

  app.get('/orgs/:id/snippets', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['instructor', 'reviewer', 'org_admin']); return many(db, `select id, body from feedback_snippets where org_id=$1 and owner_id=$2 order by created_at desc`, [id, u.id]); });
  });
  app.post('/orgs/:id/snippets', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ body: z.string().min(1).max(2000) }).parse(req.body);
    return req.db(async (db) => { await requireOrgRole(db, id, u.id, ['instructor', 'reviewer', 'org_admin']); return one(db, `insert into feedback_snippets(org_id, owner_id, body) values ($1,$2,$3) returning id, body`, [id, u.id, b.body]); });
  });

  // ---------------------------------------------------------------- student responses & appeals
  app.post('/submissions/:id/responses', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ kind: z.enum(['response', 'appeal']), body: z.string().min(1).max(10000) }).parse(req.body);
    return req.db(async (db) => {
      const s = await one(db, `select * from submissions where id=$1 and student_id=$2`, [id, u.id]);
      if (!s) throw notFound('Submission');
      const g = await one(db, `select status from grades where submission_id=$1`, [id]);
      if (!g || !['released', 'revision_requested'].includes(g.status)) throw conflict('not_released', 'You can respond once feedback is released.');
      const r = await one(db, `insert into feedback_responses(org_id, submission_id, author_id, kind, body) values ($1,$2,$3,$4,$5) returning *`, [s.org_id, id, u.id, b.kind, b.body]);
      await audit(db, { orgId: s.org_id, actorId: u.id, action: `feedback.${b.kind}`, targetType: 'submission', targetId: id });
      return r;
    });
  });

  app.post('/responses/:id/decide', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ status: z.enum(['upheld', 'changed', 'closed']), decision: z.string().min(3).max(5000) }).parse(req.body);
    return req.db(async (db) => {
      const r = await one(db, `select fr.*, s.assignment_id from feedback_responses fr join submissions s on s.id=fr.submission_id where fr.id=$1`, [id]);
      if (!r) throw notFound('Response');
      await requireTeaches(db, r.assignment_id);
      if (r.status !== 'open') throw conflict('decided', 'This has already been decided.');
      // Evidence is preserved: the response row is updated with the decision, never deleted.
      const out = await one(db, `update feedback_responses set status=$2, decision=$3, decided_by=$4, decided_at=now() where id=$1 returning *`, [id, b.status, b.decision, u.id]);
      if (b.status === 'changed') await db.query(`update grades set status='draft', approved_by=null, approved_at=null where submission_id=$1`, [r.submission_id]);
      await audit(db, { orgId: r.org_id, actorId: u.id, action: 'appeal.decided', targetType: 'submission', targetId: r.submission_id, detail: { status: b.status } });
      return out;
    });
  });

  // ---------------------------------------------------------------- my courses & assignments
  app.get('/me/courses', async (req) => {
    const u = req.me();
    return req.db((db) => many(db,
      `select c.id, c.code, c.title, c.term, o.name as org_name, o.id as org_id, array_agg(m.role) as roles from course_members m join courses c on c.id=m.course_id join organizations o on o.id=c.org_id
       join memberships ms on ms.org_id=o.id and ms.user_id=m.user_id and ms.status='active' where m.user_id=$1 group by c.id, o.id order by o.name, c.code`, [u.id]));
  });

  app.get('/me/assignments', async (req) => {
    const u = req.me();
    const q = z.object({ org: uuid.optional() }).parse(req.query);
    return req.db((db) => many(db,
      `select a.id, a.title, a.due_at, a.assistance_preset, c.code as course_code, c.title as course_title, o.timezone, o.name as org_name,
         (select count(*)::int from submissions s where s.assignment_id=a.id and s.student_id=$1) as attempts, a.max_attempts,
         (select g.status from submissions s join grades g on g.submission_id=s.id where s.assignment_id=a.id and s.student_id=$1 order by s.attempt_no desc limit 1) as grade_status
       from assignments a join courses c on c.id=a.course_id join course_members m on m.course_id=c.id and m.user_id=$1 and m.role='student' join organizations o on o.id=a.org_id
       join memberships ms on ms.org_id=o.id and ms.user_id=$1 and ms.status='active'
       ${q.org ? 'where a.org_id=$2' : ''} order by a.due_at nulls last`, q.org ? [u.id, q.org] : [u.id]));
  });
}
