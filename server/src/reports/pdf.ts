import PDFDocument from 'pdfkit';
import { config } from '../config.js';

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function header(doc: PDFKit.PDFDocument, title: string, sub: string) {
  doc.rect(0, 0, doc.page.width, 70).fill(config.brand.primaryColor);
  doc.fillColor('#ffffff').fontSize(18).text(config.brand.name, 50, 22);
  doc.fontSize(9).text(config.brand.tagline, 50, 46);
  doc.fillColor('#14284b').fontSize(16).text(title, 50, 90);
  doc.fontSize(9).fillColor('#555555').text(sub);
  doc.moveDown();
}

function kv(doc: PDFKit.PDFDocument, rows: [string, string][]) {
  for (const [k, v] of rows) {
    doc.fontSize(9).fillColor('#555555').text(k + ': ', { continued: true }).fillColor('#111111').text(v);
  }
  doc.moveDown(0.5);
}

export type SimilarityPdfInput = {
  reportNumber: string;
  documentTitle: string;
  versionNo: number;
  versionHash: string;
  scannedAt: Date;
  status: string;
  message: string;
  original: { percentage: number | null; matched: number; eligible: number };
  adjusted: { percentage: number | null; matched: number; eligible: number };
  settings: Record<string, any>;
  scope: string;
  exclusions: { what: string; reason: string; by: string; at: string }[];
  sources: { label: string; percentage: number; matchedTokens: number; url?: string | null }[];
  text: string;
  highlights: { start: number; end: number; sourceIndex: number; excluded: boolean }[];
  audience: string;
};

const PALETTE = ['#f4c95d', '#8fd3c7', '#f2a08a', '#b9b3f2', '#9ccbf2', '#d8e28a'];

export async function similarityPdf(r: SimilarityPdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `Similarity report ${r.reportNumber}` } });
  const done = collect(doc);
  header(doc, 'Source similarity report', `Report ${r.reportNumber} · prepared for ${r.audience}`);
  const pct = (p: number | null) => (p === null ? 'Not enough eligible text' : `${p}%`);
  kv(doc, [
    ['Document', `${r.documentTitle} (version ${r.versionNo})`],
    ['Version fingerprint (SHA-256)', r.versionHash.slice(0, 32) + '…'],
    ['Scanned', r.scannedAt.toISOString()],
    ['Result', r.message],
    ['Original similarity', `${pct(r.original.percentage)} (${r.original.matched} of ${r.original.eligible} eligible words)`],
    ['Adjusted similarity (after reviewer exclusions)', `${pct(r.adjusted.percentage)} (${r.adjusted.matched} of ${r.adjusted.eligible} eligible words)`],
    ['Source collection checked', r.scope],
    ['Settings', `minimum match ${r.settings.minMatchWords} words; quotations ${r.settings.excludeQuotes ? 'excluded' : 'included'}; bibliography ${r.settings.excludeBibliography ? 'excluded' : 'included'}`],
  ]);
  doc.fontSize(11).fillColor('#14284b').text('How to read this report');
  doc.fontSize(8.5).fillColor('#333333').text(
    'The percentage is 100 × uniquely matched eligible words ÷ all eligible words. Overlapping matches are counted once. It describes overlap only with the sources and settings listed above. A result does not establish plagiarism or misconduct, and a zero result means no qualifying matches were found in the checked sources, not that the work is guaranteed original. Matches are evidence for a human reviewer.',
  );
  doc.moveDown();
  doc.fontSize(11).fillColor('#14284b').text('Matching sources');
  if (!r.sources.length) doc.fontSize(9).fillColor('#333333').text('None.');
  r.sources.forEach((s, i) => {
    doc.rect(doc.x, doc.y + 2, 8, 8).fill(PALETTE[i % PALETTE.length]);
    doc.fillColor('#111111').fontSize(9).text(`   [${i + 1}] ${s.label}: ${s.percentage}% (${s.matchedTokens} words)${s.url ? ' · ' + s.url : ''}`);
  });
  doc.moveDown();
  if (r.exclusions.length) {
    doc.fontSize(11).fillColor('#14284b').text('Reviewer exclusions');
    for (const e of r.exclusions) doc.fontSize(9).fillColor('#333333').text(`• ${e.what}: ${e.reason} (${e.by}, ${e.at})`);
    doc.moveDown();
  }
  doc.addPage();
  doc.fontSize(11).fillColor('#14284b').text('Document with highlighted matches');
  doc.fontSize(8).fillColor('#555555').text('Highlighted passages match the numbered source. Struck-through highlights were excluded and do not count. Colour is paired with the [n] label.');
  doc.moveDown(0.5);
  const hs = [...r.highlights].sort((a, b) => a.start - b.start);
  let cur = 0;
  doc.fontSize(9.5).fillColor('#111111');
  const segs: { t: string; h?: (typeof hs)[number] }[] = [];
  for (const h of hs) {
    if (h.start < cur) continue;
    if (h.start > cur) segs.push({ t: r.text.slice(cur, h.start) });
    segs.push({ t: r.text.slice(h.start, h.end), h });
    cur = h.end;
  }
  segs.push({ t: r.text.slice(cur) });
  segs.forEach((s, i) => {
    const last = i === segs.length - 1;
    if (s.h) {
      doc.fillColor('#111111').text(`[${s.h.sourceIndex + 1}]`, { continued: true });
      doc.text(s.t, { continued: !last, highlight: !s.h.excluded, strike: s.h.excluded } as any);
    } else doc.fillColor('#111111').text(s.t, { continued: !last });
  });
  footer(doc, r.reportNumber);
  doc.end();
  return done;
}

