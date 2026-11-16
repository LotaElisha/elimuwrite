import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, many, type Db } from '../db.js';
import { ownDocument } from '../lib/authz.js';
import { notFound, badRequest } from '../lib/misc.js';
import { formatBibliography, exportReferences, lookupDoi, lookupIsbn, missingFields, checkCitations, STYLES, type Csl } from '../engines/citations.js';

const uuid = z.string().uuid();

const cslSchema = z.object({
  type: z.string().default('article-journal'),
  title: z.string().max(1000).optional(),
  author: z.array(z.object({ family: z.string().max(200), given: z.string().max(200).optional() })).max(100).optional(),
  'container-title': z.string().max(500).optional(),
  publisher: z.string().max(300).optional(),
  volume: z.string().max(50).optional(),
  issue: z.string().max(50).optional(),
  page: z.string().max(50).optional(),
  DOI: z.string().max(200).optional(),
  URL: z.string().max(1000).optional(),
  ISBN: z.string().max(40).optional(),
  issued: z.object({ 'date-parts': z.array(z.array(z.number())) }).optional(),
}).passthrough();

function view(r: any) {
  const miss = missingFields(r.csl);
  return {
    ...r,
    missing_fields: miss,
    // Three separate questions, never merged into one "verified" flag.
    checks: {
      exists: r.existence_status,
      metadata: miss.length ? 'incomplete' : r.metadata_status,
      supports_claim: r.support_status,
      note: 'A verified DOI shows the source exists. It does not show the source supports your claim.',
    },
  };
}

async function ownRef(db: Db, id: string, userId: string) {
  const r = await one(db, `select * from refs where id=$1`, [id]);
  if (!r || (r.org_id === null && r.owner_user_id !== userId)) throw notFound('Reference');
  return r;
}

