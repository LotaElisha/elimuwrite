/**
 * Local-corpus lexical similarity engine (spec §8).
 *
 * Method (also documented in docs/SIMILARITY_METHOD.md):
 *  1. Normalisation: Unicode NFKC, case-folding, diacritics removed (NFD + strip marks),
 *     curly apostrophes unified. Punctuation and whitespace are ignored.
 *  2. Tokenisation: a token is a run of letters/digits, optionally joined by an apostrophe
 *     ("don't"). Each token keeps its character offsets in the ORIGINAL text so highlights
 *     land on the right passage.
 *  3. Fingerprints: every window of K=5 consecutive tokens is hashed (64-bit FNV-1a).
 *     All positions are indexed (no winnowing) so retrieval is exact and reproducible.
 *  4. Candidate retrieval: sources sharing at least one fingerprint with the document.
 *  5. Alignment: for each shared fingerprint the run is extended token-by-token in both
 *     texts to its maximal exact length. Runs shorter than min_match_words are discarded.
 *  6. Score: 100 × |uniquely matched eligible tokens| ÷ |eligible tokens|.
 *     A token matched by several runs or sources is counted once.
 *
 * Exclusions:
 *  - Quotations and the bibliography make tokens INELIGIBLE: removed from numerator and denominator.
 *  - Source exclusions (templates, reviewer-excluded sources, own earlier drafts) and
 *    match exclusions remove tokens from the NUMERATOR only; the denominator is unchanged.
 */

export const ENGINE = 'elimu-lexical';
export const ENGINE_VERSION = '1.0.0';
export const K = 5;

export type Token = { norm: string; start: number; end: number };

export function normalizeWord(w: string) {
  return w
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

const TOKEN_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ norm: normalizeWord(m[0]), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = (1n << 64n) - 1n;

/** 64-bit FNV-1a, returned as a signed decimal string to fit Postgres bigint. */
export function hashShingle(words: string[]): string {
  let h = FNV_OFFSET;
  const s = words.join(' ');
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK;
  }
  return BigInt.asIntN(64, h).toString();
}

export function shingles(tokens: Token[]): { hash: string; pos: number }[] {
  const out: { hash: string; pos: number }[] = [];
  for (let i = 0; i + K <= tokens.length; i++) {
    out.push({ hash: hashShingle(tokens.slice(i, i + K).map((t) => t.norm)), pos: i });
  }
  return out;
}

export type Region = { start: number; end: number; reason: 'quotation' | 'bibliography' };

/** Character regions excluded by settings (quotations, bibliography). */
export function excludedRegions(text: string, opts: { excludeQuotes: boolean; excludeBibliography: boolean }): Region[] {
  const regions: Region[] = [];
  if (opts.excludeQuotes) {
    // Straight double quotes, curly quotes, and guillemets. Unclosed quotes are NOT excluded.
    const re = /"([^"\n]{1,2000})"|“([^”\n]{1,2000})”|«([^»\n]{1,2000})»/g;
    for (const m of text.matchAll(re)) regions.push({ start: m.index!, end: m.index! + m[0].length, reason: 'quotation' });
  }
  if (opts.excludeBibliography) {
    const m = /(^|\n)[ \t]*(references|reference list|bibliography|works cited|marejeo)[ \t]*:?[ \t]*(\n|$)/i.exec(text);
    if (m) regions.push({ start: m.index + m[1].length, end: text.length, reason: 'bibliography' });
  }
  return regions;
}

export function eligibilityMask(tokens: Token[], regions: Region[]): boolean[] {
  return tokens.map((t) => !regions.some((r) => t.start >= r.start && t.end <= r.end));
}

export type SourceText = { id: string; text: string; tokens?: Token[] };
export type Run = {
  sourceId: string;
  docTokenStart: number;
  docTokenEnd: number; // exclusive
  srcTokenStart: number;
  srcTokenEnd: number;
  docCharStart: number;
  docCharEnd: number;
  srcCharStart: number;
  srcCharEnd: number;
};

