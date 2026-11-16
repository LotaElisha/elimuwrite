/**
 * File import. Uploaded files are untrusted: type is detected from magic bytes, size is
 * limited, markup is sanitised, and parsing failures are surfaced, never hidden.
 * The original file is preserved in object storage; the editable version is separate.
 */
import mammoth from 'mammoth';
// @ts-ignore
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Extracts text with pdf.js; a line break is kept wherever pdf.js reports end-of-line. */
async function pdfText(buf: Buffer): Promise<{ text: string; numpages: number }> {
  const task = getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // A vertical jump larger than ~1.6 line heights is treated as a paragraph break.
      let out = '', lastY: number | null = null, lastH = 12;
      for (const it of content.items as any[]) {
        if (!('str' in it)) continue;
        const y = it.transform?.[5];
        if (lastY !== null && typeof y === 'number' && it.str.trim() && Math.abs(lastY - y) > lastH * 1.6 && !out.endsWith('\n\n')) out = out.replace(/\n?$/, '\n\n');
        out += it.str + (it.hasEOL ? '\n' : '');
        if (it.str.trim() && typeof y === 'number') { lastY = y; lastH = it.height || lastH; }
      }
      pages.push(out);
    }
    return { text: pages.join('\n\n'), numpages: doc.numPages };
  } finally {
    await task.destroy();
  }
}
import { sanitize, htmlToText, textToHtml } from './text.js';

export type Extraction =
  | { status: 'needs_review'; type: string; html: string; text: string; warnings: string[] }
  | { status: 'needs_ocr'; type: string; warnings: string[]; message: string }
  | { status: 'failed'; type: string; error: string };

export function detectType(buf: Buffer, filename: string): 'pdf' | 'docx' | 'txt' | 'unsupported' {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && /\.docx$/i.test(filename)) return 'docx';
  if (/\.(txt|md|text)$/i.test(filename) || !filename.includes('.')) {
    if (buf.includes(0)) return 'unsupported';
    return 'txt';
  }
  return 'unsupported';
}

export async function extract(buf: Buffer, filename: string): Promise<Extraction> {
  const type = detectType(buf, filename);
  try {
    if (type === 'txt') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      const html = textToHtml(text);
      return finish(type, html, ['Plain text has no formatting; paragraphs are split on blank lines.']);
    }
    if (type === 'docx') {
      const r = await mammoth.convertToHtml({ buffer: buf });
      const warnings = ['Images, text boxes, footnotes, tracked changes, comments, and page layout are not carried into the editable version. The original file is kept unchanged.'];
      if (r.messages.length) warnings.push(`${r.messages.length} formatting element(s) could not be converted exactly.`);
      return finish(type, sanitize(r.value), warnings);
    }
    if (type === 'pdf') {
      const r = await pdfText(buf);
      const pages = Math.max(1, r.numpages ?? 1);
      const chars = (r.text ?? '').replace(/\s+/g, '').length;
      if (chars / pages < 40) {
        return {
          status: 'needs_ocr',
          type,
          warnings: [`Only ${chars} characters of text were found across ${pages} page(s).`],
          message: 'This looks like a scanned PDF. It needs OCR before it can be analysed. It has NOT been treated as an empty document.',
        };
      }
      // Re-flow lines into paragraphs: blank lines (or lines ending a sentence followed by a short line) separate paragraphs.
      const text = (r.text as string).replace(/-\n(?=\p{Ll})/gu, '').replace(/([^\n])\n(?!\n)/g, '$1 ').replace(/[ \t]+/g, ' ');
      return finish(type, textToHtml(text), ['PDF layout (columns, headers, footers, tables) may not convert exactly. Please review the extracted text before analysis.']);
    }
    return { status: 'failed', type, error: 'Unsupported file type. Use TXT, DOCX, or a text-based PDF.' };
  } catch (e: any) {
    return { status: 'failed', type, error: `The file could not be read (${String(e?.message ?? e).slice(0, 120)}). Nothing was imported.` };
  }
}

function finish(type: string, html: string, warnings: string[]): Extraction {
  const text = htmlToText(html);
  if (!text.trim()) return { status: 'failed', type, error: 'No text could be extracted from this file. It has not been imported as an empty document.' };
  return { status: 'needs_review', type, html, text, warnings };
}
