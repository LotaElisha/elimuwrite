import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, WidthType } from 'docx';
import { Parser } from 'htmlparser2';

type Block = { kind: 'p' | 'h1' | 'h2' | 'h3' | 'li' | 'table'; runs: { text: string; bold?: boolean; italics?: boolean }[]; rows?: string[][]; ordered?: boolean };

/** Converts sanitised editor HTML into simple blocks for DOCX export. */
function blocks(html: string): Block[] {
  const out: Block[] = [];
  let cur: Block | null = null;
  let bold = 0, ital = 0;
  let table: string[][] | null = null;
  let cell: string | null = null;
  const listStack: string[] = [];
  const p = new Parser({
    onopentag(name) {
      if (name === 'table') table = [];
      else if (name === 'tr' && table) table.push([]);
      else if ((name === 'td' || name === 'th') && table) cell = '';
      else if (name === 'ul' || name === 'ol') listStack.push(name);
      else if (['p', 'h1', 'h2', 'h3', 'h4', 'li', 'pre', 'blockquote'].includes(name) && !table) {
        if (name === 'p' && cur?.kind === 'li' && cur.runs.length === 0) return;
        cur = { kind: name === 'li' ? 'li' : name === 'h1' ? 'h1' : name === 'h2' ? 'h2' : name === 'h3' || name === 'h4' ? 'h3' : 'p', runs: [], ordered: listStack[listStack.length - 1] === 'ol' };
        out.push(cur);
      } else if (name === 'strong' || name === 'b') bold++;
      else if (name === 'em' || name === 'i') ital++;
      else if (name === 'br' && cur) cur.runs.push({ text: '\n' });
    },
    ontext(t) {
      if (cell !== null) cell += t;
      else if (cur) cur.runs.push({ text: t, bold: bold > 0, italics: ital > 0 });
      else if (t.trim()) { cur = { kind: 'p', runs: [{ text: t }] }; out.push(cur); }
    },
    onclosetag(name) {
      if ((name === 'td' || name === 'th') && table && cell !== null) { table[table.length - 1].push(cell); cell = null; }
      else if (name === 'table' && table) { out.push({ kind: 'table', runs: [], rows: table }); table = null; }
      else if (name === 'ul' || name === 'ol') listStack.pop();
      else if (name === 'strong' || name === 'b') bold--;
      else if (name === 'em' || name === 'i') ital--;
      else if (['p', 'h1', 'h2', 'h3', 'h4', 'li', 'pre', 'blockquote'].includes(name)) { if (name !== 'p' || cur?.kind !== 'li') cur = null; }
    },
  }, { decodeEntities: true });
  p.write(html);
  p.end();
  return out;
}

export async function toDocx(title: string, html: string, bibliography: string): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const b of blocks(html)) {
    if (b.kind === 'table' && b.rows?.length) {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph(c)] })) })),
      }));
      continue;
    }
    const runs = b.runs.map((r) => new TextRun({ text: r.text, bold: r.bold, italics: r.italics, break: r.text === '\n' ? 1 : undefined }));
    if (b.kind === 'li') children.push(new Paragraph({ children: runs, bullet: { level: 0 } }));
    else if (b.kind === 'p') children.push(new Paragraph({ children: runs }));
    else children.push(new Paragraph({ children: runs, heading: b.kind === 'h1' ? HeadingLevel.HEADING_1 : b.kind === 'h2' ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3 }));
  }
  if (bibliography) {
    children.push(new Paragraph({ text: 'References', heading: HeadingLevel.HEADING_1 }));
    for (const line of bibliography.split('\n').filter(Boolean)) children.push(new Paragraph(line));
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}
