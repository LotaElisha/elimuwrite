/**
 * Citation formatting and checking.
 * Formatting uses citation-js (maintained CSL processor) with official CSL style files
 * vendored in assets/csl. Lookups (DOI via Crossref, ISBN via Open Library) only ever
 * record what the registry returned; nothing is invented when a lookup fails.
 */
import { readFileSync } from 'node:fs';
// @ts-ignore - no bundled types
import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-csl';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-ris';
import { config } from '../config.js';

export const STYLES: Record<string, { label: string; template: string }> = {
  apa: { label: 'APA 7th', template: 'apa' },
  mla: { label: 'MLA 9th', template: 'mla' },
  chicago: { label: 'Chicago (author-date)', template: 'chicago' },
  harvard: { label: 'Harvard (Cite Them Right)', template: 'harvard-ctr' },
  ieee: { label: 'IEEE', template: 'ieee' },
};

const cslDir = new URL('../../assets/csl/', import.meta.url).pathname;
const tpl = plugins.config.get('@csl').styles;
tpl.add('apa', readFileSync(cslDir + 'apa.csl', 'utf8'));
tpl.add('mla', readFileSync(cslDir + 'modern-language-association.csl', 'utf8'));
tpl.add('chicago', readFileSync(cslDir + 'chicago-author-date.csl', 'utf8'));
tpl.add('harvard-ctr', readFileSync(cslDir + 'harvard-cite-them-right.csl', 'utf8'));
tpl.add('ieee', readFileSync(cslDir + 'ieee.csl', 'utf8'));

export type Csl = Record<string, any>;

export function formatBibliography(items: Csl[], style: string, format: 'text' | 'html' = 'text'): string {
  if (!items.length) return '';
  const s = STYLES[style] ?? STYLES.apa;
  return new Cite(items).format('bibliography', { format, template: s.template, lang: 'en-US' });
}

export function exportReferences(items: Csl[], kind: 'bibtex' | 'ris'): string {
  if (!items.length) return '';
  return new Cite(items).format(kind === 'bibtex' ? 'bibtex' : 'ris', { format: 'text' });
}

/** Required fields per type; anything missing is reported so the reference is labelled incomplete. */
export function missingFields(c: Csl): string[] {
  const miss: string[] = [];
  if (!c.title) miss.push('title');
  if (!c.author?.length && !c.editor?.length) miss.push('author');
  if (!c.issued?.['date-parts']?.[0]?.[0]) miss.push('year');
  if (c.type === 'article-journal' && !c['container-title']) miss.push('journal');
  if (c.type === 'book' && !c.publisher) miss.push('publisher');
  return miss;
}

export type Lookup = { status: 'verified'; csl: Csl; via: string } | { status: 'not_found' | 'lookup_unavailable'; via: string; message: string };

let fetcher: typeof fetch = (...a) => fetch(...a);
export function setFetcher(f: typeof fetch) { fetcher = f; }

export async function lookupDoi(doi: string): Promise<Lookup> {
  const clean = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  if (!/^10\.\d{4,9}\/\S+$/.test(clean)) return { status: 'not_found', via: 'crossref', message: 'This is not a valid DOI format.' };
  if (!config.providers.crossref.enabled) return { status: 'lookup_unavailable', via: 'crossref', message: 'DOI lookup is not configured.' };
  try {
    const r = await fetcher(`https://api.crossref.org/works/${encodeURIComponent(clean)}`, { headers: { accept: 'application/json', 'user-agent': `${config.brand.name}/0.1 (citation verification${config.providers.crossref.mailto ? '; mailto:' + config.providers.crossref.mailto : ''})` } });
    if (r.status === 404) return { status: 'not_found', via: 'crossref', message: 'Crossref has no record of this DOI.' };
    if (!r.ok) return { status: 'lookup_unavailable', via: 'crossref', message: `Crossref returned ${r.status}.` };
    const m: any = (await r.json()).message;
    const csl: Csl = {
      type: m.type === 'journal-article' ? 'article-journal' : m.type === 'book' ? 'book' : m.type === 'book-chapter' ? 'chapter' : 'article',
      title: m.title?.[0],
      author: (m.author ?? []).map((a: any) => ({ family: a.family, given: a.given })).filter((a: any) => a.family),
      'container-title': m['container-title']?.[0],
      volume: m.volume,
      issue: m.issue,
      page: m.page,
      publisher: m.publisher,
      DOI: m.DOI,
      URL: m.URL,
      issued: m.issued?.['date-parts'] ? { 'date-parts': m.issued['date-parts'] } : undefined,
    };
    return { status: 'verified', csl, via: 'crossref' };
  } catch {
    return { status: 'lookup_unavailable', via: 'crossref', message: 'Could not reach Crossref. The reference is saved as unverified.' };
  }
}

