import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { Badge, ErrorBox, Notice, Pct, useAsync } from '../components/ui';

const SAMPLE = `Rainwater harvesting has become an important adaptation strategy for smallholder farmers in semi-arid regions of central Tanzania. In order to understand it better, i visited three villages. Many families recieve support from savings groups, and the the tanks they build last for years.`;

export function Highlighted({ text, ranges }: { text: string; ranges: { start: number; end: number; label?: string; cls?: string }[] }) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let cur = 0;
  sorted.forEach((r, i) => {
    if (r.start < cur) return;
    out.push(text.slice(cur, r.start));
    out.push(<mark key={i} className={r.cls ?? 'match'}>{r.label && <sup>[{r.label}]</sup>}{text.slice(r.start, r.end)}</mark>);
    cur = r.end;
  });
  out.push(text.slice(cur));
  return <div className="doc-text">{out}</div>;
}

export default function Home() {
  const { t } = useI18n();
  const { config, me } = useSession();
  const [text, setText] = useState('');
  const [res, setRes] = useState<any>(null);
  const a = useAsync();
  const tools = [
    { k: 'writing', title: 'Writing checks', body: 'Spelling, grammar, punctuation, clarity, concision and tone, with a short explanation for every suggestion and an optional learning mode.' },
    { k: 'similarity', title: 'Source similarity', body: 'Compare your work with the reference documents you choose, or your institution’s authorised repository. See exactly which passages overlap and why.' },
    { k: 'citations', title: 'Citations & references', body: 'Build a reference library, format APA, MLA, Chicago, Harvard and IEEE, check DOIs, and find missing or uncited references.' },
    { k: 'feedback', title: 'Rewrite & summarize', body: 'Concise and Simple rewrites that keep numbers, names, quotations and citations, plus extractive summaries linked to the original passages.' },
    { k: 'feedback', title: 'Assignments & feedback', body: 'Courses, assignments with assistance policies, frozen submissions with receipts, rubric marking and instructor-approved feedback release.' },
  ];
  return (
    <>
      <section className="hero">
        <div className="hero-inner">
          <div>
            <h1>{t('hero.title')}</h1>
            <p>{t('hero.body')}</p>
            <div className="row">
              <a className="btn teal" href="#demo">{t('hero.try')}</a>
              {!me && <Link className="btn" to="/register">{t('hero.individual')}</Link>}
              <Link className="btn" to={me ? '/institutions/new' : '/register?next=/institutions/new'}>{t('hero.institution')}</Link>
            </div>
          </div>
          <div className="card" style={{ color: 'var(--text)' }}>
            <h2 style={{ marginTop: 0 }}>Product tour</h2>
            <ol className="stack" style={{ paddingLeft: 18 }}>
              <li><strong>Write or import</strong> a document (paste, TXT, DOCX or text-based PDF).</li>
              <li><strong>Improve</strong> it with explained writing suggestions you accept or reject.</li>
              <li><strong>Check sources</strong> against reference documents and review every match.</li>
              <li><strong>Fix citations</strong> and generate a bibliography in your style.</li>
              <li><strong>Export</strong> DOCX, PDF or TXT, plus a branded PDF report, or submit to your course.</li>
            </ol>
          </div>
        </div>
      </section>
      <div className="page">
        <section id="demo" className="card" aria-labelledby="demo-h">
          <div className="row between"><h2 id="demo-h">{t('demo.title')}</h2><Badge kind="info">Guest demo</Badge></div>
          <Notice>{t('demo.note')}</Notice>
          <label className="sr-only" htmlFor="demo-text">Text to check</label>
          <textarea id="demo-text" value={text} maxLength={config?.guestDemo?.maxChars ?? 3000} onChange={(e) => setText(e.target.value)} placeholder="Paste up to 3,000 characters…" rows={7} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setText(SAMPLE)}>{t('demo.loadSample')}</button>
            <button className="btn primary" disabled={!text.trim() || a.busy} onClick={() => a.run(async () => setRes(await api('/demo/check', { body: { text } })))}>{a.busy ? '…' : t('demo.check')}</button>
            <span className="muted small">{text.length} / {config?.guestDemo?.maxChars ?? 3000}</span>
          </div>
          {a.error ? <ErrorBox error={a.error} /> : null}
          {res && (
            <div className="grid cols-2" style={{ marginTop: 16 }}>
              <div>
                <div className="kind-label kind-writing">Writing</div>
                {res.writing.status === 'unsupported_language' ? <Notice kind="warn">Swahili writing analysis is not available yet. No suggestions were generated.</Notice> : (
                  <>
                    {res.writing.suggestions.length === 0 && <p className="muted">No rule-based issues found.</p>}
                    {res.writing.suggestions.map((s: any, i: number) => (
                      <div className="sugg" key={i}><div className="kind-label kind-writing">{s.category.replace('_', ' ')}</div>
                        <span className="orig">{s.original}</span>{s.replacement !== null && <> → <span className="repl">{s.replacement || '(remove)'}</span></>}<div className="muted small">{s.explanation}</div></div>
                    ))}
                  </>
                )}
              </div>
              <div>
                <div className="kind-label kind-similarity">Similarity (sample collection only)</div>
                <div className="big-pct"><Pct value={res.similarity.percentage} /></div>
                <p>{res.similarity.status === 'completed' && res.similarity.percentage === 0 ? t('sim.zero') : res.similarity.message}</p>
                {res.similarity.sources.map((s: any) => <div key={s.sourceId} className="small">• {s.title}: {s.percentage}%</div>)}
                <Highlighted text={text} ranges={res.similarity.matches.map((m: any) => ({ start: m.start, end: m.end }))} />
                <p className="muted small">{res.notice}</p>
              </div>
            </div>
          )}
        </section>

        <h2 id="tools" style={{ marginTop: 40 }}>Tools</h2>
        <div className="grid cols-3">
          {tools.map((x) => (
            <div className="card tool-card" key={x.title}><h3><span className="dot" style={{ background: `var(--c-${x.k})` }} aria-hidden />{x.title}</h3><p className="muted">{x.body}</p></div>
          ))}
        </div>

        <h2 style={{ marginTop: 40 }}>What is connected today</h2>
        <div className="card">
          <p className="muted small">Features that need an external provider show their real status. Nothing here is simulated.</p>
          <table className="data"><tbody>
            {(config?.providers ?? []).map((p: any) => (
              <tr key={p.key}><td>{p.name}</td><td>{p.status === 'configured' ? <Badge kind="ok">Configured</Badge> : <Badge kind="warn">{t('common.notConfigured')}</Badge>}</td><td className="muted small">{p.detail}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="row" style={{ marginTop: 24 }}>
          <Link className="btn" to="/pricing">{t('nav.pricing')}</Link>
          {!me && <Link className="btn primary" to="/register">{t('nav.signup')}</Link>}
        </div>
      </div>
    </>
  );
}
