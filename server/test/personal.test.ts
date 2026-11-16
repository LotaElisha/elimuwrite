// Personal journey (AC1), outdated analysis (AC7), idempotent analysis + usage (AC10),
// version conflicts (AC11), exports (AC12), deletion (AC13), failed extraction (AC6).
import { describe, it, expect } from 'vitest';
import { Document, Packer, Paragraph } from 'docx';
import PDFDocument from 'pdfkit';
import { call, ok, newUser, saveHtml, latestJob, upload, owner, TEXT } from './helpers.js';
import { extract } from '../src/lib/importer.js';

const pdfBuffer = (draw: (d: PDFKit.PDFDocument) => void) => new Promise<Buffer>((res) => {
  const d = new PDFDocument(); const chunks: Buffer[] = [];
  d.on('data', (c) => chunks.push(c)); d.on('end', () => res(Buffer.concat(chunks)));
  draw(d); d.end();
});

describe('personal journey (AC1)', () => {
  it('register → write → writing check → accept suggestion → similarity against own sources → report → export', async () => {
    const u = await newUser('amina');
    const me = await ok('GET', '/me', u.token);
    expect(me.workspaces.some((w: any) => w.kind === 'personal')).toBe(true);
    await ok('POST', '/sources', u.token, { title: 'My reading', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'Essay', html: `<p>In this essay i argue that water matters. ${TEXT.rain}</p><p>${TEXT.original}</p>` });

    const wc = await ok('POST', `/documents/${doc.id}/writing-check`, u.token);
    expect(wc.status).toBe('completed');
    const sugg = wc.suggestions.find((s: any) => s.original === 'i');
    expect(sugg).toBeTruthy();
    expect(sugg.explanation ?? sugg.message).toBeTruthy();
    const dec = await ok('POST', `/suggestions/${sugg.id}/decision`, u.token, { decision: 'accept', current_version_id: wc.version_id });
    expect(dec.status).toBe('accepted');

    const est = await ok('POST', `/documents/${doc.id}/estimate`, u.token);
    expect(est.cost.similarity_checks).toBe(1);
    const run = await call('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    expect(run.status).toBe(202);
    const job = await latestJob(u.token, doc.id);
    expect(job.status).toBe('completed');
    const rep = await ok('GET', `/reports/${job.report_id}`, u.token);
    expect(rep.status).toBe('completed');
    expect(rep.result.original.percentage).toBeGreaterThan(30);
    expect(rep.sources[0].label).toBe('My reading');
    expect(rep.matches.length).toBeGreaterThan(0);
    expect(rep.matches[0].source_excerpt).toContain('Rainwater');
    expect(rep.limitations.length).toBeGreaterThan(0);

    const pdf = await call('GET', `/reports/${job.report_id}/pdf`, u.token);
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 5).toString()).toBe('%PDF-');
    const parsed = await extract(pdf.raw, 'r.pdf');
    expect(parsed.status).toBe('needs_review');
    if (parsed.status === 'needs_review') expect(parsed.text).toContain(rep.report_number);
  });

  it('exports DOCX, PDF and TXT that can be read back (AC12)', async () => {
    const u = await newUser('exp');
    const doc = await ok('POST', '/documents', u.token, { title: 'Export me', html: `<h1>Title</h1><p>${TEXT.original}</p>` });
    for (const format of ['docx', 'pdf', 'txt']) {
      const r = await call('GET', `/documents/${doc.id}/export?format=${format}`, u.token);
      expect(r.status, format).toBe(200);
      if (format === 'txt') { expect(r.raw.toString()).toContain('furrow irrigation'); continue; }
      const back = await extract(r.raw, `x.${format}`);
      expect(back.status, format).toBe('needs_review');
      if (back.status === 'needs_review') expect(back.text).toContain('furrow irrigation');
    }
  });
});

describe('imports (AC6)', () => {
  it('imports DOCX and text PDFs for review, and holds scanned/empty files instead of treating them as clean', async () => {
    const u = await newUser('imp');
    const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(TEXT.mobile)] }] }));
    const d = await upload(u.token, 'essay.docx', docx);
    expect(d.status).toBe(200);
    expect(d.body.status).toBe('needs_review');
    expect(d.body.preview).toContain('Mobile money');
    const conf = await ok('POST', `/imports/${d.body.id}/confirm`, u.token, { title: 'Imported' });
    expect(conf.document_id).toBeTruthy();

    const textPdf = await pdfBuffer((p) => p.text(TEXT.rain));
    const tp = await upload(u.token, 'a.pdf', textPdf);
    expect(tp.body.status).toBe('needs_review');

    const scanned = await pdfBuffer((p) => p.rect(50, 50, 200, 200).fill('#333'));
    const sp = await upload(u.token, 'scan.pdf', scanned);
    expect(sp.body.status).toBe('needs_ocr');
    expect(sp.body.ocr_configured).toBe(false);
    const c = await call('POST', `/imports/${sp.body.id}/confirm`, u.token, { title: 'x' });
    expect(c.status).toBe(409);

    const bad = await upload(u.token, 'x.exe', Buffer.from('MZ\x90\x00binary'));
    expect(bad.status).toBe(415);
  });
});

