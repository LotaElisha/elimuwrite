import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { config, providerStatuses } from '../config.js';
import { analyze, describeOutcome, tokenize } from '../engines/similarity.js';
import { checkText, readability, detectLanguage, LESSONS } from '../engines/grammar.js';
import { STYLES } from '../engines/citations.js';
import { PRESETS } from '../engines/policy.js';
import { MODES, LOCAL_MODES } from '../engines/rewrite.js';
import { HttpError } from '../lib/misc.js';

let demoCorpus: { id: string; title: string; text: string; tokens: ReturnType<typeof tokenize> }[] | null = null;

export async function publicRoutes(app: FastifyInstance) {
  app.get('/health', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  app.get('/config', async () => ({
    brand: config.brand,
    providers: providerStatuses(),
    citationStyles: Object.entries(STYLES).map(([key, v]) => ({ key, label: v.label })),
    assistancePresets: Object.entries(PRESETS).map(([key, v]) => ({ key, label: v.label, policy: v.policy })),
    rewriteModes: MODES.map((m) => ({ key: m, local: LOCAL_MODES.includes(m) })),
    languages: {
      interface: ['en', 'sw'],
      analysis: [
        { code: 'en', grammar: 'available (rule-based)', similarity: 'available', rewriting: 'local Concise/Simple; other modes need AI provider' },
        { code: 'sw', grammar: 'unavailable (pending evaluation)', similarity: 'available (lexical matching is language-neutral but not separately validated)', rewriting: 'unavailable' },
      ],
    },
    guestDemo: { maxChars: config.guestDemo.maxChars, retention: 'Guest text is processed in memory to produce the result and is not stored.' },
  }));

  app.get('/plans', async () => {
    const r = await pool.query(`select code, name, audience, prices, limits, features from plans where active order by (limits->>'seats')::int nulls first, code`);
    return r.rows;
  });

  app.get('/lessons/:rule', async (req) => {
    const l = LESSONS[(req.params as any).rule];
    if (!l) throw new HttpError(404, 'not_found', 'No lesson for this rule');
    return l;
  });

  // Rate-limited guest demonstration. Text is not persisted.
  app.post('/demo/check', { config: { rateLimit: { max: config.guestDemo.perMinute, timeWindow: '1 minute' } } }, async (req) => {
    const { text } = z.object({ text: z.string().min(1).max(config.guestDemo.maxChars) }).parse(req.body);
    if (!demoCorpus) {
      const r = await pool.query(`select id, title, content_text from sources where scope='demo'`);
      demoCorpus = r.rows.map((x: any) => ({ id: x.id, title: x.title, text: x.content_text, tokens: tokenize(x.content_text) }));
    }
    const lang = detectLanguage(text);
    const sim = analyze(text, demoCorpus, { excludeQuotes: true, excludeBibliography: true, minMatchWords: 8 });
    const outcome = describeOutcome(sim.score, demoCorpus.length);
    return {
      notice: 'Demonstration only. Your text was processed in memory and has not been saved. Matches are checked against a small sample collection.',
      language: lang,
      writing: lang === 'sw' ? { status: 'unsupported_language', suggestions: [] } : { status: 'completed', suggestions: checkText(text, { variant: 'en-US' }), readability: readability(text) },
      similarity: {
        ...outcome,
        percentage: sim.score.percentage,
        sources: sim.score.bySource.map((s) => ({ ...s, title: demoCorpus!.find((d) => d.id === s.sourceId)?.title })),
        matches: sim.runs.map((r) => ({ start: r.docCharStart, end: r.docCharEnd, sourceId: r.sourceId })),
      },
    };
  });
}

export function resetDemoCorpus() {
  demoCorpus = null;
}