export async function lookupIsbn(isbn: string): Promise<Lookup> {
  const clean = isbn.replace(/[^0-9X]/gi, '');
  if (![10, 13].includes(clean.length)) return { status: 'not_found', via: 'openlibrary', message: 'ISBN must have 10 or 13 digits.' };
  try {
    const r = await fetcher(`https://openlibrary.org/isbn/${clean}.json`);
    if (r.status === 404) return { status: 'not_found', via: 'openlibrary', message: 'Open Library has no record of this ISBN.' };
    if (!r.ok) return { status: 'lookup_unavailable', via: 'openlibrary', message: `Open Library returned ${r.status}.` };
    const m: any = await r.json();
    const year = Number((m.publish_date ?? '').match(/\d{4}/)?.[0]);
    return { status: 'verified', via: 'openlibrary', csl: { type: 'book', title: m.title, publisher: m.publishers?.[0], ISBN: clean, issued: year ? { 'date-parts': [[year]] } : undefined, author: [] } };
  } catch {
    return { status: 'lookup_unavailable', via: 'openlibrary', message: 'Could not reach Open Library. The reference is saved as unverified.' };
  }
}

// ---------------------------------------------------------------- document checks

export type InText = { raw: string; start: number; end: number; author?: string; year?: string; number?: number };

export function findInTextCitations(text: string): InText[] {
  const out: InText[] = [];
  const body = bodyText(text);
  // (Author, 2020), (Author & Other, 2020; Third et al., 2019, p. 4)
  for (const m of body.matchAll(/\(([^()]*?\b\d{4}[a-z]?\b[^()]*?)\)/g)) {
    for (const part of m[1].split(';')) {
      const pm = /([\p{Lu}][\p{L}'’-]+)(?:\s+(?:et al\.?|&|and)\s*[\p{L}'’.-]*)?,?\s+(\d{4})[a-z]?/u.exec(part);
      if (pm) out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, author: pm[1], year: pm[2] });
    }
  }
  // Author (2020)
  for (const m of body.matchAll(/([\p{Lu}][\p{L}'’-]+)(?:\s+et al\.)?\s+\((\d{4})[a-z]?\)/gu)) out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, author: m[1], year: m[2] });
  // [1], [2, 3]
  for (const m of body.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\]/g)) for (const n of m[1].split(/[,–-]/)) out.push({ raw: m[0], start: m.index!, end: m.index! + m[0].length, number: Number(n.trim()) });
  return out;
}

const BIB_HEAD = /(^|\n)[ \t]*(references|reference list|bibliography|works cited|marejeo)[ \t]*:?[ \t]*(\n|$)/i;
function bodyText(text: string) {
  const m = BIB_HEAD.exec(text);
  return m ? text.slice(0, m.index) : text;
}
export function bibliographyEntries(text: string): string[] {
  const m = BIB_HEAD.exec(text);
  if (!m) return [];
  return text.slice(m.index + m[0].length).split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 10);
}

export type CitationIssue = { kind: 'missing_reference' | 'uncited_entry' | 'inconsistent_style' | 'may_need_attribution' | 'incomplete_reference' | 'unverified_reference'; message: string; start?: number; end?: number; detail?: string; certainty: 'definite' | 'possible' };