/** Maximal exact runs between the document and one source, each at least minLen tokens. */
export function alignRuns(doc: Token[], src: Token[], sourceId: string, minLen: number, srcText?: string): Run[] {
  if (doc.length < K || src.length < K) return [];
  const index = new Map<string, number[]>();
  for (const s of shingles(src)) {
    const arr = index.get(s.hash);
    if (arr) arr.push(s.pos);
    else index.set(s.hash, [s.pos]);
  }
  const runs: Run[] = [];
  // covered[diagonal] = doc index up to which this diagonal is already part of a run
  const covered = new Map<number, number>();
  const docSh = shingles(doc);
  for (const { hash, pos: i } of docSh) {
    const cands = index.get(hash);
    if (!cands) continue;
    for (const p of cands) {
      const diag = i - p;
      if ((covered.get(diag) ?? -1) > i) continue;
      // verify (hash collisions) and extend
      let len = 0;
      while (i + len < doc.length && p + len < src.length && doc[i + len].norm === src[p + len].norm) len++;
      if (len < K) continue;
      covered.set(diag, i + len);
      if (len < minLen) continue;
      runs.push({
        sourceId,
        docTokenStart: i,
        docTokenEnd: i + len,
        srcTokenStart: p,
        srcTokenEnd: p + len,
        docCharStart: doc[i].start,
        docCharEnd: doc[i + len - 1].end,
        srcCharStart: src[p].start,
        srcCharEnd: src[p + len - 1].end,
      });
    }
  }
  return runs;
}

export type ScoreInput = {
  tokenCount: number;
  eligible: boolean[];
  runs: { id?: string; sourceId: string; docTokenStart: number; docTokenEnd: number }[];
  excludedSourceIds?: Set<string>;
  excludedRunIds?: Set<string>;
};

export type Score = {
  eligibleTokens: number;
  matchedTokens: number;
  percentage: number | null; // null => "Not enough eligible text"
  bySource: { sourceId: string; matchedTokens: number; percentage: number }[];
};

/**
 * Overall and per-source percentages. Each matched token counts once overall; for the
 * per-source breakdown it is attributed to the source with the longest run covering it
 * (ties: lowest source id), so per-source figures sum to the overall figure.
 */
export function score(inp: ScoreInput): Score {
  const eligibleTokens = inp.eligible.filter(Boolean).length;
  const owner: (null | { sourceId: string; len: number })[] = new Array(inp.tokenCount).fill(null);
  for (const r of inp.runs) {
    if (inp.excludedSourceIds?.has(r.sourceId)) continue;
    if (r.id && inp.excludedRunIds?.has(r.id)) continue;
    const len = r.docTokenEnd - r.docTokenStart;
    for (let t = r.docTokenStart; t < r.docTokenEnd; t++) {
      if (!inp.eligible[t]) continue;
      const cur = owner[t];
      if (!cur || len > cur.len || (len === cur.len && r.sourceId < cur.sourceId)) owner[t] = { sourceId: r.sourceId, len };
    }
  }
  const counts = new Map<string, number>();
  let matched = 0;
  for (const o of owner) {
    if (!o) continue;
    matched++;
    counts.set(o.sourceId, (counts.get(o.sourceId) ?? 0) + 1);
  }
  const pct = (n: number) => (eligibleTokens === 0 ? 0 : Math.round((1000 * n) / eligibleTokens) / 10);
  return {
    eligibleTokens,
    matchedTokens: matched,
    percentage: eligibleTokens === 0 ? null : pct(matched),
    bySource: [...counts.entries()]
      .map(([sourceId, n]) => ({ sourceId, matchedTokens: n, percentage: pct(n) }))
      .sort((a, b) => b.matchedTokens - a.matchedTokens),
  };
}

export type AnalyzeSettings = { excludeQuotes: boolean; excludeBibliography: boolean; minMatchWords: number };

/** Pure, in-memory analysis (used by the worker after DB candidate retrieval, and by the guest demo). */
export function analyze(text: string, sources: SourceText[], settings: AnalyzeSettings) {
  const tokens = tokenize(text);
  const regions = excludedRegions(text, settings);
  const eligible = eligibilityMask(tokens, regions);
  const minLen = Math.max(K, settings.minMatchWords);
  const runs: Run[] = [];
  for (const s of sources) runs.push(...alignRuns(tokens, s.tokens ?? tokenize(s.text), s.id, minLen));
  // Drop runs made only of ineligible tokens (e.g. fully inside a quotation).
  const kept = runs.filter((r) => eligible.slice(r.docTokenStart, r.docTokenEnd).some(Boolean));
  return { tokens, regions, eligible, runs: kept, score: score({ tokenCount: tokens.length, eligible, runs: kept }) };
}

export function describeOutcome(s: Score, sourcesChecked: number) {
  if (sourcesChecked === 0) return { status: 'no_sources' as const, message: 'No sources were available to compare against. This is not a clean result.' };
  if (s.percentage === null) return { status: 'insufficient_text' as const, message: 'Not enough eligible text' };
  if (s.matchedTokens === 0) return { status: 'completed' as const, message: 'No qualifying matches found in the checked sources.' };
  return { status: 'completed' as const, message: `${s.percentage}% of eligible text overlaps with the checked sources.` };
}
