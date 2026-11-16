import pg from 'pg';
import { buildApp } from '../src/app.js';
import { drain } from '../src/jobs/queue.js';

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App | null = null;
let n = 0;

export async function getApp() { return (app ??= await buildApp()); }

export type Res = { status: number; body: any; headers: Record<string, any>; raw: Buffer };

export async function call(method: string, url: string, token: string | null, payload?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const a = await getApp();
  const r = await a.inject({ method: method as any, url: '/api' + url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, remoteAddress: `10.0.${(n >> 8) & 255}.${n++ & 255}` });
  let body: any = r.body;
  try { body = r.json(); } catch { /* binary or text */ }
  return { status: r.statusCode, body, headers: r.headers, raw: r.rawPayload };
}

/** Like call, but fails the test on any 4xx/5xx. */
export async function ok(method: string, url: string, token: string | null, payload?: unknown) {
  const r = await call(method, url, token, payload);
  if (r.status >= 400) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

let uniq = 0;
export async function newUser(label = 'user') {
  const email = `${label}.${Date.now().toString(36)}.${uniq++}@example.test`;
  const r = await ok('POST', '/auth/register', null, { email, name: `${label} (Test)`, password: 'Test-Pass-2026' });
  return { id: r.id as string, token: r.token as string, email };
}

export async function owner() {
  const c = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
  await c.connect();
  return c;
}

export async function runJobs() { await drain(); }

export async function saveHtml(token: string, docId: string, html: string) {
  const d = await ok('GET', `/documents/${docId}`, token);
  return ok('PUT', `/documents/${docId}/content`, token, { base_version_no: d.current_version_no, html });
}

/** A full institution: admin, instructor, two students, course and assignment. */
export async function institution(opts: { preset?: string; settings?: Record<string, unknown>; template?: string } = {}) {
  const admin = await newUser('orgadmin');
  const org = await ok('POST', '/orgs', admin.token, { name: `Test Institute ${uniq++}`, kind: 'university', timezone: 'Africa/Dar_es_Salaam', seats: 50 });
  const lecturer = await newUser('lecturer');
  const s1 = await newUser('student');
  const s2 = await newUser('student');
  const s3 = await newUser('student');
  for (const [u, role] of [[lecturer, 'instructor'], [s1, 'student'], [s2, 'student'], [s3, 'student']] as const) {
    const inv = await ok('POST', `/orgs/${org.id}/invitations`, admin.token, { email: u.email, roles: [role] });
    await ok('POST', `/invitations/${inv.token}/accept`, u.token);
  }
  const course = await ok('POST', `/orgs/${org.id}/courses`, admin.token, { code: `T${uniq++}`, title: 'Test course' });
  await ok('POST', `/courses/${course.id}/members`, admin.token, { email: lecturer.email, role: 'instructor' });
  for (const s of [s1, s2, s3]) await ok('POST', `/courses/${course.id}/members`, lecturer.token, { email: s.email, role: 'student' });
  const asg = await ok('POST', `/courses/${course.id}/assignments`, lecturer.token, {
    title: 'Test essay', instructions: 'Write about water.', due_at: new Date(Date.now() + 86400000).toISOString(),
    assistance_preset: opts.preset ?? 'guided_learning', max_attempts: 3, template_text: opts.template,
    similarity_settings: { exclude_quotes: true, exclude_bibliography: true, min_match_words: 8, compare_within_class: true, include_repository: true, include_own_drafts: false, show_report_to_students: false, ...(opts.settings ?? {}) },
  });
  return { admin, org, lecturer, s1, s2, s3, course, asg };
}

export async function submit(token: string, asgId: string, html: string, key = `submit-key-${uniq++}`) {
  const { document_id } = await ok('POST', `/assignments/${asgId}/start`, token);
  await saveHtml(token, document_id, html);
  const r = await ok('POST', `/assignments/${asgId}/submissions`, token, { document_id, idempotency_key: key });
  return { document_id, ...r };
}

export const TEXT = {
  rain: 'Rainwater harvesting has become an important adaptation strategy for smallholder farmers in semi-arid regions of central Tanzania. Households that collect roof runoff in storage tanks are able to extend the growing season by several weeks and reduce the time women and children spend fetching water.',
  mobile: 'Mobile money services have changed how rural households in East Africa save, borrow and send money. Agents in small towns allow customers to deposit cash and transfer funds to relatives in distant cities within minutes.',
  original: 'Communities in the Pare mountains have used traditional furrow irrigation for generations. Elders allocate water turns according to customary rules, and disputes are settled in village meetings that everyone may attend.',
  swahili: 'Wanafunzi wengi wanapenda kusoma vitabu vya hadithi kwa sababu vinawasaidia kujifunza lugha na kuelewa utamaduni wa jamii yao. Walimu wanashauri wazazi kuwasomea watoto wao kila siku nyumbani.',
};

export async function upload(token: string, filename: string, buf: Buffer) {
  const boundary = '----ewtest' + uniq++;
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return call('POST', '/imports', token, Buffer.concat([head, buf, tail]), { 'content-type': `multipart/form-data; boundary=${boundary}` });
}

/** Runs queued jobs and returns the latest job (with report_id) for a document. */
export async function latestJob(token: string, docId: string) {
  await drain();
  const jobs = await ok('GET', `/documents/${docId}/jobs`, token);
  return jobs[0];
}
