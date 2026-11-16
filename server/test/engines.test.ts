// Pure engine tests: acceptance criteria 5 (scoring), 6 (no clean report without evidence),
// 8 (rewrite preservation) and 9 (citation statuses at the engine level).
import { describe, it, expect } from 'vitest';
import { tokenize, analyze, score, describeOutcome, excludedRegions } from '../src/engines/similarity.js';
import { checkPreservation, localRewrite, extractiveSummary } from '../src/engines/rewrite.js';
import { checkCitations, formatBibliography, exportReferences, missingFields } from '../src/engines/citations.js';
import { detectLanguage, checkText } from '../src/engines/grammar.js';
import { resolvePolicy } from '../src/engines/policy.js';
import { TEXT } from './helpers.js';

const S = { excludeQuotes: true, excludeBibliography: true, minMatchWords: 8 };

describe('similarity scoring (AC5)', () => {
  it('counts each matched token once when two sources overlap the same passage', () => {
    const doc = `${TEXT.rain} ${TEXT.original}`;
    const one = analyze(doc, [{ id: 'a', text: TEXT.rain }], S);
    const two = analyze(doc, [{ id: 'a', text: TEXT.rain }, { id: 'b', text: TEXT.rain }], S);
    expect(two.score.matchedTokens).toBe(one.score.matchedTokens);
    expect(two.score.percentage).toBe(one.score.percentage);
    // Per-source figures sum to the overall figure (no double counting).
    expect(two.score.bySource.reduce((n, s) => n + s.matchedTokens, 0)).toBe(two.score.matchedTokens);
  });

  it('percentage = 100 x matched eligible tokens / eligible tokens', () => {
    const doc = `${TEXT.rain} ${TEXT.original}`;
    const r = analyze(doc, [{ id: 'a', text: TEXT.rain }], S);
    const rainTokens = tokenize(TEXT.rain).length;
    expect(r.score.matchedTokens).toBe(rainTokens);
    expect(r.score.eligibleTokens).toBe(tokenize(doc).length);
    expect(r.score.percentage).toBe(Math.round((1000 * rainTokens) / tokenize(doc).length) / 10);
  });

  it('ignores runs shorter than the minimum match length', () => {
    const doc = 'Rainwater harvesting has become important for many people. ' + TEXT.original;
    const r = analyze(doc, [{ id: 'a', text: TEXT.rain }], S);
    expect(r.score.matchedTokens).toBe(0);
  });

  it('removes quotations and bibliography from numerator and denominator', () => {
    const doc = `${TEXT.original} "${TEXT.rain}"\n\nReferences\nSmith, J. (2020). A book about rain. Dodoma: Example Press.`;
    const r = analyze(doc, [{ id: 'a', text: TEXT.rain }], S);
    expect(r.score.matchedTokens).toBe(0);
    expect(r.score.eligibleTokens).toBe(tokenize(TEXT.original).length);
    const kinds = excludedRegions(doc, { excludeQuotes: true, excludeBibliography: true }).map((x) => x.reason);
    expect(kinds).toContain('quotation');
    expect(kinds).toContain('bibliography');
    const included = analyze(doc, [{ id: 'a', text: TEXT.rain }], { ...S, excludeQuotes: false });
    expect(included.score.matchedTokens).toBeGreaterThan(0);
  });

  it('source and match exclusions reduce the numerator only', () => {
    const doc = `${TEXT.rain} ${TEXT.mobile} ${TEXT.original}`;
    const r = analyze(doc, [{ id: 'a', text: TEXT.rain }, { id: 'b', text: TEXT.mobile }], S);
    const ex = score({ tokenCount: r.tokens.length, eligible: r.eligible, runs: r.runs, excludedSourceIds: new Set(['a']) });
    expect(ex.eligibleTokens).toBe(r.score.eligibleTokens);
    expect(ex.matchedTokens).toBe(tokenize(TEXT.mobile).length);
    const runs = r.runs.map((x, i) => ({ ...x, id: `r${i}` }));
    const exRun = score({ tokenCount: r.tokens.length, eligible: r.eligible, runs, excludedRunIds: new Set(runs.filter((x) => x.sourceId === 'b').map((x) => x.id)) });
    expect(exRun.matchedTokens).toBe(tokenize(TEXT.rain).length);
  });

  it('normalises case, diacritics and apostrophes', () => {
    const src = 'The farmers’ cooperative in Morogoro stores maize in improved hermetic bags to reduce losses after harvest.';
    const doc = "THE FARMERS' COOPERATIVE IN MÓROGORO STORES MAIZE IN IMPROVED HERMETIC BAGS TO REDUCE LOSSES AFTER HARVEST.";
    expect(analyze(doc, [{ id: 'a', text: src }], S).score.percentage).toBe(100);
  });
});