export function checkCitations(text: string, library: { csl: Csl; existence_status: string }[]): { citations: InText[]; entries: string[]; issues: CitationIssue[] } {
  const cites = findInTextCitations(text);
  const entries = bibliographyEntries(text);
  const issues: CitationIssue[] = [];
  const libKeys = library.map((r) => ({ family: (r.csl.author?.[0]?.family ?? '').toLowerCase(), year: String(r.csl.issued?.['date-parts']?.[0]?.[0] ?? '') }));

  for (const c of cites.filter((c) => c.author)) {
    const a = c.author!.toLowerCase();
    const inBib = entries.some((e) => e.toLowerCase().includes(a) && e.includes(c.year!));
    const inLib = libKeys.some((k) => k.family === a && k.year === c.year);
    if (!inBib && !inLib) issues.push({ kind: 'missing_reference', message: `"${c.raw}" has no matching entry in the reference list.`, start: c.start, end: c.end, certainty: 'definite' });
  }
  const numeric = cites.filter((c) => c.number !== undefined);
  for (const c of numeric) if (entries.length && c.number! > entries.length) issues.push({ kind: 'missing_reference', message: `Citation [${c.number}] has no entry ${c.number} in the reference list.`, start: c.start, end: c.end, certainty: 'definite' });
  if (numeric.length && cites.some((c) => c.author)) issues.push({ kind: 'inconsistent_style', message: 'The document mixes numbered citations ([1]) and author–date citations (Author, 2020).', certainty: 'definite' });

  if (!numeric.length) {
    for (const e of entries) {
      const year = e.match(/\b(19|20)\d{2}\b/)?.[0];
      const surname = e.match(/^([\p{Lu}][\p{L}'’-]+)/u)?.[1];
      if (!year || !surname) continue;
      const cited = cites.some((c) => c.author?.toLowerCase() === surname.toLowerCase() && c.year === year);
      if (!cited) issues.push({ kind: 'uncited_entry', message: `Reference "${e.slice(0, 80)}${e.length > 80 ? '…' : ''}" is not cited in the text.`, certainty: 'possible', detail: 'Matched on first author surname and year; check manually if the author is cited differently.' });
    }
  }

  // Passages that may need attribution: quotations or statistics without a nearby citation.
  const body = bodyText(text);
  for (const m of body.matchAll(/"[^"\n]{20,}"|“[^”\n]{20,}”/g)) {
    const after = body.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
    const before = body.slice(Math.max(0, m.index! - 60), m.index!);
    if (!/\(\D*\d{4}|\[\d+\]/.test(after) && !/\(\d{4}\)/.test(before)) issues.push({ kind: 'may_need_attribution', message: 'This quotation has no citation next to it.', start: m.index!, end: m.index! + m[0].length, certainty: 'possible' });
  }
  for (const m of body.matchAll(/[^.!?\n]*\b\d+(?:\.\d+)?\s?(?:%|percent)[^.!?\n]*[.!?]/g)) {
    if (!/\(\D*\d{4}|\[\d+\]/.test(m[0])) issues.push({ kind: 'may_need_attribution', message: 'This statistic has no citation. If it comes from a source, cite it.', start: m.index!, end: m.index! + m[0].length, certainty: 'possible', detail: 'If this is your own result, no citation is needed.' });
  }
  for (const r of library) {
    const miss = missingFields(r.csl);
    if (miss.length) issues.push({ kind: 'incomplete_reference', message: `"${r.csl.title ?? 'Untitled reference'}" is missing: ${miss.join(', ')}.`, certainty: 'definite' });
    if (r.existence_status !== 'verified') issues.push({ kind: 'unverified_reference', message: `"${r.csl.title ?? 'Untitled reference'}" has not been verified against a registry.`, certainty: 'definite' });
  }
  return { citations: cites, entries, issues };
}
