/**
 * Clearly fictional demonstration data. Every organization is flagged is_demo and named
 * "(Demo)"; every email uses the reserved .test domain. Seeding goes through the real API
 * (app.inject) so demo records follow the same rules as real ones.
 */
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { drain } from '../src/jobs/queue.js';
import { tokenize } from '../src/engines/similarity.js';
import { pool } from '../src/db.js';

export const DEMO_PASSWORD = 'Demo-Pass-2026';

export const SAMPLE = {
  rainwater: `Rainwater harvesting has become an important adaptation strategy for smallholder farmers in semi-arid regions of central Tanzania. Households that collect roof runoff in storage tanks are able to extend the growing season by several weeks and reduce the time women and children spend fetching water. However, the initial cost of construction remains a major barrier, and many families rely on community savings groups to finance tanks. Training programmes that combine technical skills with financial planning have shown the most durable results.`,
  mobile: `Mobile money services have changed how rural households in East Africa save, borrow and send money. Agents in small towns allow customers to deposit cash and transfer funds to relatives in distant cities within minutes. Researchers have observed that access to mobile money helps families absorb economic shocks such as crop failure or illness, because they can receive support quickly from their social networks.`,
  literacy: `Early grade reading programmes in Swahili and English show that children learn to read faster when instruction begins in a language they already speak at home. Teachers who receive regular coaching and simple reading materials are more likely to use structured lessons consistently. Parental involvement, even when parents have limited schooling, is associated with higher reading fluency by the end of the second year.`,
};

const ESSAY = `<h1>Water and resilience in central Tanzania</h1>
<p>Climate variability is a growing challenge for rural communities. Rainwater harvesting has become an important adaptation strategy for smallholder farmers in semi-arid regions of central Tanzania. In this essay i argue that local financing models matter as much as technology.</p>
<p>According to Mwakyusa (2021), "households that collect roof runoff are able to extend the growing season" and this has effects on food security. Recent surveys suggest that 64% of households in Dodoma region store water for less than two weeks.</p>
<p>However, the initial cost of construction remains a major barrier, and many families rely on community savings groups to finance tanks. In order to address this, programmes should combine technical skills with financial planning (Okello & Njeri, 2019).</p>
<h2>References</h2>
<p>Mwakyusa, A. (2021). Learning to harvest rain. Journal of East African Development Studies, 4, 1–10.</p>
<p>Okello, P., & Njeri, W. (2019). Savings groups and household water. Nairobi: Example Press.</p>
<p>Juma, H. (2018). An uncited source about irrigation. Arusha: Example Books.</p>`;

