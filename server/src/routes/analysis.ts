import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one, many, withDb, type Db } from '../db.js';
import { ownDocument, enforceCapability } from '../lib/authz.js';
import { audit, notFound, newToken, conflict, HttpError, forbidden } from '../lib/misc.js';
import { sha256 } from '../lib/text.js';
import { enqueue } from '../jobs/queue.js';
import { assertSimilarityQuota, payer, usageThisPeriod } from '../lib/entitlements.js';
import { tokenize, excludedRegions, eligibilityMask, score } from '../engines/similarity.js';
import { similarityPdf, writingPdf } from '../reports/pdf.js';

const uuid = z.string().uuid();

export type Audience = 'owner' | 'staff' | 'student' | 'external';

/** Who is looking at a report decides what source detail they may see. */
async function audienceFor(db: Db, rep: any, userId: string): Promise<Audience> {
  if (rep.submission_id) {
    const r = await one(db, `select app_teaches_assignment(s.assignment_id) as staff, s.student_id, a.similarity_settings from submissions s join assignments a on a.id=s.assignment_id where s.id=$1`, [rep.submission_id]);
    if (r?.staff) return 'staff';
    if (r?.student_id === userId) {
      if (!r.similarity_settings?.show_report_to_students) throw forbidden('Your instructor has not made similarity reports visible to students for this assignment.');
      return 'student';
    }
    throw notFound('Report');
  }
  if (rep.owner_user_id === userId) return 'owner';
  throw notFound('Report');
}

/**
 * Builds the report view: original and adjusted results, matches, sources and permitted excerpts.
 * Excerpts from other students' submissions or restricted repository items are withheld unless
 * the viewer teaches the assignment.
 */
