/**
 * Postgres-backed job queue (FOR UPDATE SKIP LOCKED). Chosen over Redis for Phase 1 so
 * jobs share the transactional guarantees of the data they act on; a Redis-backed queue
 * can replace it behind the same enqueue/claim interface when throughput requires.
 *
 * Jobs survive the user leaving the page and server restarts (expired locks are reclaimed).
 * Idempotency keys make duplicate requests return the existing job.
 */
import { pool, withDb, one, many, type Db } from '../db.js';
import { ENGINE, ENGINE_VERSION, analyze, score, describeOutcome, tokenize, shingles, type SourceText } from '../engines/similarity.js';
import { checkText, readability, detectLanguage } from '../engines/grammar.js';
import { checkCitations } from '../engines/citations.js';
import { recordUsage } from '../lib/entitlements.js';
import { randomBytes } from 'node:crypto';

export type EnqueueInput = {
  kind: 'similarity' | 'citations' | 'writing';
  documentId: string | null;
  versionId: string;
  submissionId?: string | null;
  orgId: string | null;
  ownerUserId: string;
  requestedBy: string;
  settings: Record<string, unknown>;
  idempotencyKey: string;
};

export async function enqueue(db: Db, j: EnqueueInput) {
  const ins = await one(db,
    `insert into analysis_jobs(kind, document_id, version_id, submission_id, org_id, owner_user_id, requested_by, settings, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (idempotency_key) do nothing returning *`,
    [j.kind, j.documentId, j.versionId, j.submissionId ?? null, j.orgId, j.ownerUserId, j.requestedBy, JSON.stringify(j.settings), j.idempotencyKey]);
  if (ins) {
    await db.query(`select pg_notify('elimu_jobs', $1)`, [ins.id]);
    return { job: ins, duplicate: false };
  }
  const existing = await one(db, `select * from analysis_jobs where idempotency_key=$1`, [j.idempotencyKey]);
  return { job: existing, duplicate: true };
}

/** Index a source's text into fingerprints. Runs inside the caller's RLS context. */
export async function indexSource(db: Db, sourceId: string, text: string, ownerUserId: string | null, orgId: string | null) {
  await db.query(`delete from fingerprints where source_id=$1`, [sourceId]);
  const sh = shingles(tokenize(text));
  for (let i = 0; i < sh.length; i += 2000) {
    const chunk = sh.slice(i, i + 2000);
    await db.query(
      `insert into fingerprints(source_id, owner_user_id, org_id, hash, pos) select $1, $2, $3, h::bigint, p from unnest($4::text[], $5::int[]) as t(h, p)`,
      [sourceId, ownerUserId, orgId, chunk.map((c) => c.hash), chunk.map((c) => c.pos)]);
  }
}

export function reportNumber() {
  return 'EW-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomBytes(4).toString('hex').toUpperCase();
}

type Job = Awaited<ReturnType<typeof claim>>;

async function claim() {
  const c = await pool.connect();
  try {
    const r = await c.query(
      `update analysis_jobs set status='processing', attempts=attempts+1, started_at=coalesce(started_at, now()), locked_until=now() + interval '5 minutes', progress=5
       where id = (select id from analysis_jobs
                   where (status='queued') or (status='processing' and locked_until < now() and attempts < max_attempts)
                   order by created_at for update skip locked limit 1)
       returning *`);
    return r.rows[0] ?? null;
  } finally {
    c.release();
  }
}

/** Selects the comparison corpus for a job. Always tenant-scoped; never cross-institution. */
async function selectCorpus(db: Db, job: any) {
  const s = job.settings ?? {};
  if (job.submission_id) {
    const sub = await one(db, `select * from submissions where id=$1`, [job.submission_id]);
    const rows = await many(db,
      `select id, scope, title, content_text, student_id, lineage_id, assignment_id from sources
       where org_id=$1 and (
         (scope='institution_repository' and $2::boolean)
         or (scope='assignment_template' and assignment_id=$3)
         or (scope='submission' and assignment_id=$3 and $4::boolean and lineage_id <> $5 and submission_id <> $6)
         or (scope='submission' and assignment_id=$3 and $7::boolean and lineage_id = $5 and submission_id <> $6)
       )`,
      [job.org_id, s.include_repository !== false, sub.assignment_id, s.compare_within_class !== false, sub.lineage_id, sub.id, !!s.include_own_drafts]);
    // Within-class comparison uses each other student's LATEST submission only, regardless of
    // submission order, so the first and last submitter are compared against the same set.
    const subIds = await many(db, `select src.id, s.attempt_no, s.lineage_id from sources src join submissions s on s.id=src.submission_id where src.org_id=$1 and src.assignment_id=$2`, [job.org_id, sub.assignment_id]);
    const latestIds = new Set<string>();
    const byLineage = new Map<string, { id: string; attempt: number }>();
    for (const x of subIds) {
      const cur = byLineage.get(x.lineage_id);
      if (!cur || x.attempt_no > cur.attempt) byLineage.set(x.lineage_id, { id: x.id, attempt: x.attempt_no });
    }
    for (const v of byLineage.values()) latestIds.add(v.id);
    return rows.filter((r) => r.scope !== 'submission' || r.lineage_id === sub.lineage_id || latestIds.has(r.id));
  }
  const ids: string[] | undefined = s.source_ids;
  return many(db,
    `select id, scope, title, content_text from sources where scope='personal' and owner_user_id=$1 and org_id is null ${ids?.length ? 'and id = any($2)' : ''}`,
    ids?.length ? [job.owner_user_id, ids] : [job.owner_user_id]);
}