async function main() {
  await migrate();
  const owner = new pg.Client({ connectionString: config.ownerDatabaseUrl });
  await owner.connect();
  const already = await owner.query(`select 1 from users where email='admin@demo.elimuwrite.test'`);
  if (already.rowCount) {
    console.log('Seed data already present. To reseed, drop and recreate the database.');
    await owner.end();
    await pool.end();
    return;
  }

  // Plans: prices intentionally null (not approved). Limits are editable by the platform admin.
  const plans = [
    ['free', 'Free', 'Individuals trying basic writing tools', { documents: 20, storage_mb: 50, words_per_month: 20000, similarity_checks_per_month: 3, seats: 1 }, { paraphrase_ai: false, reference_library: true, pdf_reports: true }],
    ['personal_pro', 'Personal Pro', 'Students, researchers, writers and professionals', { documents: null, storage_mb: 2000, words_per_month: 300000, similarity_checks_per_month: 50, seats: 1 }, { paraphrase_ai: true, reference_library: true, pdf_reports: true }],
    ['institution', 'Institution', 'Schools, colleges, universities and training organizations', { documents: null, storage_mb: null, words_per_month: null, similarity_checks_per_month: 5000, seats: 500 }, { paraphrase_ai: true, courses: true, repository: true, analytics: true }],
    ['enterprise', 'Enterprise', 'Larger organizations needing advanced administration and integrations', { documents: null, storage_mb: null, words_per_month: null, similarity_checks_per_month: null, seats: null }, { paraphrase_ai: true, courses: true, repository: true, analytics: true, sso: true, lti: true }],
  ];
  for (const [code, name, audience, limits, features] of plans) {
    await owner.query(`insert into plans(code, name, audience, limits, features) values ($1,$2,$3,$4,$5) on conflict (code) do nothing`, [code, name, audience, JSON.stringify(limits), JSON.stringify(features)]);
  }
  // Guest-demo sample sources (fictional, scope 'demo').
  for (const [k, text] of Object.entries(SAMPLE)) {
    await owner.query(`insert into sources(scope, title, content_text, token_count) values ('demo',$1,$2,$3)`, [`Sample source (fictional): ${k}`, text, tokenize(text).length]);
  }

  const app = await buildApp();
  const call = async (method: string, url: string, token: string | null, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url: '/api' + url, payload: payload as any, headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (r.statusCode >= 400) throw new Error(`${method} ${url} → ${r.statusCode} ${r.body}`);
    return r.json();
  };
  const register = async (email: string, name: string) => (await call('POST', '/auth/register', null, { email, name, password: DEMO_PASSWORD })).token as string;

  const admin = await register('admin@demo.elimuwrite.test', 'Platform Admin (Demo)');
  await owner.query(`update users set is_platform_admin=true, is_demo=true where email='admin@demo.elimuwrite.test'`);

  // ---------------- personal workspace
  const amina = await register('amina@demo.elimuwrite.test', 'Amina Mollel (Demo)');
  for (const [k, text] of Object.entries(SAMPLE).slice(0, 2)) await call('POST', '/sources', amina, { title: `Reading: ${k} (fictional)`, text });
  const doc = await call('POST', '/documents', amina, { title: 'Water and resilience essay (demo)', html: ESSAY });
  await call('POST', '/refs', amina, { document_id: doc.id, csl: { type: 'article-journal', title: 'Learning to harvest rain', author: [{ family: 'Mwakyusa', given: 'Amina' }], 'container-title': 'Journal of East African Development Studies', volume: '4', page: '1-10', issued: { 'date-parts': [[2021]] } } });
  await call('POST', '/refs', amina, { document_id: doc.id, csl: { type: 'book', title: 'Savings groups and household water', author: [{ family: 'Okello', given: 'Peter' }, { family: 'Njeri', given: 'Wanjiru' }], publisher: 'Example Press', issued: { 'date-parts': [[2019]] } } });
  await call('POST', `/documents/${doc.id}/analysis`, amina, { kind: 'similarity' });
  await call('POST', `/documents/${doc.id}/writing-check`, amina);

  // ---------------- institution
  const instAdmin = await register('registrar@demo.elimuwrite.test', 'Neema Kileo (Demo admin)');
  const org = await call('POST', '/orgs', instAdmin, { name: 'Kilimanjaro Institute of Learning (Demo)', kind: 'university', timezone: 'Africa/Dar_es_Salaam', departments: ['Education', 'Environmental Science'], seats: 100 });
  await owner.query(`update organizations set is_demo=true where id=$1`, [org.id]);
  const lecturer = await register('lecturer@demo.elimuwrite.test', 'Dr. Baraka Mushi (Demo)');
  const billing = await register('billing@demo.elimuwrite.test', 'Halima Said (Demo billing)');
  const students = [];
  for (const [i, n] of ['Zawadi Lyimo', 'Juma Mrisho', 'Rehema Kweka'].entries()) students.push(await register(`student${i + 1}@demo.elimuwrite.test`, `${n} (Demo)`));
  // Membership via invitation links and CSV import (exercises both flows).
  const inv = await call('POST', `/orgs/${org.id}/invitations`, instAdmin, { email: 'lecturer@demo.elimuwrite.test', roles: ['instructor'] });
  await call('POST', `/invitations/${inv.token}/accept`, lecturer);
  const binv = await call('POST', `/orgs/${org.id}/invitations`, instAdmin, { email: 'billing@demo.elimuwrite.test', roles: ['billing_admin'] });
  await call('POST', `/invitations/${binv.token}/accept`, billing);
  const csv = 'email,name,role\nstudent1@demo.elimuwrite.test,Zawadi,student\nstudent2@demo.elimuwrite.test,Juma,student\nstudent3@demo.elimuwrite.test,Rehema,student\nnew.student@demo.elimuwrite.test,New,student\nnot-an-email,Bad,student\nstudent1@demo.elimuwrite.test,Dup,student';
  const prev = await call('POST', `/orgs/${org.id}/members/import/preview`, instAdmin, { csv });
  await call('POST', `/orgs/${org.id}/members/import/commit`, instAdmin, { csv, preview_hash: prev.preview_hash });
  await call('POST', `/orgs/${org.id}/repository`, instAdmin, { title: 'Departmental reading: rainwater harvesting (fictional)', text: SAMPLE.rainwater, inclusion_reason: 'Core course reading licensed for internal comparison', rights_confirmed: true });
  await call('POST', `/orgs/${org.id}/terminology`, instAdmin, { term: 'pupil', preferred: 'learner', note: 'Institution style guide prefers "learner".' });

  const course = await call('POST', `/orgs/${org.id}/courses`, instAdmin, { code: 'EDU101', title: 'Academic Writing (Demo)', term: 'Semester 1 2026' });
  await call('POST', `/courses/${course.id}/members`, instAdmin, { email: 'lecturer@demo.elimuwrite.test', role: 'instructor' });
  for (let i = 1; i <= 3; i++) await call('POST', `/courses/${course.id}/members`, lecturer, { email: `student${i}@demo.elimuwrite.test`, role: 'student' });
  const rubric = await call('POST', `/orgs/${org.id}/rubrics`, lecturer, { title: 'Short essay rubric', criteria: [
    { id: 'argument', title: 'Argument and focus', description: 'Clear thesis, consistently developed', max_points: 10 },
    { id: 'evidence', title: 'Use of sources', description: 'Sources are relevant, integrated and cited', max_points: 10 },
    { id: 'writing', title: 'Clarity and mechanics', description: 'Readable, well-organized, accurate', max_points: 5 },
  ] });
  const due = new Date(Date.now() + 7 * 86400000).toISOString();
  const asg = await call('POST', `/courses/${course.id}/assignments`, lecturer, {
    title: 'Essay 1: Water and communities', instructions: 'Write 300–600 words on how communities adapt to water scarcity. Cite at least two sources in APA style.',
    due_at: due, rubric_id: rubric.id, assistance_preset: 'guided_learning', max_attempts: 3,
    template_text: 'Instructions: Write 300 to 600 words on how communities adapt to water scarcity. Cite at least two sources in APA style.',
    similarity_settings: { exclude_quotes: true, exclude_bibliography: true, min_match_words: 8, compare_within_class: true, include_repository: true, include_own_drafts: false, show_report_to_students: false },
  });
  // Student 1 submits work that reuses a repository passage; student 2 submits original work.
  const s1doc = (await call('POST', `/assignments/${asg.id}/start`, students[0])).document_id;
  const s1 = await call('GET', `/documents/${s1doc}`, students[0]);
  await call('PUT', `/documents/${s1doc}/content`, students[0], { base_version_no: s1.current_version_no, html: `<p>Water scarcity shapes daily life in many villages. ${SAMPLE.rainwater}</p><p>In my own village near Moshi, the women's group built two tanks with a loan from the savings group.</p>` });
  const sub1 = await call('POST', `/assignments/${asg.id}/submissions`, students[0], { document_id: s1doc, idempotency_key: 'seed-sub-1-attempt-1' });
  const s2doc = (await call('POST', `/assignments/${asg.id}/start`, students[1])).document_id;
  const s2 = await call('GET', `/documents/${s2doc}`, students[1]);
  await call('PUT', `/documents/${s2doc}/content`, students[1], { base_version_no: s2.current_version_no, html: `<p>Communities in the Pare mountains have used traditional furrow irrigation for generations. Elders allocate water turns according to customary rules, and disputes are settled in village meetings.</p><p>Modern pipes have changed these arrangements, but the social institutions remain important for fair sharing (Mwakyusa, 2021).</p>` });
  await call('POST', `/assignments/${asg.id}/submissions`, students[1], { document_id: s2doc, idempotency_key: 'seed-sub-2-attempt-1' });
  await drain();
  // Lecturer marks and releases student 1's feedback.
  await call('PUT', `/submissions/${sub1.receipt.submission_id}/grade`, lecturer, { rubric_scores: { argument: 6, evidence: 4, writing: 4 }, feedback: 'Good local example. The first paragraph reproduces the departmental reading almost word for word without quotation marks or a citation. Please revise and cite it.' });
  await call('POST', `/submissions/${sub1.receipt.submission_id}/grade/approve`, lecturer);
  await call('POST', `/submissions/${sub1.receipt.submission_id}/grade/release`, lecturer);

  await app.close();
  await owner.end();
  await pool.end();
  console.log(`Seeded demo data. All demo accounts use the password ${DEMO_PASSWORD}:
  admin@demo.elimuwrite.test (platform admin)
  amina@demo.elimuwrite.test (personal workspace)
  registrar@demo.elimuwrite.test (institution admin)
  lecturer@demo.elimuwrite.test (instructor)
  billing@demo.elimuwrite.test (billing admin)
  student1..3@demo.elimuwrite.test (students)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
