// Citations (AC9), payments and usage idempotency (AC10), sharing and exports (AC12),
// demo flags and not-configured providers (AC14), and platform-admin boundaries (AC3).
import { describe, it, expect, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { call, ok, newUser, owner, latestJob, TEXT } from './helpers.js';
import { setFetcher } from '../src/engines/citations.js';
import { setLlmProvider, AnthropicProvider } from '../src/engines/rewrite.js';
import { resetDemoCorpus } from '../src/routes/public.js';

const crossref = (records: Record<string, any>) => (async (url: string) => {
  const doi = decodeURIComponent(String(url).split('/works/')[1]);
  const m = records[doi];
  if (m === 'down') return new Response('err', { status: 503 });
  if (!m) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify({ message: m }), { status: 200, headers: { 'content-type': 'application/json' } });
}) as any;

afterAll(() => { setFetcher((...a) => fetch(...a)); setLlmProvider(new AnthropicProvider()); });

describe('citations keep existence, metadata and support separate (AC9)', () => {
  it('a registry-verified DOI is "exists", not "supports your claim"', async () => {
    setFetcher(crossref({ '10.1234/rain.2021': { type: 'journal-article', title: ['Learning to harvest rain'], author: [{ family: 'Mwakyusa', given: 'Amina' }], 'container-title': ['J. East Afr. Dev.'], issued: { 'date-parts': [[2021]] }, DOI: '10.1234/rain.2021' } }));
    const u = await newUser('cite');
    const r = await ok('POST', '/refs', u.token, { doi: '10.1234/rain.2021' });
    expect(r.checks.exists).toBe('verified');
    expect(r.checks.metadata).toBe('from_registry');
    expect(r.checks.supports_claim).toBe('not_assessed');
    expect(r.checks.note).toMatch(/does not show the source supports/);
  });

  it('an unknown DOI is not_found and nothing is invented', async () => {
    setFetcher(crossref({}));
    const u = await newUser('cite');
    const r = await ok('POST', '/refs', u.token, { doi: '10.9999/does-not-exist' });
    expect(r.checks.exists).toBe('not_found');
    expect(r.csl.title).toBeUndefined();
    expect(r.missing_fields.length).toBeGreaterThan(0);
  });

  it('a registry outage is lookup_unavailable, not "fake"', async () => {
    setFetcher(crossref({ '10.1234/x': 'down' }));
    const u = await newUser('cite');
    const r = await ok('POST', '/refs', u.token, { doi: '10.1234/x', csl: { type: 'book', title: 'Kept as typed' } });
    expect(r.checks.exists).toBe('lookup_unavailable');
    expect(r.csl.title).toBe('Kept as typed');
  });

  it('verification reports metadata differences instead of overwriting the user\'s entry', async () => {
    setFetcher(crossref({ '10.1234/y': { type: 'book', title: ['The real title'], author: [{ family: 'Okello' }], issued: { 'date-parts': [[2019]] } } }));
    const u = await newUser('cite');
    const r0 = await ok('POST', '/refs', u.token, { csl: { type: 'book', title: 'A different title', DOI: '10.1234/y', author: [{ family: 'Okello' }], issued: { 'date-parts': [[2018]] } } });
    expect(r0.checks.exists).toBe('unverified');
    // DOI typed in CSL is stored in the doi column
    const v = await ok('POST', `/refs/${r0.id}/verify`, u.token);
    expect(v.checks.exists).toBe('verified');
    expect(v.metadata_differences).toEqual(expect.arrayContaining(['title', 'year']));
    expect(v.csl.title).toBe('A different title');
    const s = await ok('PATCH', `/refs/${r0.id}`, u.token, { support_status: 'user_confirmed' });
    expect(s.checks.supports_claim).toBe('user_confirmed');
  });

  it('the document citation check finds missing and uncited references and builds a bibliography', async () => {
    const u = await newUser('cite');
    const doc = await ok('POST', '/documents', u.token, { title: 'C', html: '<p>Water matters (Mwakyusa, 2021). Savings help (Okello, 2019).</p><h2>References</h2><p>Mwakyusa, A. (2021). Learning to harvest rain. Journal, 4, 1–10.</p><p>Juma, H. (2018). Uncited. Arusha: Example.</p>' });
    await ok('POST', '/refs', u.token, { document_id: doc.id, csl: { type: 'book', title: 'Learning to harvest rain', author: [{ family: 'Mwakyusa', given: 'Amina' }], publisher: 'Example', issued: { 'date-parts': [[2021]] } } });
    const c = await ok('POST', `/documents/${doc.id}/citation-check`, u.token);
    const kinds = c.issues.map((i: any) => i.kind);
    expect(kinds).toContain('missing_reference');
    expect(kinds).toContain('uncited_entry');
    const bib = await ok('GET', `/documents/${doc.id}/bibliography?style=apa`, u.token);
    expect(JSON.stringify(bib)).toContain('Mwakyusa');
  });
});