async function runSimilarity(db: Db, job: any) {
  const v = await one(db, `select * from document_versions where id=$1`, [job.version_id]);
  const s = job.settings ?? {};
  const settings = {
    excludeQuotes: s.exclude_quotes !== false,
    excludeBibliography: s.exclude_bibliography !== false,
    minMatchWords: Number(s.min_match_words ?? 8),
  };
  const corpus = await selectCorpus(db, job);
  // Candidate retrieval through the fingerprint index, then alignment on candidates only.
  const docShingles = shingles(tokenize(v.content_text));
  let candidateIds: string[] = [];
  if (corpus.length && docShingles.length) {
    const hits = await many(db, `select distinct source_id from fingerprints where source_id = any($1) and hash = any($2::bigint[])`, [corpus.map((c) => c.id), [...new Set(docShingles.map((d) => d.hash))]]);
    candidateIds = hits.map((h) => h.source_id);
  }
  const candidates: SourceText[] = corpus.filter((c) => candidateIds.includes(c.id)).map((c) => ({ id: c.id, text: c.content_text }));
  const lang = detectLanguage(v.content_text);
  const result = analyze(v.content_text, candidates, settings);
  // Assignment template matches are shown but auto-excluded from the score (numerator only).
  const templateIds = new Set(corpus.filter((c) => c.scope === 'assignment_template').map((c) => c.id));
  const lineage = job.submission_id ? (await one(db, `select lineage_id from submissions where id=$1`, [job.submission_id]))?.lineage_id : null;
  const ownDraftIds = new Set(corpus.filter((c) => c.scope === 'submission' && lineage && c.lineage_id === lineage).map((c) => c.id));
  const autoExcluded = new Set([...templateIds, ...ownDraftIds]);
  const sc = score({ tokenCount: result.tokens.length, eligible: result.eligible, runs: result.runs, excludedSourceIds: autoExcluded });
  const outcome = describeOutcome(sc, corpus.length);
  const status = outcome.status;
  const rep = await one(db,
    `insert into reports(report_number, job_id, kind, document_id, version_id, submission_id, org_id, owner_user_id, status, settings, result, engine, engine_version)
     values ($1,$2,'similarity',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [reportNumber(), job.id, job.document_id, job.version_id, job.submission_id, job.org_id, job.owner_user_id, status,
      JSON.stringify({ ...settings, scope: corpus.length ? describeScope(corpus) : 'none', sources_checked: corpus.length, k: 5 }),
      JSON.stringify({
        message: outcome.message,
        eligible_tokens: sc.eligibleTokens,
        total_tokens: result.tokens.length,
        matched_tokens: sc.matchedTokens,
        percentage: sc.percentage,
        by_source: sc.bySource,
        excluded_regions: result.regions,
        auto_excluded_sources: [...autoExcluded],
        language_detected: lang,
        sources: corpus.map((c) => ({ id: c.id, title: c.title, scope: c.scope })),
      }),
      ENGINE, ENGINE_VERSION]);
  for (const r of result.runs) {
    await db.query(
      `insert into similarity_matches(report_id, source_id, doc_char_start, doc_char_end, doc_token_start, doc_token_end, source_char_start, source_char_end, length_tokens, auto_excluded_reason)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [rep.id, r.sourceId, r.docCharStart, r.docCharEnd, r.docTokenStart, r.docTokenEnd, r.srcCharStart, r.srcCharEnd, r.docTokenEnd - r.docTokenStart,
        templateIds.has(r.sourceId) ? 'assignment_template' : autoExcluded.has(r.sourceId) ? 'own_earlier_draft' : null]);
  }
  return { reportId: rep.id, status };
}