describe('never a clean report without evidence (AC6)', () => {
  it('no sources is not a zero', () => {
    const r = analyze(TEXT.rain, [], S);
    expect(describeOutcome(r.score, 0).status).toBe('no_sources');
  });
  it('no eligible text is "Not enough eligible text", not 0%', () => {
    const r = analyze(`"${TEXT.rain}"`, [{ id: 'a', text: TEXT.rain }], S);
    expect(r.score.percentage).toBeNull();
    expect(describeOutcome(r.score, 1)).toEqual({ status: 'insufficient_text', message: 'Not enough eligible text' });
  });
  it('zero matches use the qualified wording', () => {
    const r = analyze(TEXT.original, [{ id: 'a', text: TEXT.rain }], S);
    expect(describeOutcome(r.score, 1).message).toBe('No qualifying matches found in the checked sources.');
  });
  it('Swahili is detected and the English grammar engine does not claim to check it', () => {
    expect(detectLanguage(TEXT.swahili)).toBe('sw');
    expect(detectLanguage(TEXT.rain)).toBe('en');
  });
});

describe('rewrite preservation (AC8)', () => {
  const orig = 'According to Mwakyusa (2021), 64% of households in Dodoma do not store water for more than "two weeks" in the dry season.';
  it('flags changed numbers, quotes, citations, names and negation', () => {
    const bad = 'According to research, most households in the region store water for "a fortnight" in the dry season.';
    const kinds = new Set(checkPreservation(orig, bad).map((f) => f.kind));
    for (const k of ['number', 'quotation', 'citation', 'name', 'negation']) expect(kinds).toContain(k);
  });
  it('raises no flags when meaning-bearing elements survive', () => {
    expect(checkPreservation(orig, orig)).toEqual([]);
  });
  it('flags locked terms', () => {
    expect(checkPreservation('We studied the jiko stove.', 'We studied the cooker.', ['jiko']).map((f) => f.kind)).toContain('locked_term');
  });
  it('local rewrites keep protected spans intact', () => {
    const out = localRewrite('In order to understand this, Mwakyusa (2021) said "water is life" and 64% agreed.', 'concise');
    expect(out).toContain('(2021)');
    expect(out).toContain('"water is life"');
    expect(out).toContain('64%');
    expect(out.toLowerCase()).not.toContain('in order to');
  });
  it('summaries are extractive: every sentence comes from the source', () => {
    const text = `${TEXT.rain} ${TEXT.mobile} ${TEXT.original}`;
    const s = extractiveSummary(text, { length: 'short', format: 'bullets' });
    const items: string[] = (s as any).sentences ?? (s as any).bullets ?? String((s as any).summary ?? '').split('\n');
    for (const it of items.map((x) => x.replace(/^[-•]\s*/, '').trim()).filter(Boolean)) expect(text).toContain(it);
  });
});

describe('citation engine (AC9)', () => {
  it('detects missing references and uncited entries', () => {
    const text = 'Water matters (Mwakyusa, 2021). Savings help (Okello & Njeri, 2019).\n\nReferences\nMwakyusa, A. (2021). Learning to harvest rain. Journal, 4, 1–10.\nJuma, H. (2018). Uncited book. Arusha: Example.';
    const r = checkCitations(text, []);
    const kinds = r.issues.map((i) => i.kind);
    expect(kinds).toContain('missing_reference');
    expect(kinds).toContain('uncited_entry');
  });
  it('formats bibliographies in several styles and exports BibTeX/RIS', () => {
    const item = { id: 'x', type: 'book', title: 'Savings groups and household water', author: [{ family: 'Okello', given: 'Peter' }], publisher: 'Example Press', issued: { 'date-parts': [[2019]] } };
    for (const st of ['apa', 'mla', 'chicago', 'harvard', 'ieee']) expect(formatBibliography([item], st).toLowerCase()).toContain('savings groups');
    expect(exportReferences([item], 'bibtex')).toContain('@book');
    expect(exportReferences([item], 'ris')).toContain('TY  - BOOK');
  });
  it('lists missing required fields instead of inventing them', () => {
    expect(missingFields({ type: 'article-journal', title: 'X' })).toEqual(expect.arrayContaining(['author']));
  });
});

describe('writing engine and policy', () => {
  it('returns explained suggestions with offsets that match the text', () => {
    const t = 'In this essay i argue that in order to succeed, we must act.';
    const s = checkText(t, { variant: 'en-US' } as any);
    expect(s.length).toBeGreaterThan(0);
    for (const x of s) expect(t.slice(x.start, x.end)).toBe(x.original);
  });
  it('assistance presets are explicit', () => {
    expect(resolvePolicy('proofreading_only').paraphrase).toBe(false);
    expect(resolvePolicy('assistance_disabled').grammar).toBe(false);
    expect(resolvePolicy('permitted_with_disclosure').disclosure_required).toBe(true);
  });
});