export async function buildReportView(db: Db, reportId: string, audience: Audience) {
  const rep = await one(db, `select r.*, d.title as document_title, v.version_no, v.content_text, v.content_hash from reports r join document_versions v on v.id=r.version_id left join documents d on d.id=r.document_id where r.id=$1`, [reportId]);
  if (!rep) throw notFound('Report');
  const current = rep.document_id ? await one(db, `select current_version_id from documents where id=$1`, [rep.document_id]) : null;
  const base = {
    id: rep.id, report_number: rep.report_number, kind: rep.kind, status: rep.status, created_at: rep.created_at,
    document_title: rep.document_title ?? 'Submitted document', version_no: rep.version_no, version_hash: rep.content_hash,
    outdated: rep.submission_id ? false : current ? current.current_version_id !== rep.version_id : false,
    submission_id: rep.submission_id, settings: rep.settings, engine: `${rep.engine} ${rep.engine_version}`, audience,
  };
  if (rep.kind !== 'similarity') return { ...base, result: rep.result, text: audience === 'external' ? undefined : rep.content_text };

  const matches = await many(db, `select * from similarity_matches where report_id=$1 order by doc_char_start`, [reportId]);
  const exclusions = await many(db, `select e.*, u.name as reviewer from report_exclusions e join users u on u.id=e.reviewer_id where report_id=$1 order by e.created_at`, [reportId]);
  const active = exclusions.filter((e) => !e.reverted_at);
  const exSources = new Set(active.filter((e) => e.target_type === 'source').map((e) => e.target_id));
  const exMatches = new Set(active.filter((e) => e.target_type === 'match').map((e) => e.target_id));
  for (const id of rep.result.auto_excluded_sources ?? []) exSources.add(id);

  const tokens = tokenize(rep.content_text);
  const eligible = eligibilityMask(tokens, excludedRegions(rep.content_text, rep.settings));
  const runs = matches.map((m) => ({ id: m.id, sourceId: m.source_id, docTokenStart: m.doc_token_start, docTokenEnd: m.doc_token_end }));
  const autoOnly = new Set<string>(rep.result.auto_excluded_sources ?? []);
  const original = score({ tokenCount: tokens.length, eligible, runs, excludedSourceIds: autoOnly });
  const adjusted = score({ tokenCount: tokens.length, eligible, runs, excludedSourceIds: exSources, excludedRunIds: exMatches });

  const srcMeta: any[] = rep.result.sources ?? [];
  const visibleSources = new Map((await many(db, `select id, title, url, author, scope, content_text, student_id from sources where id = any($1)`, [srcMeta.map((s) => s.id)])).map((s) => [s.id, s]));
  const matchedIds = [...new Set(matches.map((m) => m.source_id))];
  const sources = matchedIds.map((id, i) => {
    const meta = srcMeta.find((s) => s.id === id) ?? { title: 'Removed source', scope: 'unknown' };
    const vis = visibleSources.get(id);
    const otherStudent = meta.scope === 'submission';
    const showDetail = audience === 'owner' || audience === 'staff';
    const label = otherStudent
      ? (audience === 'staff' ? `Submission in this assignment` : 'Another submission in this class')
      : meta.scope === 'institution_repository' ? `Institution repository: ${showDetail ? meta.title : 'restricted item'}` : meta.scope === 'assignment_template' ? `Assignment template` : meta.title;
    const oSc = original.bySource.find((b) => b.sourceId === id);
    const aSc = adjusted.bySource.find((b) => b.sourceId === id);
    return {
      id, index: i, label, scope: meta.scope, url: showDetail && vis?.url ? vis.url : null,
      original_percentage: oSc?.percentage ?? 0, adjusted_percentage: aSc?.percentage ?? 0, matched_tokens: oSc?.matchedTokens ?? 0,
      excluded: exSources.has(id), auto_excluded: autoOnly.has(id),
      excerpts_permitted: showDetail && !!vis,
      _text: showDetail && vis ? vis.content_text : null,
    };
  });
  const out = {
    ...base,
    result: {
      message: rep.result.message,
      language_detected: rep.result.language_detected,
      sources_checked: rep.settings.sources_checked,
      scope: rep.settings.scope,
      original: { percentage: original.percentage, matched: original.matchedTokens, eligible: original.eligibleTokens },
      adjusted: { percentage: adjusted.percentage, matched: adjusted.matchedTokens, eligible: adjusted.eligibleTokens },
      zero_note: original.matchedTokens === 0 && rep.status === 'completed' ? 'No qualifying matches found in the checked sources.' : null,
      excluded_regions: rep.result.excluded_regions,
    },
    sources: sources.map(({ _text, ...s }) => s),
    matches: matches.map((m) => {
      const s = sources.find((x) => x.id === m.source_id)!;
      return {
        id: m.id, source_index: s?.index ?? -1, source_id: m.source_id, doc_start: m.doc_char_start, doc_end: m.doc_char_end, length_tokens: m.length_tokens,
        excluded: exMatches.has(m.id) || exSources.has(m.source_id), auto_excluded_reason: m.auto_excluded_reason,
        source_excerpt: s?._text ? s._text.slice(Math.max(0, m.source_char_start - 80), m.source_char_end + 80) : null,
        source_excerpt_offset: s?._text ? Math.min(80, m.source_char_start) : null,
        source_excerpt_length: m.source_char_end - m.source_char_start,
      };
    }),
    exclusions: exclusions.map((e) => ({ id: e.id, target_type: e.target_type, target_id: e.target_id, reason: e.reason, reviewer: audience === 'external' ? 'Reviewer' : e.reviewer, created_at: e.created_at, reverted_at: e.reverted_at })),
    text: rep.content_text,
    limitations: [
      'Only the sources listed under scope were checked; the internet, publisher databases and other institutions were not.',
      'Matching is lexical (exact and normalised wording). Paraphrased or translated reuse is not detected.',
      'A similarity percentage is evidence for human review and does not by itself indicate plagiarism or misconduct.',
    ],
  };
  return out;
}