export async function writingPdf(r: { reportNumber: string; documentTitle: string; versionNo: number; scannedAt: Date; result: any; audience: string }) {
  const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true, info: { Title: `Writing feedback ${r.reportNumber}` } });
  const done = collect(doc);
  header(doc, 'Writing feedback report', `Report ${r.reportNumber} · prepared for ${r.audience}`);
  kv(doc, [['Document', `${r.documentTitle} (version ${r.versionNo})`], ['Checked', r.scannedAt.toISOString()], ['Engine', 'Rule-based English checks (local). Not a statistical grammar model.']]);
  if (r.result.status === 'unsupported_language') doc.fontSize(10).text(r.result.message);
  const rd = r.result.readability;
  if (rd) doc.fontSize(9).text(rd.available ? `Flesch Reading Ease ${rd.fleschReadingEase}; average sentence length ${rd.averageSentenceLength} words. ${rd.method}` : `Readability unavailable: ${rd.reason}`);
  doc.moveDown();
  for (const s of r.result.suggestions ?? []) {
    doc.fontSize(9).fillColor('#14284b').text(`${s.category}: `, { continued: true }).fillColor('#111111').text(`"${s.original}"${s.replacement !== null ? ` → "${s.replacement}"` : ''} — ${s.explanation}`);
  }
  footer(doc, r.reportNumber);
  doc.end();
  return done;
}

function footer(doc: PDFKit.PDFDocument, id: string) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.fontSize(7).fillColor('#888888').text(`${config.brand.name} · ${id} · page ${i + 1} of ${range.count}`, 50, doc.page.height - 40, { lineBreak: false });
  }
}

/** Simple, readable PDF export of an edited document. */
export async function documentPdf(title: string, text: string, bibliography: string) {
  const doc = new PDFDocument({ size: 'A4', margin: 60, bufferPages: true, info: { Title: title } });
  const done = collect(doc);
  doc.fontSize(18).fillColor('#111111').text(title);
  doc.moveDown();
  for (const para of text.split(/\n\n/)) {
    doc.fontSize(11).text(para, { align: 'left' });
    doc.moveDown(0.6);
  }
  if (bibliography) {
    doc.moveDown().fontSize(13).text('References').moveDown(0.5);
    doc.fontSize(10).text(bibliography);
  }
  doc.end();
  return done;
}