function describeScope(corpus: any[]) {
  const counts: Record<string, number> = {};
  for (const c of corpus) counts[c.scope] = (counts[c.scope] ?? 0) + 1;
  return counts;
}

async function runCitations(db: Db, job: any) {
  const v = await one(db, `select * from document_versions where id=$1`, [job.version_id]);
  const lib = job.document_id ? await many(db, `select r.csl, r.existence_status from refs r join document_refs dr on dr.ref_id=r.id where dr.document_id=$1`, [job.document_id]) : [];
  const res = checkCitations(v.content_text, lib);
  const rep = await one(db,
    `insert into reports(report_number, job_id, kind, document_id, version_id, submission_id, org_id, owner_user_id, status, settings, result, engine, engine_version)
     values ($1,$2,'citations',$3,$4,$5,$6,$7,'completed','{}',$8,'elimu-citations','1.0.0') returning id`,
    [reportNumber(), job.id, job.document_id, job.version_id, job.submission_id, job.org_id, job.owner_user_id, JSON.stringify(res)]);
  return { reportId: rep.id, status: 'completed' };
}

async function runWriting(db: Db, job: any) {
  const v = await one(db, `select * from document_versions where id=$1`, [job.version_id]);
  const lang = detectLanguage(v.content_text);
  const res = lang === 'sw'
    ? { status: 'unsupported_language', message: 'Swahili writing analysis is not yet available (beta pending evaluation). No suggestions were generated.', suggestions: [] }
    : { status: 'completed', suggestions: checkText(v.content_text, { variant: job.settings?.variant ?? 'en-US' }), readability: readability(v.content_text) };
  const rep = await one(db,
    `insert into reports(report_number, job_id, kind, document_id, version_id, submission_id, org_id, owner_user_id, status, settings, result, engine, engine_version)
     values ($1,$2,'writing',$3,$4,$5,$6,$7,$8,$9,$10,'elimu-rules','1.0.0') returning id`,
    [reportNumber(), job.id, job.document_id, job.version_id, job.submission_id, job.org_id, job.owner_user_id, res.status, JSON.stringify(job.settings ?? {}), JSON.stringify(res)]);
  return { reportId: rep.id, status: res.status };
}

export async function processJob(job: NonNullable<Job>) {
  try {
    // The job runs with tenant scope: it can only read rows of its own organization (or the requester's personal rows).
    const out = await withDb({ jobUser: job.owner_user_id, jobOrg: job.org_id }, async (db) => {
      const cur = await one(db, `select status from analysis_jobs where id=$1`, [job.id]);
      if (cur?.status === 'cancelled') return null;
      const r = job.kind === 'similarity' ? await runSimilarity(db, job) : job.kind === 'citations' ? await runCitations(db, job) : await runWriting(db, job);
      // Every report points at exactly the text it describes, so the analysed version is frozen.
      await db.query(`update document_versions set frozen=true where id=$1 and not frozen`, [job.version_id]);
      // Charge exactly once per job, only on success. Retries reuse the job, so the key is stable.
      if (job.kind === 'similarity' && r.status === 'completed') {
        await recordUsage(db, { userId: job.owner_user_id, orgId: job.org_id, kind: 'similarity_check', quantity: 1, jobId: job.id, key: `job:${job.id}` });
      }
      await db.query(`update analysis_jobs set status='completed', progress=100, finished_at=now(), locked_until=null, error=null where id=$1`, [job.id]);
      return r;
    });
    return out;
  } catch (e: any) {
    const final = job.attempts >= job.max_attempts;
    await pool.query(`update analysis_jobs set status=$2, error=$3, locked_until=null, finished_at=case when $2='failed' then now() else null end where id=$1`,
      [job.id, final ? 'failed' : 'queued', String(e?.message ?? e).slice(0, 500)]);
    if (!process.env.VITEST) console.error('job failed', job.id, e?.message);
    return null;
  }
}

/** Process all currently runnable jobs (used by tests and by the worker loop). */
export async function drain(max = 100) {
  for (let i = 0; i < max; i++) {
    const job = await claim();
    if (!job) return i;
    await processJob(job);
  }
  return max;
}

export function startWorker(intervalMs = 1000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await drain(20); } catch (e) { console.error('worker', e); } finally { running = false; }
  };
  const h = setInterval(tick, intervalMs);
  return () => clearInterval(h);
}
