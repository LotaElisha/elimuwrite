import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, many, type Db } from '../db.js';
import { config } from '../config.js';
import { sanitize, htmlToText, wordCount, contentHash, sha256, escapeHtml } from '../lib/text.js';
import { audit, conflict, notFound, badRequest, HttpError, forbidden } from '../lib/misc.js';
import { ownDocument, enforceCapability } from '../lib/authz.js';
import { store } from '../lib/storage.js';
import { extract } from '../lib/importer.js';
import { toDocx } from '../lib/exporter.js';
import { documentPdf } from '../reports/pdf.js';
import { formatBibliography } from '../engines/citations.js';
import { checkText, readability, detectLanguage } from '../engines/grammar.js';
import { localRewrite, LOCAL_MODES, MODES, checkPreservation, extractiveSummary, providerTask, type Mode } from '../engines/rewrite.js';
import { indexSource } from '../jobs/queue.js';
import { tokenize } from '../engines/similarity.js';
import { recordUsage } from '../lib/entitlements.js';

const uuid = z.string().uuid();
const COALESCE_SECONDS = 120;

/**
 * Saves new content as a version. Rapid autosaves by the same user coalesce into the latest
 * unfrozen version (so history stays readable); a frozen version (submitted or analysed)
 * is never modified, a new version is created instead.
 */
