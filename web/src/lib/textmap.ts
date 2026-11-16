import type { Node as PMNode } from '@tiptap/pm/model';

/**
 * Maps between plain-text offsets (as computed by the server: blocks separated by "\n\n",
 * hard breaks as "\n") and ProseMirror positions. Used to apply suggestions and to select
 * passages referenced by analysis results.
 */
type Seg = { from: number; to: number; pos: number; br?: boolean };

export function buildSegments(doc: PMNode): { segs: Seg[]; length: number } {
  const segs: Seg[] = [];
  let len = 0;
  let first = true;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (!first) len += 2;
      first = false;
      return true;
    }
    if (node.isText) {
      segs.push({ from: len, to: len + node.text!.length, pos });
      len += node.text!.length;
      return false;
    }
    if (node.type.name === 'hardBreak') {
      segs.push({ from: len, to: len + 1, pos, br: true });
      len += 1;
      return false;
    }
    return true;
  });
  return { segs, length: len };
}

export function offsetToPos(doc: PMNode, offset: number): number | null {
  const { segs } = buildSegments(doc);
  for (const s of segs) {
    if (s.br) {
      if (offset === s.from) return s.pos;
      continue;
    }
    if (offset >= s.from && offset <= s.to) return s.pos + (offset - s.from);
  }
  return null;
}

/** Range for [start,end) only if its text still equals `expected`; otherwise null (stale: never guess another passage). */
export function locate(doc: PMNode, start: number, end: number, expected: string): { from: number; to: number } | null {
  const from = offsetToPos(doc, start);
  const to = offsetToPos(doc, end);
  if (from !== null && to !== null && doc.textBetween(from, to, '\n\n', '\n') === expected) return { from, to };
  return null;
}