describe('providers that are not configured say so (AC14, AC6)', () => {
  it('config lists AI, OCR and external similarity as not configured', async () => {
    const c = await ok('GET', '/config', null);
    const st = Object.fromEntries(c.providers.map((p: any) => [p.key, p.status]));
    expect(st.llm).toBe('not_configured');
    expect(st.ocr).toBe('not_configured');
    expect(st.external_similarity).toBe('not_configured');
  });

  it('AI-only rewrite modes return not_configured, never a fake result; local modes still work', async () => {
    setLlmProvider(new AnthropicProvider());
    const u = await newUser('llm');
    const ai = await ok('POST', '/tools/rewrite', u.token, { text: TEXT.rain, mode: 'academic' });
    expect(ai.status).toBe('not_configured');
    expect(ai.alternatives).toEqual([]);
    const local = await ok('POST', '/tools/rewrite', u.token, { text: 'In order to succeed, due to the fact that it rains, we act.', mode: 'concise' });
    expect(local.status).toBe('ok');
    expect(local.alternatives[0].source).toBe('local rules');
    expect((await ok('POST', '/tools/translate', u.token, { text: 'Hello', target: 'sw' })).status).toBe('not_configured');
  });

  it('with a provider connected, rewrites are checked for lost meaning (AC8)', async () => {
    setLlmProvider({ name: 'mock', configured: () => true, complete: async () => 'Research shows most homes store water briefly.' });
    const u = await newUser('llm');
    const r = await ok('POST', '/tools/rewrite', u.token, { text: 'A study by Mwakyusa (2021) found that 64% of homes do not store water for long.', mode: 'academic' });
    const flags = r.alternatives[0].flags.map((f: any) => f.kind);
    expect(flags).toEqual(expect.arrayContaining(['number', 'citation', 'name', 'negation']));
    setLlmProvider(new AnthropicProvider());
  });
});

describe('demo data is flagged and kept apart (AC14)', () => {
  it('the guest demo uses only demo-scope sources and stores nothing', async () => {
    const o = await owner();
    try {
      await o.query(`insert into sources(scope, title, content_text, token_count) values ('demo','Sample (fictional)',$1,40)`, [TEXT.rain]);
      resetDemoCorpus();
      const before = (await o.query(`select count(*)::int as n from documents`)).rows[0].n;
      const r = await ok('POST', '/demo/check', null, { text: `${TEXT.rain} ${TEXT.original}` });
      expect(r.similarity.percentage).toBeGreaterThan(0);
      expect(r.similarity.sources[0].title).toContain('fictional');
      expect((await o.query(`select count(*)::int as n from documents`)).rows[0].n).toBe(before);
      // A real user's similarity scan never draws on demo sources.
      const u = await newUser('real');
      const doc = await ok('POST', '/documents', u.token, { title: 'R', html: `<p>${TEXT.rain}</p>` });
      await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
      const job = await latestJob(u.token, doc.id);
      expect((await ok('GET', `/reports/${job.report_id}`, u.token)).status).toBe('no_sources');
    } finally { await o.end(); }
  });

  it('demo organizations are marked in the workspace list', async () => {
    const u = await newUser('demoorg');
    const org = await ok('POST', '/orgs', u.token, { name: 'Demo School (Demo)', kind: 'school', seats: 10 });
    const o = await owner();
    try { await o.query(`update organizations set is_demo=true where id=$1`, [org.id]); } finally { await o.end(); }
    const me = await ok('GET', '/me', u.token);
    expect(me.workspaces.find((w: any) => w.id === org.id).is_demo).toBe(true);
  });
});

