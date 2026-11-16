// Institutional journey (AC2), tenant isolation (AC3), policy enforcement (AC4),
// draft/template/class matching (AC5), frozen submissions (AC7), idempotent submissions (AC10),
// retention (AC13).
import { describe, it, expect, beforeAll } from 'vitest';
import pg from 'pg';
import { call, ok, newUser, institution, submit, saveHtml, runJobs, owner, TEXT } from './helpers.js';
import { runRetention } from '../src/jobs/retention.js';

describe('institutional journey (AC2)', () => {
  let I: Awaited<ReturnType<typeof institution>>;
  let sub1: any, sub2: any;
  beforeAll(async () => {
    I = await institution({ template: 'Instructions: write between three hundred and six hundred words on how communities adapt to water scarcity in your region.' });
    await ok('POST', `/orgs/${I.org.id}/repository`, I.admin.token, { title: 'Repository reading', text: TEXT.rain, inclusion_reason: 'Licensed course reading', rights_confirmed: true });
    sub1 = await submit(I.s1.token, I.asg.id, `<p>Instructions: write between three hundred and six hundred words on how communities adapt to water scarcity in your region.</p><p>${TEXT.rain}</p><p>${TEXT.original}</p>`);
    sub2 = await submit(I.s2.token, I.asg.id, `<p>${TEXT.mobile}</p><p>My own village saves money in groups and buys water tanks together every dry season.</p>`);
    await runJobs();
  });

  it('issues a receipt with server time, content hash and policy version', () => {
    expect(sub1.receipt.submission_id).toBeTruthy();
    expect(sub1.receipt.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sub1.receipt.policy_version).toBe(1);
    expect(sub1.receipt.timezone).toBe('Africa/Dar_es_Salaam');
    expect(sub1.receipt.is_late).toBe(false);
  });

  it('scans the submission against the repository and auto-excludes the assignment template', async () => {
    const inbox = await ok('GET', `/assignments/${I.asg.id}/submissions`, I.lecturer.token);
    const row = inbox.submissions.find((s: any) => s.id === sub1.receipt.submission_id);
    expect(row.scan_status).toBe('completed');
    const rep = await ok('GET', `/reports/${row.report_id}`, I.lecturer.token);
    expect(rep.audience).toBe('staff');
    const repo = rep.sources.find((s: any) => s.scope === 'institution_repository');
    expect(repo).toBeTruthy();
    expect(repo.excerpts_permitted).toBe(true);
    const tpl = rep.sources.find((s: any) => s.scope === 'assignment_template');
    expect(tpl.auto_excluded).toBe(true);
    // Template matches stay visible to the reviewer, marked excluded, and are never counted.
    const tplMatches = rep.matches.filter((m: any) => m.source_id === tpl.id);
    expect(tplMatches.length).toBeGreaterThan(0);
    for (const m of tplMatches) expect(m).toMatchObject({ excluded: true, auto_excluded_reason: 'assignment_template' });
    expect(tpl.matched_tokens).toBe(0);
    expect(rep.result.original.matched).toBe(repo.matched_tokens);
    expect(inbox.not_submitted.length).toBe(1);
  });

  it('students cannot see the report unless the instructor allows it', async () => {
    const inbox = await ok('GET', `/assignments/${I.asg.id}/submissions`, I.lecturer.token);
    const row = inbox.submissions.find((s: any) => s.id === sub1.receipt.submission_id);
    const r = await call('GET', `/reports/${row.report_id}`, I.s1.token);
    expect(r.status).toBe(403);
    // Another student never sees it.
    expect((await call('GET', `/reports/${row.report_id}`, I.s2.token)).status).toBe(404);
  });

  it('grades stay hidden until approved and released', async () => {
    const id = sub1.receipt.submission_id;
    await ok('PUT', `/submissions/${id}/grade`, I.lecturer.token, { rubric_scores: {}, feedback: 'Please cite the repository reading.' });
    let view = await ok('GET', `/submissions/${id}`, I.s1.token);
    expect(view.role).toBe('student');
    expect(view.feedback).toBeNull();
    const early = await call('POST', `/submissions/${id}/grade/release`, I.lecturer.token);
    expect(early.status).toBeGreaterThanOrEqual(400);
    await ok('POST', `/submissions/${id}/grade/approve`, I.lecturer.token);
    view = await ok('GET', `/submissions/${id}`, I.s1.token);
    expect(view.feedback).toBeNull();
    await ok('POST', `/submissions/${id}/grade/release`, I.lecturer.token);
    view = await ok('GET', `/submissions/${id}`, I.s1.token);
    expect(view.feedback.feedback).toContain('cite');
    // A student cannot read or grade another student's submission.
    expect((await call('GET', `/submissions/${id}`, I.s2.token)).status).toBe(404);
    expect((await call('PUT', `/submissions/${id}/grade`, I.s2.token, { rubric_scores: {}, feedback: 'x' })).status).toBe(404);
  });

  it('the submitted version is frozen: later edits create a new version', async () => {
    const doc = await ok('GET', `/documents/${sub1.document_id}`, I.s1.token);
    await saveHtml(I.s1.token, sub1.document_id, '<p>Completely rewritten after submission.</p>');
    const after = await ok('GET', `/documents/${sub1.document_id}`, I.s1.token);
    expect(after.current_version_no).toBe(doc.current_version_no + 1);
    const staff = await ok('GET', `/submissions/${sub1.receipt.submission_id}`, I.lecturer.token);
    expect(staff.version.content_text).toContain('Rainwater');
    const o = await owner();
    try {
      await expect(o.query(`update submissions set content_hash='x' where id=$1`, [sub1.receipt.submission_id])).rejects.toThrow();
    } finally { await o.end(); }
  });

  it('a retried submit with the same key does not create a second submission (AC10)', async () => {
    const { document_id } = await ok('POST', `/assignments/${I.asg.id}/start`, I.s3.token);
    await saveHtml(I.s3.token, document_id, `<p>${TEXT.original}</p>`);
    const a = await call('POST', `/assignments/${I.asg.id}/submissions`, I.s3.token, { document_id, idempotency_key: 'retry-key-123' });
    const b = await call('POST', `/assignments/${I.asg.id}/submissions`, I.s3.token, { document_id, idempotency_key: 'retry-key-123' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.receipt.submission_id).toBe(a.body.receipt.submission_id);
    const again = await call('POST', `/assignments/${I.asg.id}/submissions`, I.s3.token, { document_id, idempotency_key: 'different-key-456' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('already_submitted');
  });

  it('personal similarity runs are refused for assignment documents (scan runs on submit)', async () => {
    const r = await call('POST', `/documents/${sub2.document_id}/analysis`, I.s2.token, { kind: 'similarity' });
    expect(r.status).toBe(409);
  });
});

describe('class comparison and own drafts (AC5)', () => {
  it('matches between students are found and own earlier attempts are auto-excluded', async () => {
    const I = await institution();
    await submit(I.s1.token, I.asg.id, `<p>${TEXT.mobile}</p><p>${TEXT.original}</p>`);
    await runJobs();
    // Student 2 copies student 1's paragraph.
    const b = await submit(I.s2.token, I.asg.id, `<p>${TEXT.mobile}</p><p>Something else entirely about savings groups in my district this year.</p>`);
    await runJobs();
    // Student 1 resubmits a second attempt reusing their own first attempt.
    const { document_id } = await ok('POST', `/assignments/${I.asg.id}/start`, I.s1.token);
    await saveHtml(I.s1.token, document_id, `<p>${TEXT.mobile}</p><p>${TEXT.original}</p><p>An added conclusion about the role of local leaders.</p>`);
    const a2 = await ok('POST', `/assignments/${I.asg.id}/submissions`, I.s1.token, { document_id, idempotency_key: 'attempt-two-1' });
    expect(a2.receipt.attempt_no).toBe(2);
    await runJobs();

    const inbox = await ok('GET', `/assignments/${I.asg.id}/submissions`, I.lecturer.token);
    const r2 = await ok('GET', `/reports/${inbox.submissions.find((s: any) => s.id === b.receipt.submission_id).report_id}`, I.lecturer.token);
    const peer = r2.sources.find((s: any) => s.scope === 'submission');
    expect(peer).toBeTruthy();
    expect(peer.excluded).toBe(false);
    expect(r2.result.original.percentage).toBeGreaterThan(30);

    const r1 = await ok('GET', `/reports/${inbox.submissions.find((s: any) => s.id === a2.receipt.submission_id).report_id}`, I.lecturer.token);
    // Own first attempt is not counted against the student; the peer copy still is.
    const own = r1.matches.filter((m: any) => m.auto_excluded_reason === 'own_earlier_draft');
    const ownSourceIds = new Set(own.map((m: any) => m.source_id));
    for (const s of r1.sources.filter((s: any) => ownSourceIds.has(s.id))) expect(s.excluded).toBe(true);
  });

  it('reviewer exclusions are recorded with a reason, adjust the score, and can be reverted', async () => {
    const I = await institution();
    await ok('POST', `/orgs/${I.org.id}/repository`, I.admin.token, { title: 'Reading', text: TEXT.rain, inclusion_reason: 'Course reading', rights_confirmed: true });
    const s = await submit(I.s1.token, I.asg.id, `<p>${TEXT.rain}</p><p>${TEXT.original}</p>`);
    await runJobs();
    const inbox = await ok('GET', `/assignments/${I.asg.id}/submissions`, I.lecturer.token);
    const rid = inbox.submissions.find((x: any) => x.id === s.receipt.submission_id).report_id;
    const before = await ok('GET', `/reports/${rid}`, I.lecturer.token);
    const src = before.sources[0];
    const noReason = await call('POST', `/reports/${rid}/exclusions`, I.lecturer.token, { target_type: 'source', target_id: src.id, reason: '' });
    expect(noReason.status).toBe(400);
    await ok('POST', `/reports/${rid}/exclusions`, I.lecturer.token, { target_type: 'source', target_id: src.id, reason: 'Student quoted this reading with permission' });
    const after = await ok('GET', `/reports/${rid}`, I.lecturer.token);
    expect(after.result.adjusted.matched).toBe(0);
    expect(after.result.original.matched).toBe(before.result.original.matched);
    expect(after.exclusions[0].reason).toContain('permission');
    await ok('POST', `/reports/${rid}/exclusions/${after.exclusions[0].id}/revert`, I.lecturer.token);
    expect((await ok('GET', `/reports/${rid}`, I.lecturer.token)).result.adjusted.matched).toBe(before.result.adjusted.matched);
    // A student cannot exclude.
    expect((await call('POST', `/reports/${rid}/exclusions`, I.s1.token, { target_type: 'source', target_id: src.id, reason: 'not mine to exclude' })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('assistance policy is enforced by the server (AC4)', () => {
  it('proofreading-only blocks paraphrase, translation and tutoring on assignment documents', async () => {
    const I = await institution({ preset: 'proofreading_only' });
    const { document_id } = await ok('POST', `/assignments/${I.asg.id}/start`, I.s1.token);
    for (const [url, body] of [
      ['/tools/rewrite', { text: TEXT.rain, mode: 'concise', document_id }],
      ['/tools/translate', { text: TEXT.rain, target: 'sw', document_id }],
      ['/tools/tutor', { text: TEXT.rain, question: 'Is my thesis clear?', document_id }],
      ['/tools/summarize', { text: TEXT.rain, document_id }],
    ] as const) {
      const r = await call('POST', url, I.s1.token, body);
      expect(r.status, url).toBe(403);
      expect(r.body.error, url).toBe('policy_blocked');
    }
    await saveHtml(I.s1.token, document_id, `<p>In this essay i argue that ${TEXT.original}</p>`);
    expect((await call('POST', `/documents/${document_id}/writing-check`, I.s1.token)).status).toBe(200);
  });

  it('assistance-disabled also blocks grammar checks', async () => {
    const I = await institution({ preset: 'assistance_disabled' });
    const { document_id } = await ok('POST', `/assignments/${I.asg.id}/start`, I.s1.token);
    await saveHtml(I.s1.token, document_id, `<p>${TEXT.original}</p>`);
    const r = await call('POST', `/documents/${document_id}/writing-check`, I.s1.token);
    expect(r.status).toBe(403);
  });

  it('disclosure-required assignments reject submissions without a disclosure', async () => {
    const I = await institution({ preset: 'permitted_with_disclosure' });
    const { document_id } = await ok('POST', `/assignments/${I.asg.id}/start`, I.s1.token);
    await saveHtml(I.s1.token, document_id, `<p>${TEXT.original}</p>`);
    const r = await call('POST', `/assignments/${I.asg.id}/submissions`, I.s1.token, { document_id, idempotency_key: 'disc-key-001' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('disclosure_required');
    expect((await call('POST', `/assignments/${I.asg.id}/submissions`, I.s1.token, { document_id, idempotency_key: 'disc-key-002', disclosure: 'I used the grammar checker only.' })).status).toBe(201);
  });

  it('policy changes bump the version recorded on later submissions', async () => {
    const I = await institution();
    await ok('PATCH', `/assignments/${I.asg.id}`, I.lecturer.token, { assistance_preset: 'proofreading_only' });
    const s = await submit(I.s1.token, I.asg.id, `<p>${TEXT.original}</p>`);
    expect(s.receipt.policy_version).toBe(2);
  });
});

describe('tenant isolation (AC3)', () => {
  let A: Awaited<ReturnType<typeof institution>>, B: Awaited<ReturnType<typeof institution>>;
  let subA: any;
  beforeAll(async () => {
    A = await institution();
    B = await institution();
    await ok('POST', `/orgs/${A.org.id}/repository`, A.admin.token, { title: 'A reading', text: TEXT.rain, inclusion_reason: 'Course reading', rights_confirmed: true });
    subA = await submit(A.s1.token, A.asg.id, `<p>${TEXT.rain}</p>`);
    await runJobs();
  });

  it('another institution\'s admin and instructor get 404 on org, course, assignment, submission and report URLs', async () => {
    const inbox = await ok('GET', `/assignments/${A.asg.id}/submissions`, A.lecturer.token);
    const rid = inbox.submissions[0].report_id;
    for (const u of [B.admin, B.lecturer, B.s1]) {
      for (const url of [`/orgs/${A.org.id}`, `/orgs/${A.org.id}/members`, `/courses/${A.course.id}`, `/assignments/${A.asg.id}`, `/assignments/${A.asg.id}/submissions`,
        `/submissions/${subA.receipt.submission_id}`, `/reports/${rid}`, `/documents/${subA.document_id}`, `/orgs/${A.org.id}/audit`, `/orgs/${A.org.id}/repository`]) {
        const r = await call('GET', url, u.token);
        expect([403, 404], `${url}`).toContain(r.status);
      }
      expect((await call('PUT', `/submissions/${subA.receipt.submission_id}/grade`, u.token, { rubric_scores: {}, feedback: 'x' })).status).toBe(404);
      expect((await call('POST', `/courses/${A.course.id}/members`, u.token, { email: u.email, role: 'instructor' })).status).toBe(404);
    }
  });

  it('within an institution, a student cannot reach staff endpoints', async () => {
    for (const url of [`/orgs/${A.org.id}/members`, `/assignments/${A.asg.id}/submissions`, `/orgs/${A.org.id}/audit`, `/orgs/${A.org.id}/analytics`]) {
      expect([403, 404], url).toContain((await call('GET', url, A.s2.token)).status);
    }
  });

  it('row-level security hides other tenants even from raw SQL on the app role', async () => {
    // Give tenant A rows in every protected table first, so the check is not vacuous.
    const sid = subA.receipt.submission_id;
    await ok('PUT', `/submissions/${sid}/grade`, A.lecturer.token, { rubric_scores: {}, feedback: 'Tenant A feedback' });
    await ok('POST', `/submissions/${sid}/comments`, A.lecturer.token, { body: 'Tenant A comment' });
    const o = await owner();
    const counts: Record<string, number> = {};
    const q: Record<string, string> = {
      submissions: `select count(*)::int as n from submissions where org_id=$1`,
      documents: `select count(*)::int as n from documents where org_id=$1`,
      document_versions: `select count(*)::int as n from document_versions where org_id=$1`,
      reports: `select count(*)::int as n from reports where org_id=$1`,
      sources: `select count(*)::int as n from sources where org_id=$1`,
      fingerprints: `select count(*)::int as n from fingerprints f join sources s on s.id=f.source_id where s.org_id=$1`,
      similarity_matches: `select count(*)::int as n from similarity_matches m where m.report_id in (select id from reports where org_id=$1)`,
      grades: `select count(*)::int as n from grades where org_id=$1`,
      comments: `select count(*)::int as n from comments where org_id=$1`,
      document_events: `select count(*)::int as n from document_events e where e.document_id in (select id from documents where org_id=$1)`,
    };
    try { for (const [t, sql] of Object.entries(q)) counts[t] = (await o.query(sql, [A.org.id])).rows[0].n; } finally { await o.end(); }
    for (const [t, n] of Object.entries(counts)) expect(n, `tenant A has ${t}`).toBeGreaterThan(0);

    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      for (const viewer of [B.admin, B.lecturer, A.s2]) {
        await c.query('begin');
        await c.query(`select set_config('app.user_id', $1, true)`, [viewer.id]);
        for (const [t, sql] of Object.entries(q)) {
          // B's admin and instructor see nothing of tenant A; A.s2 (a classmate) sees nothing of A.s1's work.
          expect((await c.query(sql, [A.org.id])).rows[0].n, `${t} visible to another user`).toBe(0);
        }
        await c.query('rollback');
      }
      await c.query('begin');
      expect((await c.query(`select count(*)::int as n from documents`)).rows[0].n, 'no user context sees nothing').toBe(0);
      expect((await c.query(`select count(*)::int as n from grades`)).rows[0].n).toBe(0);
      await c.query('rollback');
    } finally { await c.end(); }
  });

  it('a similarity scan never matches another institution\'s submissions', async () => {
    const s = await submit(B.s1.token, B.asg.id, `<p>${TEXT.rain}</p>`);
    await runJobs();
    const inbox = await ok('GET', `/assignments/${B.asg.id}/submissions`, B.lecturer.token);
    const rep = await ok('GET', `/reports/${inbox.submissions.find((x: any) => x.id === s.receipt.submission_id).report_id}`, B.lecturer.token);
    expect(rep.status).toBe('no_sources');
    expect(rep.sources.length).toBe(0);
  });

  it('signing up with a school email domain grants nothing until the domain is verified, and then only student', async () => {
    const { setDnsResolver } = await import('../src/routes/orgs.js');
    const domain = `school${Date.now()}.example.test`;
    const d = await ok('POST', `/orgs/${B.org.id}/domains`, B.admin.token, { domain });
    const early = await ok('POST', '/auth/register', null, { email: `head@${domain}`, name: 'Early', password: 'Test-Pass-2026' });
    expect((await ok('GET', '/me', early.token)).workspaces.length).toBe(1);
    setDnsResolver(async () => [[d.txt_record ?? d.verification_token ?? d.token ?? '']]);
    const v = await call('POST', `/orgs/${B.org.id}/domains/${d.id}/verify`, B.admin.token);
    expect(v.status).toBe(200);
    await ok('PATCH', `/orgs/${B.org.id}/domains/${d.id}`, B.admin.token, { provisioning_enabled: true });
    const late = await ok('POST', '/auth/register', null, { email: `principal@${domain}`, name: 'Late', password: 'Test-Pass-2026' });
    const ws = (await ok('GET', '/me', late.token)).workspaces.find((w: any) => w.id === B.org.id);
    expect(ws.roles).toEqual(['student']);
  });
});

describe('retention (AC13)', () => {
  it('removes submissions older than the institution\'s retention period', async () => {
    const I = await institution();
    const s = await submit(I.s1.token, I.asg.id, `<p>${TEXT.original}</p>`);
    await runJobs();
    const o = await owner();
    try {
      await o.query(`update organizations set settings = settings || '{"retention_days": 30}' where id=$1`, [I.org.id]);
      await o.query(`alter table submissions disable trigger user`);
      await o.query(`update submissions set received_at = now() - interval '40 days' where id=$1`, [s.receipt.submission_id]);
      await o.query(`alter table submissions enable trigger user`);
      const out = await runRetention(process.env.OWNER_DATABASE_URL);
      expect(out.submissions_removed).toBeGreaterThanOrEqual(1);
      expect((await o.query(`select 1 from submissions where id=$1`, [s.receipt.submission_id])).rowCount).toBe(0);
      expect((await o.query(`select 1 from sources where submission_id=$1`, [s.receipt.submission_id])).rowCount).toBe(0);
      expect((await o.query(`select 1 from reports where submission_id=$1`, [s.receipt.submission_id])).rowCount).toBe(0);
    } finally { await o.end(); }
  });
});
