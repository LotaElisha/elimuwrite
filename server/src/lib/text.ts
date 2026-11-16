import { Parser } from 'htmlparser2';
import sanitizeHtml from 'sanitize-html';
import { createHash } from 'node:crypto';

/** Allowed editor markup. Everything else is stripped (uploaded/pasted content is untrusted). */
export function sanitize(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'code', 'pre', 'blockquote', 'br', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'sup', 'sub'],
    allowedAttributes: { a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
  });
}

const TEXTBLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);
const CONTAINERS = new Set(['li', 'td', 'th', 'blockquote']);

/**
 * Canonical plain text of an editor document. Mirrors the editor's
 * getText({ blockSeparator: '\n\n' }) so offsets agree between server analysis
 * and client highlighting: a separator precedes every textblock except the first.
 */
export function htmlToText(html: string): string {
  let out = '';
  let first = true;
  let depth = 0; // inside a textblock
  let implicitOpen = false; // inline text directly inside li/td without <p>
  const stack: string[] = [];
  const startBlock = () => {
    if (first) first = false;
    else out += '\n\n';
  };
  const parser = new Parser(
    {
      onopentag(name) {
        stack.push(name);
        if (TEXTBLOCKS.has(name)) {
          implicitOpen = false;
          depth++;
          startBlock();
        } else if (name === 'br' && (depth > 0 || implicitOpen)) {
          out += '\n';
        } else if (CONTAINERS.has(name)) {
          implicitOpen = false;
        }
      },
      ontext(t) {
        if (depth > 0) out += t;
        else if (t.trim()) {
          if (!implicitOpen) {
            startBlock();
            implicitOpen = true;
          }
          out += t;
        }
      },
      onclosetag(name) {
        stack.pop();
        if (TEXTBLOCKS.has(name)) depth--;
        if (CONTAINERS.has(name)) implicitOpen = false;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return out.replace(/ /g, ' ');
}

export function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Plain text → simple paragraph HTML (used for TXT/PDF imports). */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) ?? []).length;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function contentHash(html: string, text: string) {
  return sha256(html + '\u0000' + text);
}