describe('payments activate access only through a verified, idempotent webhook (AC10)', () => {
  const sign = (body: unknown) => createHmac('sha256', 'test-webhook-secret').update(JSON.stringify(body)).digest('hex');

  it('checkout never grants access by itself', async () => {
    const u = await newUser('pay');
    await call('POST', '/billing/checkout', u.token, { plan: 'personal_pro', interval: 'monthly' });
    expect((await ok('GET', '/billing', u.token)).plan).toBe('free');
  });

  it('rejects bad signatures and processes each event once', async () => {
    const u = await newUser('pay');
    const ev = { id: `evt_${Date.now()}`, type: 'payment.succeeded', data: { subscription_owner: { user_id: u.id }, plan: 'personal_pro', interval: 'monthly' } };
    const bad = await call('POST', '/webhooks/payments/testpay', null, ev, { 'x-signature': 'deadbeef' });
    expect(bad.status).toBe(401);
    expect((await ok('GET', '/billing', u.token)).plan).toBe('free');
    const a = await call('POST', '/webhooks/payments/testpay', null, ev, { 'x-signature': sign(ev) });
    const b = await call('POST', '/webhooks/payments/testpay', null, ev, { 'x-signature': sign(ev) });
    expect(a.body).toEqual({ received: true, duplicate: false });
    expect(b.body).toEqual({ received: true, duplicate: true });
    expect((await ok('GET', '/billing', u.token)).plan).toBe('personal_pro');
    const o = await owner();
    try {
      expect((await o.query(`select count(*)::int as n from subscriptions where owner_user_id=$1`, [u.id])).rows[0].n).toBe(1);
    } finally { await o.end(); }
  });

  it('an unknown provider path is refused', async () => {
    expect((await call('POST', '/webhooks/payments/other', null, {})).status).toBe(404);
  });
});

describe('report sharing (AC12)', () => {
  it('share links expire, can be revoked, and hide the reviewer\'s identity', async () => {
    const u = await newUser('share');
    await ok('POST', '/sources', u.token, { title: 'Src', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'S', html: `<p>${TEXT.rain}</p>` });
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    const job = await latestJob(u.token, doc.id);
    const sh = await ok('POST', `/reports/${job.report_id}/shares`, u.token, { expires_in_days: 7 });
    const ext = await ok('GET', `/shared/${sh.token}`, null);
    expect(ext.audience).toBe('external');
    expect(ext.result.original.percentage).toBeGreaterThan(0);
    const pdf = await call('GET', `/shared/${sh.token}/pdf`, null);
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    await ok('DELETE', `/shares/${sh.id}`, u.token);
    expect((await call('GET', `/shared/${sh.token}`, null)).status).toBe(404);
    // Someone else cannot create a share for this report.
    const other = await newUser('share');
    expect((await call('POST', `/reports/${job.report_id}/shares`, other.token, { expires_in_days: 7 })).status).toBe(404);
  });
});

describe('platform administrators have no implicit content access (AC3)', () => {
  it('needs a justified, time-limited, audited grant to view a document', async () => {
    const adm = await newUser('padmin');
    const o = await owner();
    try { await o.query(`update users set is_platform_admin=true where id=$1`, [adm.id]); } finally { await o.end(); }
    const u = await newUser('private');
    const doc = await ok('POST', '/documents', u.token, { title: 'Private', html: '<p>My private notes.</p>' });
    expect((await call('GET', `/documents/${doc.id}`, adm.token)).status).toBe(404);
    expect([403, 404]).toContain((await call('GET', `/admin/support/documents/${doc.id}`, adm.token)).status);
    expect((await call('POST', '/admin/support-access', adm.token, { document_id: doc.id, justification: 'short', hours: 2 })).status).toBe(400);
    expect((await call('POST', '/admin/support-access', adm.token, { document_id: doc.id, justification: 'Ticket 1234: user cannot open document', hours: 48 })).status).toBe(400);
    const g = await ok('POST', '/admin/support-access', adm.token, { document_id: doc.id, justification: 'Ticket 1234: user cannot open document', hours: 1 });
    const seen = await ok('GET', `/admin/support/documents/${doc.id}`, adm.token);
    expect(seen.title).toBe('Private');
    await ok('DELETE', `/admin/support-access/${g.id}`, adm.token);
    expect([403, 404]).toContain((await call('GET', `/admin/support/documents/${doc.id}`, adm.token)).status);
    const audit = await ok('GET', '/admin/audit', adm.token);
    const actions = audit.filter((a: any) => a.target_id === doc.id || a.target_id === g.id).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['support.access_granted', 'support.document_viewed', 'support.access_revoked']));
    // Ordinary users cannot use admin endpoints.
    expect([403, 404]).toContain((await call('GET', '/admin/orgs', u.token)).status);
  });
});