export async function refRoutes(app: FastifyInstance) {
  app.get('/refs', async (req) => {
    const u = req.me();
    const q = z.object({ tag: z.string().optional(), document_id: uuid.optional() }).parse(req.query);
    return req.db(async (db) => {
      const rows = q.document_id
        ? await many(db, `select r.* from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1 and (r.owner_user_id=$2 or r.org_id is not null) order by r.created_at`, [q.document_id, u.id])
        : await many(db, `select * from refs where owner_user_id=$1 and org_id is null ${q.tag ? 'and $2 = any(tags)' : ''} order by created_at desc`, q.tag ? [u.id, q.tag] : [u.id]);
      return rows.map(view);
    });
  });

  // Add by DOI / ISBN (looked up) or URL / manual metadata (saved as user-entered, unverified).
  app.post('/refs', async (req) => {
    const u = req.me();
    const b = z.object({ doi: z.string().max(200).optional(), isbn: z.string().max(40).optional(), csl: cslSchema.optional(), tags: z.array(z.string().max(40)).max(20).default([]), notes: z.string().max(5000).optional(), document_id: uuid.optional() }).parse(req.body);
    if (!b.doi && !b.isbn && !b.csl) throw badRequest('Provide a DOI, an ISBN, or reference details.');
    let csl: Csl = b.csl ?? {};
    let existence = 'unverified', metadata = 'user_entered', via: string | null = null, lookupMessage: string | null = null;
    if (b.doi || b.isbn) {
      const lk = b.doi ? await lookupDoi(b.doi) : await lookupIsbn(b.isbn!);
      via = lk.via;
      if (lk.status === 'verified') { csl = { ...lk.csl, ...(b.csl ?? {}) }; existence = 'verified'; metadata = b.csl ? 'user_corrected' : 'from_registry'; }
      else {
        existence = lk.status;
        lookupMessage = lk.message;
        // keep only what the user typed; never fill in guessed metadata
        csl = { ...(b.csl ?? {}), ...(b.doi ? { DOI: b.doi } : { ISBN: b.isbn }) };
      }
    }
    return req.db(async (db) => {
      const r = await one(db,
        `insert into refs(owner_user_id, csl, doi, url, isbn, tags, notes, existence_status, metadata_status, verified_via, verified_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, case when $8='verified' then now() end) returning *`,
        [u.id, JSON.stringify(csl), csl.DOI ?? b.doi ?? null, csl.URL ?? null, csl.ISBN ?? b.isbn ?? null, b.tags, b.notes ?? null, existence, metadata, via]);
      if (b.document_id) {
        await ownDocument(db, b.document_id, u.id);
        await db.query(`insert into document_refs(document_id, ref_id) values ($1,$2) on conflict do nothing`, [b.document_id, r.id]);
      }
      return { ...view(r), lookup_message: lookupMessage };
    });
  });

  app.patch('/refs/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ csl: cslSchema.optional(), tags: z.array(z.string()).optional(), notes: z.string().max(5000).nullable().optional(), support_status: z.enum(['not_assessed', 'user_confirmed', 'disputed']).optional() }).parse(req.body);
    return req.db(async (db) => {
      const r = await ownRef(db, id, u.id);
      const csl = b.csl ? { ...r.csl, ...b.csl } : r.csl;
      const meta = b.csl ? (r.metadata_status === 'from_registry' ? 'user_corrected' : r.metadata_status) : r.metadata_status;
      const out = await one(db, `update refs set csl=$2, tags=coalesce($3, tags), notes=coalesce($4, notes), support_status=coalesce($5, support_status), metadata_status=$6, updated_at=now() where id=$1 returning *`,
        [id, JSON.stringify(csl), b.tags ?? null, b.notes ?? null, b.support_status ?? null, meta]);
      return view(out);
    });
  });

  app.post('/refs/:id/verify', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const r = await ownRef(db, id, u.id);
      if (!r.doi && !r.isbn) return { ...view(r), lookup_message: 'Add a DOI or ISBN to verify that this source exists.' };
      const lk = r.doi ? await lookupDoi(r.doi) : await lookupIsbn(r.isbn);
      if (lk.status !== 'verified') {
        const out = await one(db, `update refs set existence_status=$2, verified_via=$3, updated_at=now() where id=$1 returning *`, [id, lk.status, lk.via]);
        return { ...view(out), lookup_message: lk.message };
      }
      // Compare registry metadata with what the user has, field by field; report differences rather than overwrite.
      const diffs: string[] = [];
      if (lk.csl.title && r.csl.title && lk.csl.title.toLowerCase() !== r.csl.title.toLowerCase()) diffs.push('title');
      const yr = (c: any) => c.issued?.['date-parts']?.[0]?.[0];
      if (yr(lk.csl) && yr(r.csl) && yr(lk.csl) !== yr(r.csl)) diffs.push('year');
      if (lk.csl.author?.[0]?.family && r.csl.author?.[0]?.family && lk.csl.author[0].family.toLowerCase() !== r.csl.author[0].family.toLowerCase()) diffs.push('first author');
      const out = await one(db, `update refs set existence_status='verified', verified_via=$2, verified_at=now(), updated_at=now() where id=$1 returning *`, [id, lk.via]);
      return { ...view(out), registry: lk.csl, metadata_differences: diffs };
    });
  });

  app.delete('/refs/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const r = await ownRef(db, id, u.id);
      if (r.org_id) throw notFound('Reference');
      await db.query(`delete from refs where id=$1`, [id]);
      return { deleted: true };
    });
  });

  app.post('/documents/:id/refs/:ref', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, ref: uuid }).parse(req.params);
    return req.db(async (db) => {
      await ownDocument(db, p.id, u.id);
      await ownRef(db, p.ref, u.id);
      await db.query(`insert into document_refs values ($1,$2) on conflict do nothing`, [p.id, p.ref]);
      return { ok: true };
    });
  });
  app.delete('/documents/:id/refs/:ref', async (req) => {
    const u = req.me();
    const p = z.object({ id: uuid, ref: uuid }).parse(req.params);
    return req.db(async (db) => {
      await ownDocument(db, p.id, u.id);
      await db.query(`delete from document_refs where document_id=$1 and ref_id=$2`, [p.id, p.ref]);
      return { ok: true };
    });
  });

  app.get('/documents/:id/bibliography', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const q = z.object({ style: z.enum(Object.keys(STYLES) as [string, ...string[]]).default('apa') }).parse(req.query);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      const refs = await many(db, `select r.id, r.csl, r.existence_status from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1`, [id]);
      return {
        style: q.style,
        text: formatBibliography(refs.map((r) => ({ ...r.csl, id: r.id })), q.style),
        unverified: refs.filter((r) => r.existence_status !== 'verified').length,
        incomplete: refs.filter((r) => missingFields(r.csl).length).length,
      };
    });
  });

  app.post('/documents/:id/citation-check', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      const v = await one(db, `select id, version_no, content_text from document_versions where id=$1`, [d.current_version_id]);
      const lib = await many(db, `select r.csl, r.existence_status from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1`, [id]);
      return { version_id: v.id, version_no: v.version_no, ...checkCitations(v.content_text, lib), note: 'Checks are pattern-based. "Possible" issues need your judgement.' };
    });
  });

  app.get('/refs/export', async (req, reply) => {
    const u = req.me();
    const q = z.object({ format: z.enum(['bibtex', 'ris']), document_id: uuid.optional() }).parse(req.query);
    const rows = await req.db(async (db) => {
      if (q.document_id) await ownDocument(db, q.document_id, u.id);
      return q.document_id
        ? many(db, `select r.id, r.csl from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1`, [q.document_id])
        : many(db, `select id, csl from refs where owner_user_id=$1 and org_id is null`, [u.id]);
    });
    reply.header('content-type', 'text/plain; charset=utf-8').header('content-disposition', `attachment; filename="references.${q.format === 'bibtex' ? 'bib' : 'ris'}"`);
    return exportReferences(rows.map((r) => ({ ...r.csl, id: r.id })), q.format);
  });
}