export async function saveVersion(db: Db, doc: any, userId: string, rawHtml: string, origin: string, baseVersionNo: number | null) {
  if (baseVersionNo !== null && baseVersionNo !== doc.current_version_no) {
    const cur = await one(db, `select version_no, content_html, updated_at from document_versions where id=$1`, [doc.current_version_id]);
    throw conflict('version_conflict', 'This document was changed elsewhere. Your text has been kept so you can compare and merge.', { current: cur });
  }
  const html = sanitize(rawHtml);
  const text = htmlToText(html);
  const hash = contentHash(html, text);
  const cur = doc.current_version_id ? await one(db, `select * from document_versions where id=$1`, [doc.current_version_id]) : null;
  if (cur && cur.content_hash === hash) return { version: cur, changed: false };
  const coalesce = cur && !cur.frozen && origin === 'edit' && cur.origin === 'edit' && cur.created_by === userId && Date.now() - new Date(cur.created_at).getTime() < COALESCE_SECONDS * 1000;
  let v;
  if (coalesce) {
    v = await one(db, `update document_versions set content_html=$2, content_text=$3, content_hash=$4, word_count=$5, updated_at=now() where id=$1 returning *`, [cur.id, html, text, hash, wordCount(text)]);
    // the coalesced version's content changed: any suggestions bound to it are now stale
    await db.query(`update suggestions set status='outdated' where version_id=$1 and status='open'`, [cur.id]);
  } else {
    v = await one(db,
      `insert into document_versions(document_id, owner_user_id, org_id, version_no, content_html, content_text, content_hash, word_count, origin, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [doc.id, doc.owner_user_id, doc.org_id, doc.current_version_no + 1, html, text, hash, wordCount(text), origin, userId]);
    await db.query(`update documents set current_version_id=$2, current_version_no=$3, updated_at=now() where id=$1`, [doc.id, v.id, v.version_no]);
    await db.query(`update suggestions set status='outdated' where document_id=$1 and version_id<>$2 and status='open'`, [doc.id, v.id]);
  }
  return { version: v, changed: true };
}

export async function createDocument(db: Db, p: { ownerId: string; orgId: string | null; assignmentId?: string | null; title: string; html: string; origin: string; folderId?: string | null; variant?: string }) {
  const d = await one(db,
    `insert into documents(owner_user_id, org_id, assignment_id, folder_id, title, english_variant) values ($1,$2,$3,$4,$5,$6) returning *`,
    [p.ownerId, p.orgId, p.assignmentId ?? null, p.folderId ?? null, p.title, p.variant ?? 'en-US']);
  const { version } = await saveVersion(db, d, p.ownerId, p.html, p.origin, null);
  return { ...d, current_version_id: version.id, current_version_no: version.version_no };
}

async function analysisStatus(db: Db, docId: string, currentVersionId: string) {
  const reps = await many(db, `select distinct on (kind) id, kind, status, version_id, created_at, (result->>'percentage') as percentage from reports where document_id=$1 order by kind, created_at desc`, [docId]);
  return reps.map((r) => ({ ...r, outdated: r.version_id !== currentVersionId }));
}

export async function documentRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- folders & documents
  app.get('/folders', async (req) => {
    const u = req.me();
    return req.db((db) => many(db, `select * from folders where owner_user_id=$1 order by name`, [u.id]));
  });
  app.post('/folders', async (req) => {
    const u = req.me();
    const b = z.object({ name: z.string().min(1).max(120) }).parse(req.body);
    return req.db((db) => one(db, `insert into folders(owner_user_id, name) values ($1,$2) returning *`, [u.id, b.name]));
  });

  // Lists the PERSONAL workspace by default; assignment work is listed under its assignment.
  app.get('/documents', async (req) => {
    const u = req.me();
    const q = z.object({ folder: uuid.optional(), workspace: z.string().optional() }).parse(req.query);
    const org = q.workspace && q.workspace !== 'personal' ? uuid.parse(q.workspace) : null;
    const params: unknown[] = [u.id];
    let where = 'd.owner_user_id=$1 and d.deleted_at is null';
    if (org) { params.push(org); where += ` and d.org_id=$${params.length}`; } else where += ' and d.org_id is null';
    if (q.folder) { params.push(q.folder); where += ` and d.folder_id=$${params.length}`; }
    return req.db((db) => many(db,
      `select d.id, d.title, d.folder_id, d.org_id, d.assignment_id, d.current_version_no, d.updated_at, v.word_count, a.title as assignment_title
       from documents d left join document_versions v on v.id=d.current_version_id left join assignments a on a.id=d.assignment_id
       where ${where} order by d.updated_at desc`, params));
  });

  app.post('/documents', async (req) => {
    const u = req.me();
    const b = z.object({ title: z.string().min(1).max(200), html: z.string().max(2_000_000).default('<p></p>'), folder_id: uuid.nullable().optional() }).parse(req.body);
    return req.db((db) => createDocument(db, { ownerId: u.id, orgId: null, title: b.title, html: b.html, origin: 'edit', folderId: b.folder_id, variant: u.english_variant }));
  });

  app.get('/documents/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      const v = await one(db, `select id, version_no, content_html, content_text, content_hash, word_count, frozen, updated_at from document_versions where id=$1`, [d.current_version_id]);
      const policy = d.assignment_id ? await one(db, `select a.id, a.title, a.assistance_preset, a.assistance_policy, a.policy_version, a.due_at, a.max_attempts, c.title as course_title, o.timezone from assignments a join courses c on c.id=a.course_id join organizations o on o.id=a.org_id where a.id=$1`, [d.assignment_id]) : null;
      const org = d.org_id ? await one(db, `select settings->>'offline_drafts_allowed' as offline from organizations where id=$1`, [d.org_id]) : null;
      return {
        ...d,
        version: v,
        stats: { words: v.word_count, characters: v.content_text.length, readability: readability(v.content_text), language_detected: detectLanguage(v.content_text) },
        analyses: await analysisStatus(db, id, d.current_version_id),
        assignment: policy,
        offline_allowed: d.org_id ? org?.offline === 'true' : true,
      };
    });
  });

  app.patch('/documents/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ title: z.string().min(1).max(200).optional(), folder_id: uuid.nullable().optional(), english_variant: z.enum(['en-US', 'en-GB']).optional(), language: z.enum(['en', 'sw']).optional() }).parse(req.body);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      for (const [k, v] of Object.entries(b)) if (v !== undefined) await db.query(`update documents set ${k}=$2, updated_at=now() where id=$1`, [id, v]);
      return { ok: true };
    });
  });

  // Autosave with optimistic concurrency: base_version_no must match, otherwise 409 with the server copy.
  app.put('/documents/:id/content', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ html: z.string().max(2_000_000), base_version_no: z.number().int(), origin: z.enum(['edit', 'suggestion', 'rewrite', 'restore']).default('edit'), event: z.object({ kind: z.enum(['paste', 'suggestion_accepted', 'rewrite_accepted', 'summary_inserted']), detail: z.record(z.string(), z.any()).optional() }).optional() }).parse(req.body);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      await db.query(`select 1 from documents where id=$1 for update`, [id]);
      const fresh = await one(db, `select * from documents where id=$1`, [id]);
      const { version, changed } = await saveVersion(db, fresh, u.id, b.html, b.origin, b.base_version_no);
      if (b.event) {
        // Paste events record size and position only, never pasted content. Pasted text has unknown origin.
        const detail = b.event.kind === 'paste' ? { chars: Number(b.event.detail?.chars ?? 0) } : b.event.detail ?? {};
        await db.query(`insert into document_events(document_id, version_id, user_id, kind, detail) values ($1,$2,$3,$4,$5)`, [d.id, version.id, u.id, b.event.kind, JSON.stringify(detail)]);
      }
      return { version_id: version.id, version_no: version.version_no, word_count: version.word_count, changed, saved_at: new Date().toISOString() };
    });
  });

  app.get('/documents/:id/versions', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      return many(db, `select v.id, v.version_no, v.word_count, v.origin, v.frozen, v.created_at, v.updated_at, exists(select 1 from submissions s where s.version_id=v.id) as submitted from document_versions v where document_id=$1 order by version_no desc`, [id]);
    });
  });

  app.get('/documents/:id/versions/:no', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const no = Number((req.params as any).no);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      const v = await one(db, `select * from document_versions where document_id=$1 and version_no=$2`, [id, no]);
      if (!v) throw notFound('Version');
      return v;
    });
  });

  app.post('/documents/:id/restore/:no', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const no = Number((req.params as any).no);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      const v = await one(db, `select * from document_versions where document_id=$1 and version_no=$2`, [id, no]);
      if (!v) throw notFound('Version');
      const r = await saveVersion(db, d, u.id, v.content_html, 'restore', null);
      await db.query(`insert into document_events(document_id, version_id, user_id, kind, detail) values ($1,$2,$3,'restore',$4)`, [id, r.version.id, u.id, JSON.stringify({ from_version: no })]);
      return { version_no: r.version.version_no };
    });
  });

  app.get('/documents/:id/compare', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const q = z.object({ a: z.coerce.number().int(), b: z.coerce.number().int() }).parse(req.query);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      const [va, vb] = await Promise.all([q.a, q.b].map((n) => one(db, `select version_no, content_text, created_at from document_versions where document_id=$1 and version_no=$2`, [id, n])));
      if (!va || !vb) throw notFound('Version');
      return { a: va, b: vb, diff: wordDiff(va.content_text, vb.content_text) };
    });
  });

  app.get('/documents/:id/events', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      return many(db, `select e.kind, e.detail, e.created_at, v.version_no from document_events e left join document_versions v on v.id=e.version_id where e.document_id=$1 order by e.created_at desc limit 500`, [id]);
    });
  });

  app.get('/documents/:id/comments', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      return many(db, `select c.id, c.body, c.quote, c.created_at, u.name as author from comments c join users u on u.id=c.author_id where c.document_id=$1 order by c.created_at`, [id]);
    });
  });
  app.post('/documents/:id/comments', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ body: z.string().min(1).max(5000), quote: z.string().max(1000).optional() }).parse(req.body);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      return one(db, `insert into comments(document_id, org_id, author_id, body, quote) values ($1,$2,$3,$4,$5) returning *`, [id, d.org_id, u.id, b.body, b.quote ?? null]);
    });
  });

  // Deletion: removes versions, extracted text, fingerprints, reports, files. Submitted versions
  // are institutional records and are retained under the institution's retention policy.
  app.delete('/documents/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      const subs = await one(db, `select count(*)::int as n from submissions where document_id=$1`, [id]);
      if (subs.n > 0) throw conflict('retained_by_institution', 'This document has submitted versions. Those are kept by your institution under its retention policy; ask your institution administrator to remove them.');
      const files = await many(db, `select f.id, f.storage_key from files f join imports i on i.file_id=f.id where i.document_id=$1`, [id]);
      await db.query(`delete from documents where id=$1`, [id]);
      for (const f of files) {
        await db.query(`delete from files where id=$1`, [f.id]);
        store.remove(f.storage_key);
      }
      await audit(db, { actorId: u.id, action: 'document.deleted', targetType: 'document', targetId: id });
      return { deleted: true, note: 'Deleted from the live database and storage. Encrypted backups expire after the documented backup retention window.' };
    });
  });

  app.get('/documents/:id/export', async (req, reply) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const q = z.object({ format: z.enum(['docx', 'pdf', 'txt', 'html']), style: z.string().default('apa') }).parse(req.query);
    const { d, v, bib } = await req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      const v = await one(db, `select * from document_versions where id=$1`, [d.current_version_id]);
      const refs = await many(db, `select r.id, r.csl from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1`, [id]);
      await db.query(`insert into document_events(document_id, version_id, user_id, kind, detail) values ($1,$2,$3,'export',$4)`, [id, v.id, u.id, JSON.stringify({ format: q.format })]);
      return { d, v, bib: formatBibliography(refs.map((r) => ({ ...r.csl, id: r.id })), q.style) };
    });
    const name = d.title.replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'document';
    if (q.format === 'txt') {
      reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="${name}.txt"`);
      return `${d.title}\n\n${v.content_text}${bib ? `\n\nReferences\n\n${bib}` : ''}`;
    }
    if (q.format === 'docx') {
      reply.header('content-type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').header('content-disposition', `attachment; filename="${name}.docx"`);
      return toDocx(d.title, v.content_html, bib);
    }
    if (q.format === 'html') return { html: v.content_html };
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${name}.pdf"`);
    return documentPdf(d.title, v.content_text, bib);
  });

  // ---------------------------------------------------------------- imports
  app.post('/imports', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = req.me();
    const part = await req.file();
    if (!part) throw badRequest('No file uploaded.');
    const buf = await part.toBuffer();
    if (buf.length === 0) throw badRequest('The file is empty.');
    const ex = await extract(buf, part.filename);
    if (ex.status === 'failed' && ex.type === 'unsupported') throw new HttpError(415, 'unsupported_type', ex.error);
    return req.db(async (db) => {
      // Original is preserved unchanged. Malware scanning runs here when configured.
      const key = store.put(buf, `u/${u.id}`);
      const f = await one(db, `insert into files(owner_user_id, storage_key, filename, mime, size_bytes, sha256) values ($1,$2,$3,$4,$5,$6) returning id`,
        [u.id, key, part.filename.slice(0, 200), part.mimetype, buf.length, sha256(buf)]);
      const imp = await one(db,
        `insert into imports(owner_user_id, file_id, status, detected_type, extracted_html, extracted_text, warnings, error) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, status, detected_type, warnings, error`,
        [u.id, f.id, ex.status, ex.type, ex.status === 'needs_review' ? ex.html : null, ex.status === 'needs_review' ? ex.text : null,
          JSON.stringify(ex.status === 'failed' ? [] : ex.warnings), ex.status === 'failed' ? ex.error : ex.status === 'needs_ocr' ? ex.message : null]);
      return { ...imp, ocr_configured: !!config.providers.ocr.endpoint, preview: ex.status === 'needs_review' ? ex.text.slice(0, 20000) : null, filename: part.filename };
    });
  });

  app.get('/imports/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const i = await one(db, `select i.id, i.status, i.detected_type, i.warnings, i.error, i.extracted_text as preview, i.document_id, f.filename from imports i join files f on f.id=i.file_id where i.id=$1 and i.owner_user_id=$2`, [id, u.id]);
      if (!i) throw notFound('Import');
      return i;
    });
  });

  // User has reviewed extracted text; create the editable document (or a personal source).
  app.post('/imports/:id/confirm', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ title: z.string().min(1).max(200), as: z.enum(['document', 'source']).default('document'), document_id: uuid.optional() }).parse(req.body);
    return req.db(async (db) => {
      const i = await one(db, `select i.*, f.filename from imports i join files f on f.id=i.file_id where i.id=$1 and i.owner_user_id=$2 for update`, [id, u.id]);
      if (!i) throw notFound('Import');
      if (i.status !== 'needs_review') throw conflict('not_ready', i.status === 'needs_ocr' ? 'This file needs OCR before it can be used.' : 'This import cannot be confirmed.');
      if (b.as === 'source') {
        const s = await createPersonalSource(db, u.id, b.title, i.extracted_text, null);
        await db.query(`update imports set status='completed', updated_at=now() where id=$1`, [id]);
        return { source_id: s.id };
      }
      let doc;
      if (b.document_id) {
        // import into an existing (e.g. assignment) document as a new version
        doc = await ownDocument(db, b.document_id, u.id);
        await saveVersion(db, doc, u.id, i.extracted_html, 'import', null);
      } else doc = await createDocument(db, { ownerId: u.id, orgId: null, title: b.title, html: i.extracted_html, origin: 'import', variant: u.english_variant });
      await db.query(`update imports set status='completed', document_id=$2, updated_at=now() where id=$1`, [id, doc.id]);
      const cur = await one(db, `select current_version_id from documents where id=$1`, [doc.id]);
      await db.query(`insert into document_events(document_id, version_id, user_id, kind, detail) values ($1,$2,$3,'import',$4)`, [doc.id, cur.current_version_id, u.id, JSON.stringify({ filename: i.filename, type: i.detected_type })]);
      return { document_id: doc.id };
    });
  });

  // ---------------------------------------------------------------- personal reference documents (similarity corpus)
  app.get('/sources', async (req) => {
    const u = req.me();
    return req.db((db) => many(db, `select id, title, url, author, token_count, created_at from sources where scope='personal' and owner_user_id=$1 order by created_at desc`, [u.id]));
  });
  app.post('/sources', async (req) => {
    const u = req.me();
    const b = z.object({ title: z.string().min(1).max(300), text: z.string().min(1).max(2_000_000), url: z.string().url().optional(), author: z.string().max(300).optional() }).parse(req.body);
    return req.db((db) => createPersonalSource(db, u.id, b.title, b.text, b.url ?? null, b.author));
  });
  app.delete('/sources/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const r = await db.query(`delete from sources where id=$1 and scope='personal' and owner_user_id=$2`, [id, u.id]);
      if (!r.rowCount) throw notFound('Source');
      return { deleted: true };
    });
  });

  // ---------------------------------------------------------------- writing assistance
  app.post('/documents/:id/writing-check', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      await enforceCapability(db, d, 'grammar');
      const v = await one(db, `select * from document_versions where id=$1`, [d.current_version_id]);
      const lang = d.language === 'sw' ? 'sw' : detectLanguage(v.content_text);
      if (lang === 'sw') return { status: 'unsupported_language', version_id: v.id, message: 'Swahili writing analysis is not available yet. It will be released as beta after evaluation by Swahili-language reviewers.', suggestions: [] };
      const dict = (await many(db, `select word from personal_dictionary where user_id=$1`, [u.id])).map((r) => r.word);
      const terms = d.org_id ? await many(db, `select term, preferred, note from org_terminology where org_id=$1`, [d.org_id]) : [];
      const ignored = await many(db, `select original, rule_id from suggestions where document_id=$1 and status='ignored'`, [id]);
      const sugg = checkText(v.content_text, { variant: d.english_variant, dictionary: dict, terminology: terms })
        .filter((s) => !ignored.some((i) => i.original === s.original && i.rule_id === s.ruleId));
      await db.query(`delete from suggestions where version_id=$1 and status='open'`, [v.id]);
      const rows = [];
      for (const s of sugg) {
        rows.push(await one(db,
          `insert into suggestions(document_id, version_id, category, rule_id, start_offset, end_offset, original, replacement, explanation) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [id, v.id, s.category, s.ruleId, s.start, s.end, s.original, s.replacement, s.explanation]));
        await db.query(`insert into learning_events(user_id, rule_id, category, outcome) values ($1,$2,$3,'flagged')`, [u.id, s.ruleId, s.category]);
      }
      await recordUsage(db, { userId: u.id, orgId: d.org_id, kind: 'writing_check', quantity: v.word_count, key: `writing:${v.id}` });
      return { status: 'completed', engine: 'Rule-based checks (English)', version_id: v.id, version_no: v.version_no, suggestions: rows, readability: readability(v.content_text) };
    });
  });

  /**
   * Accept / reject / ignore / undo. Acceptance is bound to the version the suggestion was made
   * for; if the document changed since, the suggestion is stale and is refused so it can't alter
   * the wrong passage. The client applies the change and saves with origin "suggestion".
   */
  app.post('/suggestions/:id/decision', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ decision: z.enum(['accept', 'reject', 'ignore', 'undo']), current_version_id: uuid }).parse(req.body);
    return req.db(async (db) => {
      const s = await one(db, `select s.*, d.owner_user_id, d.current_version_id from suggestions s join documents d on d.id=s.document_id where s.id=$1`, [id]);
      if (!s || s.owner_user_id !== u.id) throw notFound('Suggestion');
      if (b.decision === 'undo') {
        await db.query(`update suggestions set status='open', decided_at=null where id=$1`, [id]);
        return { status: 'open' };
      }
      if (b.decision === 'accept') {
        const v = await one(db, `select content_text from document_versions where id=$1`, [s.version_id]);
        if (s.version_id !== b.current_version_id || s.current_version_id !== s.version_id || v.content_text.slice(s.start_offset, s.end_offset) !== s.original) {
          await db.query(`update suggestions set status='outdated' where id=$1`, [id]);
          throw conflict('stale_suggestion', 'The document has changed since this suggestion was made. Run the check again.');
        }
      }
      const status = { accept: 'accepted', reject: 'rejected', ignore: 'ignored' }[b.decision];
      await db.query(`update suggestions set status=$2, decided_at=now() where id=$1`, [id, status]);
      await db.query(`insert into learning_events(user_id, rule_id, category, outcome) values ($1,$2,$3,$4)`, [u.id, s.rule_id, s.category, status]);
      return { status, start: s.start_offset, end: s.end_offset, original: s.original, replacement: s.replacement };
    });
  });

  app.get('/me/dictionary', async (req) => {
    const u = req.me();
    return req.db(async (db) => (await many(db, `select word from personal_dictionary where user_id=$1 order by word`, [u.id])).map((r) => r.word));
  });
  app.post('/me/dictionary', async (req) => {
    const u = req.me();
    const b = z.object({ word: z.string().min(1).max(80) }).parse(req.body);
    return req.db(async (db) => { await db.query(`insert into personal_dictionary(user_id, word) values ($1,$2) on conflict do nothing`, [u.id, b.word]); return { ok: true }; });
  });
  app.delete('/me/dictionary/:word', async (req) => {
    const u = req.me();
    return req.db(async (db) => { await db.query(`delete from personal_dictionary where user_id=$1 and word=$2`, [u.id, (req.params as any).word]); return { ok: true }; });
  });

  app.get('/me/progress', async (req) => {
    const u = req.me();
    return req.db(async (db) => ({
      recurring: await many(db, `select category, rule_id, count(*)::int as times from learning_events where user_id=$1 and outcome='flagged' and created_at > now() - interval '90 days' group by 1,2 order by 3 desc limit 8`, [u.id]),
      decisions: await many(db, `select outcome, count(*)::int as n from learning_events where user_id=$1 and outcome<>'flagged' group by 1`, [u.id]),
      activity: await many(db, `select date_trunc('day', v.updated_at)::date as day, count(*)::int as saves, sum(v.word_count)::int as words from document_versions v where v.owner_user_id=$1 and v.updated_at > now() - interval '30 days' group by 1 order by 1`, [u.id]),
      documents: (await one(db, `select count(*)::int as n from documents where owner_user_id=$1 and org_id is null and deleted_at is null`, [u.id])).n,
      reports: (await one(db, `select count(*)::int as n from reports where owner_user_id=$1`, [u.id])).n,
    }));
  });

  // ---------------------------------------------------------------- rewriting, summaries, translation, tutor
  const toolDoc = async (db: Db, userId: string, docId?: string) => (docId ? ownDocument(db, docId, userId) : null);

  app.post('/tools/rewrite', async (req) => {
    const u = req.me();
    const b = z.object({ text: z.string().min(1).max(5000), mode: z.enum(MODES), document_id: uuid.optional(), locked: z.array(z.string().max(200)).max(50).default([]) }).parse(req.body);
    return req.db(async (db) => {
      const d = await toolDoc(db, u.id, b.document_id);
      await enforceCapability(db, d, 'paraphrase');
      let alternatives: { text: string; source: string }[] = [];
      let providerStatus: string = 'ok';
      let message: string | undefined;
      if (LOCAL_MODES.includes(b.mode as Mode)) alternatives.push({ text: localRewrite(b.text, b.mode as Mode, b.locked), source: 'local rules' });
      const p = await providerTask('paraphrase', b.text, { mode: b.mode as Mode, locked: b.locked });
      if (p.status === 'ok') alternatives.push({ text: p.output, source: p.provider });
      else { providerStatus = p.status; message = p.message; }
      if (!alternatives.length) return { status: providerStatus, message, alternatives: [] };
      await recordUsage(db, { userId: u.id, orgId: d?.org_id ?? null, kind: 'rewrite_words', quantity: b.text.split(/\s+/).length, key: `rewrite:${u.id}:${sha256(b.text + b.mode + Date.now())}` });
      return {
        status: 'ok',
        provider_status: providerStatus,
        message,
        original: b.text,
        alternatives: alternatives.map((a) => ({ ...a, unchanged: a.text === b.text, flags: checkPreservation(b.text, a.text, b.locked) })),
        note: 'Rewriting is a writing and learning aid. It is not a way to hide source use; cite your sources.',
      };
    });
  });

  app.post('/tools/summarize', async (req) => {
    const u = req.me();
    const b = z.object({ text: z.string().min(1).max(200_000), length: z.enum(['short', 'medium', 'long']).default('medium'), format: z.enum(['paragraph', 'bullets']).default('bullets'), document_id: uuid.optional() }).parse(req.body);
    return req.db(async (db) => {
      const d = await toolDoc(db, u.id, b.document_id);
      await enforceCapability(db, d, 'summarization');
      return { status: 'ok', ...extractiveSummary(b.text, { length: b.length, format: b.format }) };
    });
  });

  app.post('/tools/translate', async (req) => {
    const u = req.me();
    const b = z.object({ text: z.string().min(1).max(5000), target: z.enum(['en', 'sw', 'fr']), document_id: uuid.optional() }).parse(req.body);
    return req.db(async (db) => {
      const d = await toolDoc(db, u.id, b.document_id);
      await enforceCapability(db, d, 'translation');
      const p = await providerTask('translate', b.text, { targetLanguage: { en: 'English', sw: 'Swahili', fr: 'French' }[b.target] });
      return p.status === 'ok' ? { status: 'ok', output: p.output, flags: checkPreservation(b.text, p.output).filter((f) => f.kind !== 'name' && f.kind !== 'negation'), note: 'Machine translation; review before use.' } : p;
    });
  });

  app.post('/tools/tutor', async (req) => {
    const u = req.me();
    const b = z.object({ text: z.string().max(20000).default(''), question: z.string().min(1).max(1000), document_id: uuid.optional() }).parse(req.body);
    return req.db(async (db) => {
      const d = await toolDoc(db, u.id, b.document_id);
      await enforceCapability(db, d, 'tutoring');
      return providerTask('tutor', b.text, { question: b.question });
    });
  });
}

export async function createPersonalSource(db: Db, userId: string, title: string, text: string, url: string | null, author?: string) {
  const s = await one(db, `insert into sources(owner_user_id, scope, title, url, author, content_text, token_count) values ($1,'personal',$2,$3,$4,$5,$6) returning id, title, token_count`,
    [userId, title, url, author ?? null, text, tokenize(text).length]);
  await indexSource(db, s.id, text, userId, null);
  return s;
}

/** Word-level diff (LCS) for side-by-side revision comparison. Bounded for very long texts. */
export function wordDiff(a: string, b: string) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/);
  if (A.length * B.length > 4_000_000) return [{ op: 'replace', a, b }];
  const m = A.length, n = B.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { op: 'eq' | 'del' | 'ins'; text: string }[] = [];
  const push = (op: 'eq' | 'del' | 'ins', text: string) => { const l = out[out.length - 1]; if (l && l.op === op) l.text += text; else out.push({ op, text }); };
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) { push('eq', A[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('ins', B[j++]);
  }
  while (i < m) push('del', A[i++]);
  while (j < n) push('ins', B[j++]);
  return out;
}