export async function analysisRoutes(app: FastifyInstance) {
  // Shows the expected quota consumption before running an expensive analysis.
  app.post('/documents/:id/estimate', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      const v = await one(db, `select word_count from document_versions where id=$1`, [d.current_version_id]);
      const p = await payer(db, u.id, d.org_id);
      const used = await usageThisPeriod(db, p);
      const existing = await one(db, `select id, status from analysis_jobs where version_id=$1 and kind='similarity' and status in ('queued','processing','completed') order by created_at desc limit 1`, [d.current_version_id]);
      return {
        words: v.word_count, cost: { similarity_checks: existing ? 0 : 1 }, already_checked: !!existing,
        plan: p.planName, allowance: p.limits.similarity_checks_per_month ?? null, used: (used.similarity_check ?? 0) + used.pending_similarity,
        policy: 'You are charged one check only when a scan completes. Failed or cancelled scans, retries, and repeat requests for the same version are not charged.',
      };
    });
  });

  app.post('/documents/:id/analysis', async (req, reply) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({
      kind: z.enum(['similarity', 'citations', 'writing']),
      source_ids: z.array(uuid).max(500).optional(),
      exclude_quotes: z.boolean().default(true),
      exclude_bibliography: z.boolean().default(true),
      min_match_words: z.number().int().min(5).max(50).default(8),
    }).parse(req.body);
    const out = await req.db(async (db) => {
      const d = await ownDocument(db, id, u.id);
      if (d.assignment_id) throw conflict('use_submission', 'Similarity for assignment work runs when you submit. Use the assignment page.');
      if (b.kind === 'writing') await enforceCapability(db, d, 'grammar');
      const settings = { source_ids: b.source_ids?.sort(), exclude_quotes: b.exclude_quotes, exclude_bibliography: b.exclude_bibliography, min_match_words: b.min_match_words, variant: d.english_variant };
      // Same version + same settings => same key => existing job is returned, never a second charge.
      const key = `${b.kind}:${d.current_version_id}:${sha256(JSON.stringify(settings)).slice(0, 16)}`;
      const existing = await one(db, `select * from analysis_jobs where idempotency_key=$1`, [key]);
      if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return { job: existing, duplicate: true };
      if (b.kind === 'similarity') await assertSimilarityQuota(db, u.id, null);
      const finalKey = existing ? `${key}:retry:${Date.now()}` : key;
      return enqueue(db, { kind: b.kind, documentId: id, versionId: d.current_version_id, orgId: null, ownerUserId: u.id, requestedBy: u.id, settings, idempotencyKey: finalKey });
    });
    reply.status(out.duplicate ? 200 : 202);
    return { job: publicJob(out.job), duplicate: out.duplicate };
  });

  app.get('/documents/:id/jobs', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      await ownDocument(db, id, u.id);
      const jobs = await many(db, `select j.*, v.version_no, r.id as report_id from analysis_jobs j join document_versions v on v.id=j.version_id left join reports r on r.job_id=j.id where j.document_id=$1 order by j.created_at desc limit 30`, [id]);
      return jobs.map(publicJob);
    });
  });

  app.get('/jobs/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const j = await one(db, `select j.*, r.id as report_id from analysis_jobs j left join reports r on r.job_id=j.id where j.id=$1 and (j.requested_by=$2 or j.owner_user_id=$2)`, [id, u.id]);
      if (!j) throw notFound('Job');
      return publicJob(j);
    });
  });

  app.post('/jobs/:id/cancel', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const r = await db.query(`update analysis_jobs set status='cancelled', finished_at=now() where id=$1 and requested_by=$2 and status='queued' and submission_id is null returning id`, [id, u.id]);
      if (!r.rowCount) throw conflict('not_cancellable', 'Only queued personal scans can be cancelled.');
      return { cancelled: true };
    });
  });

  app.get('/reports', async (req) => {
    const u = req.me();
    return req.db((db) => many(db,
      `select r.id, r.report_number, r.kind, r.status, r.created_at, r.result->>'percentage' as percentage, d.title as document_title, v.version_no, (d.current_version_id <> r.version_id) as outdated
       from reports r join document_versions v on v.id=r.version_id left join documents d on d.id=r.document_id where r.owner_user_id=$1 and r.submission_id is null order by r.created_at desc limit 200`, [u.id]));
  });

  app.get('/reports/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const rep = await one(db, `select * from reports where id=$1`, [id]);
      if (!rep) throw notFound('Report');
      return buildReportView(db, id, await audienceFor(db, rep, u.id));
    });
  });

  // Reviewer exclusions are recorded (never deleted), and can be reverted with a visible trail.
  app.post('/reports/:id/exclusions', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ target_type: z.enum(['source', 'match']), target_id: uuid, reason: z.string().min(3).max(500) }).parse(req.body);
    return req.db(async (db) => {
      const rep = await one(db, `select * from reports where id=$1`, [id]);
      if (!rep) throw notFound('Report');
      const aud = await audienceFor(db, rep, u.id);
      if (aud !== 'owner' && aud !== 'staff') throw forbidden('Only the document owner or an instructor can exclude matches.');
      const ok = b.target_type === 'source'
        ? await one(db, `select 1 from similarity_matches where report_id=$1 and source_id=$2 limit 1`, [id, b.target_id])
        : await one(db, `select 1 from similarity_matches where report_id=$1 and id=$2`, [id, b.target_id]);
      if (!ok) throw notFound('Match');
      const e = await one(db, `insert into report_exclusions(report_id, target_type, target_id, reason, reviewer_id) values ($1,$2,$3,$4,$5) returning *`, [id, b.target_type, b.target_id, b.reason, u.id]);
      await audit(db, { orgId: rep.org_id, actorId: u.id, action: 'report.exclusion_added', targetType: 'report', targetId: id, detail: { target_type: b.target_type, reason: b.reason } });
      return e;
    });
  });

  app.post('/reports/:id/exclusions/:ex/revert', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const ex = uuid.parse((req.params as any).ex);
    return req.db(async (db) => {
      const rep = await one(db, `select * from reports where id=$1`, [id]);
      if (!rep) throw notFound('Report');
      const aud = await audienceFor(db, rep, u.id);
      if (aud !== 'owner' && aud !== 'staff') throw forbidden();
      await db.query(`update report_exclusions set reverted_at=now(), reverted_by=$3 where id=$1 and report_id=$2 and reverted_at is null`, [ex, id, u.id]);
      await audit(db, { orgId: rep.org_id, actorId: u.id, action: 'report.exclusion_reverted', targetType: 'report', targetId: id });
      return { ok: true };
    });
  });

  app.get('/reports/:id/pdf', async (req, reply) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const view = await req.db(async (db) => {
      const rep = await one(db, `select * from reports where id=$1`, [id]);
      if (!rep) throw notFound('Report');
      return buildReportView(db, id, await audienceFor(db, rep, u.id));
    });
    reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${view.report_number}.pdf"`);
    return renderPdf(view);
  });

  app.get('/reports/compare', async (req) => {
    const u = req.me();
    const q = z.object({ a: uuid, b: uuid }).parse(req.query);
    return req.db(async (db) => {
      const out = [];
      for (const id of [q.a, q.b]) {
        const rep = await one(db, `select * from reports where id=$1`, [id]);
        if (!rep) throw notFound('Report');
        const v = await buildReportView(db, id, await audienceFor(db, rep, u.id));
        out.push({ id, report_number: v.report_number, version_no: v.version_no, created_at: v.created_at, result: v.result, sources: (v as any).sources });
      }
      return out;
    });
  });

  // Scoped, expiring, revocable share links. Tokens are 256-bit random and stored hashed.
  app.post('/reports/:id/shares', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    const b = z.object({ expires_in_days: z.number().int().min(1).max(30).default(7) }).parse(req.body ?? {});
    return req.db(async (db) => {
      const rep = await one(db, `select * from reports where id=$1`, [id]);
      if (!rep) throw notFound('Report');
      const aud = await audienceFor(db, rep, u.id);
      if (aud !== 'owner' && aud !== 'staff') throw forbidden();
      const token = newToken();
      const s = await one(db, `insert into report_shares(report_id, token_hash, created_by, expires_at) values ($1,$2,$3, now() + ($4 || ' days')::interval) returning id, expires_at`, [id, sha256(token), u.id, String(b.expires_in_days)]);
      await audit(db, { orgId: rep.org_id, actorId: u.id, action: 'report.shared', targetType: 'report', targetId: id, detail: { expires_at: s.expires_at } });
      return { id: s.id, token, expires_at: s.expires_at, path: `/shared/${token}` };
    });
  });
  app.get('/reports/:id/shares', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => many(db, `select id, expires_at, revoked_at, created_at from report_shares where report_id=$1 and created_by=$2 order by created_at desc`, [id, u.id]));
  });
  app.delete('/shares/:id', async (req) => {
    const u = req.me();
    const id = uuid.parse((req.params as any).id);
    return req.db(async (db) => {
      const r = await db.query(`update report_shares set revoked_at=now() where id=$1 and created_by=$2 and revoked_at is null`, [id, u.id]);
      if (!r.rowCount) throw notFound('Share');
      return { revoked: true };
    });
  });

  const sharedView = async (token: string) => {
    const share = await withDb({}, (db) => one(db, `select s.report_id, s.expires_at, s.revoked_at from report_shares s where token_hash=$1`, [sha256(token)]));
    if (!share || share.revoked_at || new Date(share.expires_at) < new Date()) throw notFound('Shared report');
    // Read with the report's own tenant scope, limited in code to this single report.
    const meta = await withDb({}, (db) => one(db, `select owner_user_id, org_id from report_shares_lookup($1)`, [share.report_id]));
    return withDb({ jobUser: meta.owner_user_id, jobOrg: meta.org_id }, (db) => buildReportView(db, share.report_id, 'external'));
  };
  app.get('/shared/:token', async (req) => sharedView((req.params as any).token));
  app.get('/shared/:token/pdf', async (req, reply) => {
    const view = await sharedView((req.params as any).token);
    reply.header('content-type', 'application/pdf');
    return renderPdf(view);
  });
}