describe('versions, conflicts and outdated analysis (AC7, AC11)', () => {
  it('rejects a save based on a stale version and keeps both texts', async () => {
    const u = await newUser('ver');
    const doc = await ok('POST', '/documents', u.token, { title: 'V', html: '<p>First draft.</p>' });
    const d = await ok('GET', `/documents/${doc.id}`, u.token);
    // Freeze the current version (an analysis) so the next save must create a new version.
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'writing' });
    await latestJob(u.token, doc.id);
    const a = await ok('PUT', `/documents/${doc.id}/content`, u.token, { base_version_no: d.current_version_no, html: '<p>Edit from laptop.</p>' });
    expect(a.version_no).toBe(d.current_version_no + 1);
    const b = await call('PUT', `/documents/${doc.id}/content`, u.token, { base_version_no: d.current_version_no, html: '<p>Edit from phone.</p>' });
    expect(b.status).toBe(409);
    expect(b.body.error).toBe('version_conflict');
    const now = await ok('GET', `/documents/${doc.id}`, u.token);
    expect(now.content_text ?? now.html ?? JSON.stringify(now)).toContain('laptop');
  });

  it('marks a report outdated after edits, while the analysed version stays frozen', async () => {
    const u = await newUser('outd');
    await ok('POST', '/sources', u.token, { title: 'Src', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'O', html: `<p>${TEXT.rain}</p>` });
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    const job = await latestJob(u.token, doc.id);
    expect((await ok('GET', `/reports/${job.report_id}`, u.token)).outdated).toBe(false);
    await saveHtml(u.token, doc.id, `<p>${TEXT.original}</p>`);
    const rep = await ok('GET', `/reports/${job.report_id}`, u.token);
    expect(rep.outdated).toBe(true);
    expect(rep.text).toContain('Rainwater');
    const o = await owner();
    try {
      await expect(o.query(`update document_versions set content_text='tampered' where id=$1`, [job.version_id])).rejects.toThrow();
    } finally { await o.end(); }
  });

  it('restores an earlier version as a new version (history is never rewritten)', async () => {
    const u = await newUser('rest');
    const doc = await ok('POST', '/documents', u.token, { title: 'R', html: '<p>One.</p>' });
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'writing' });
    await latestJob(u.token, doc.id);
    await saveHtml(u.token, doc.id, '<p>Two.</p>');
    const r = await ok('POST', `/documents/${doc.id}/restore/1`, u.token);
    expect(r.version_no).toBe(3);
    const versions = await ok('GET', `/documents/${doc.id}/versions`, u.token);
    expect(versions.length).toBe(3);
  });
});

describe('idempotent analysis and usage (AC10)', () => {
  it('repeat requests for the same version return the same job and charge once', async () => {
    const u = await newUser('idem');
    await ok('POST', '/sources', u.token, { title: 'Src', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'I', html: `<p>${TEXT.rain}</p>` });
    const a = await call('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    const b = await call('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    expect(b.status).toBe(200);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.job.id).toBe(a.body.job.id);
    await latestJob(u.token, doc.id);
    const c = await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    expect(c.duplicate).toBe(true);
    const o = await owner();
    try {
      const r = await o.query(`select sum(quantity)::int as n from usage_records where owner_user_id=$1 and kind='similarity_check'`, [u.id]);
      expect(r.rows[0].n).toBe(1);
    } finally { await o.end(); }
  });

  it('enforces the plan allowance with a clear 402 before running', async () => {
    const u = await newUser('quota');
    await ok('POST', '/sources', u.token, { title: 'Src', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'Q', html: '<p>Start.</p>' });
    for (let i = 0; i < 3; i++) {
      await saveHtml(u.token, doc.id, `<p>Version ${i} ${TEXT.rain}</p>`);
      await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
      await latestJob(u.token, doc.id);
    }
    await saveHtml(u.token, doc.id, `<p>Version 4 ${TEXT.rain}</p>`);
    const r = await call('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    expect(r.status).toBe(402);
    expect(r.body.error).toBe('quota_exceeded');
  });
});

describe('empty corpus is not a clean report (AC6)', () => {
  it('a personal scan with no sources reports no_sources, never 0%', async () => {
    const u = await newUser('nosrc');
    const doc = await ok('POST', '/documents', u.token, { title: 'N', html: `<p>${TEXT.original}</p>` });
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    const job = await latestJob(u.token, doc.id);
    const rep = await ok('GET', `/reports/${job.report_id}`, u.token);
    expect(rep.status).toBe('no_sources');
    expect(rep.result.zero_note).toBeNull();
  });

  it('Swahili text gets an honest "unsupported" writing result', async () => {
    const u = await newUser('sw');
    const doc = await ok('POST', '/documents', u.token, { title: 'S', html: `<p>${TEXT.swahili}</p>` });
    const r = await ok('POST', `/documents/${doc.id}/writing-check`, u.token);
    expect(r.status).toBe('unsupported_language');
  });
});

describe('deletion (AC13)', () => {
  it('deletes a document with its versions and reports', async () => {
    const u = await newUser('del');
    await ok('POST', '/sources', u.token, { title: 'Src', text: TEXT.rain });
    const doc = await ok('POST', '/documents', u.token, { title: 'D', html: `<p>${TEXT.rain}</p>` });
    await ok('POST', `/documents/${doc.id}/analysis`, u.token, { kind: 'similarity' });
    const job = await latestJob(u.token, doc.id);
    const del = await ok('DELETE', `/documents/${doc.id}`, u.token);
    expect(del.deleted).toBe(true);
    expect((await call('GET', `/documents/${doc.id}`, u.token)).status).toBe(404);
    expect((await call('GET', `/reports/${job.report_id}`, u.token)).status).toBe(404);
    const o = await owner();
    try {
      expect((await o.query(`select 1 from document_versions where document_id=$1`, [doc.id])).rowCount).toBe(0);
    } finally { await o.end(); }
  });

  it('exports all of a user\'s data on request', async () => {
    const u = await newUser('gdpr');
    await ok('POST', '/documents', u.token, { title: 'Mine', html: '<p>Hello.</p>' });
    const r = await call('GET', '/me/export', u.token);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).toContain('Mine');
  });
});