function publicJob(j: any) {
  return { id: j.id, kind: j.kind, status: j.status, progress: j.progress, error: j.status === 'failed' ? 'The analysis failed. You were not charged. You can try again.' : null, version_id: j.version_id, version_no: j.version_no, report_id: j.report_id ?? null, created_at: j.created_at, finished_at: j.finished_at, attempts: j.attempts };
}

export async function renderPdf(view: any) {
  if (view.kind === 'similarity') {
    return similarityPdf({
      reportNumber: view.report_number, documentTitle: view.document_title, versionNo: view.version_no, versionHash: view.version_hash,
      scannedAt: new Date(view.created_at), status: view.status, message: view.result.message,
      original: view.result.original, adjusted: view.result.adjusted, settings: view.settings,
      scope: typeof view.result.scope === 'object' ? Object.entries(view.result.scope).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') : String(view.result.scope),
      exclusions: view.exclusions.filter((e: any) => !e.reverted_at).map((e: any) => ({ what: e.target_type, reason: e.reason, by: e.reviewer, at: new Date(e.created_at).toISOString().slice(0, 16) })),
      sources: view.sources.map((s: any) => ({ label: s.label + (s.excluded ? ' (excluded)' : ''), percentage: s.original_percentage, matchedTokens: s.matched_tokens, url: s.url })),
      text: view.text, highlights: view.matches.map((m: any) => ({ start: m.doc_start, end: m.doc_end, sourceIndex: m.source_index, excluded: m.excluded || !!m.auto_excluded_reason })),
      audience: view.audience === 'external' ? 'shared link recipient' : view.audience,
    });
  }
  return writingPdf({ reportNumber: view.report_number, documentTitle: view.document_title, versionNo: view.version_no, scannedAt: new Date(view.created_at), result: view.result, audience: view.audience });
}
