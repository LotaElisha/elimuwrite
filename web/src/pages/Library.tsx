import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, download, fmtDate } from '../lib/api';
import { Badge, ErrorBox, Field, Load, Notice, useAsync, useLoad, Empty } from '../components/ui';
import { ImportPanel } from './Documents';

export default function Library() {
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') ?? 'refs';
  return (
    <div className="page">
      <h1>References & sources</h1>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'refs'} onClick={() => setSp({ tab: 'refs' })}>Reference library</button>
        <button role="tab" aria-selected={tab === 'sources'} onClick={() => setSp({ tab: 'sources' })}>Reference documents for similarity</button>
      </div>
      <div style={{ marginTop: 16 }}>{tab === 'refs' ? <Refs /> : <Sources />}</div>
    </div>
  );
}

function Refs() {
  const s = useLoad(() => api('/refs'));
  const [mode, setMode] = useState<'doi' | 'isbn' | 'manual'>('doi');
  const [f, setF] = useState({ doi: '', isbn: '', title: '', authors: '', year: '', container: '', publisher: '', url: '', type: 'article-journal', tags: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const a = useAsync();
  const add = () => a.run(async () => {
    const tags = f.tags.split(',').map((x) => x.trim()).filter(Boolean);
    const csl = mode === 'manual' ? {
      type: f.type, title: f.title || undefined, URL: f.url || undefined, 'container-title': f.container || undefined, publisher: f.publisher || undefined,
      author: f.authors ? f.authors.split(';').map((n) => { const [family, given] = n.split(',').map((x) => x.trim()); return { family, given }; }) : undefined,
      issued: f.year ? { 'date-parts': [[Number(f.year)]] } : undefined,
    } : undefined;
    const r = await api('/refs', { body: { doi: mode === 'doi' ? f.doi : undefined, isbn: mode === 'isbn' ? f.isbn : undefined, csl, tags } });
    setMsg(r.lookup_message ?? (r.checks.exists === 'verified' ? 'Found in the registry. Metadata filled from the registry; please check it.' : 'Saved as unverified, user-entered metadata.'));
    s.reload();
  });
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(280px,1fr)' }}>
      <section className="card">
        <div className="row between"><h2>Library</h2><div className="row"><button className="btn sm" onClick={() => download('/refs/export?format=bibtex')}>Export BibTeX</button><button className="btn sm" onClick={() => download('/refs/export?format=ris')}>Export RIS</button></div></div>
        <Notice>Three separate checks: does the source <strong>exist</strong>; is its <strong>metadata</strong> accurate; does it <strong>support your claim</strong>. A verified DOI only answers the first.</Notice>
        <Load state={s}>{(refs: any[]) => refs.length === 0 ? <Empty>No references yet.</Empty> : (
          <div className="stack">{refs.map((r) => <RefRow key={r.id} r={r} onChange={s.reload} />)}</div>
        )}</Load>
      </section>
      <section className="card">
        <h2>Add reference</h2>
        <div className="tabs" role="tablist">{(['doi', 'isbn', 'manual'] as const).map((m) => <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}>{m === 'manual' ? 'Manual / URL' : m.toUpperCase()}</button>)}</div>
        <div style={{ marginTop: 10 }}>
          {mode === 'doi' && <Field label="DOI"><input value={f.doi} onChange={(e) => setF({ ...f, doi: e.target.value })} placeholder="10.xxxx/…" /></Field>}
          {mode === 'isbn' && <Field label="ISBN"><input value={f.isbn} onChange={(e) => setF({ ...f, isbn: e.target.value })} /></Field>}
          {mode === 'manual' && <>
            <Field label="Type"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="article-journal">Journal article</option><option value="book">Book</option><option value="chapter">Book chapter</option><option value="webpage">Web page</option><option value="report">Report</option><option value="thesis">Thesis</option></select></Field>
            <Field label="Title"><input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
            <Field label="Authors" hint="Family, Given; Family, Given"><input value={f.authors} onChange={(e) => setF({ ...f, authors: e.target.value })} /></Field>
            <Field label="Year"><input inputMode="numeric" value={f.year} onChange={(e) => setF({ ...f, year: e.target.value })} /></Field>
            <Field label="Journal / container"><input value={f.container} onChange={(e) => setF({ ...f, container: e.target.value })} /></Field>
            <Field label="Publisher"><input value={f.publisher} onChange={(e) => setF({ ...f, publisher: e.target.value })} /></Field>
            <Field label="URL"><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
          </>}
          <Field label="Tags" hint="Comma-separated"><input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
          <button className="btn primary" disabled={a.busy} onClick={add}>{mode === 'manual' ? 'Save reference' : 'Look up and save'}</button>
          {msg && <Notice>{msg}</Notice>}
          {a.error ? <ErrorBox error={a.error} /> : null}
        </div>
      </section>
    </div>
  );
}

function RefRow({ r, onChange }: { r: any; onChange: () => void }) {
  const [verify, setVerify] = useState<any>(null);
  const authors = (r.csl.author ?? []).map((a: any) => a.family).join(', ');
  const year = r.csl.issued?.['date-parts']?.[0]?.[0];
  return (
    <div className="sugg citations">
      <div><strong>{r.csl.title ?? <em>Untitled</em>}</strong> {authors && `· ${authors}`} {year && `(${year})`}</div>
      <div className="row small" style={{ margin: '4px 0' }}>
        <Badge kind={r.checks.exists === 'verified' ? 'ok' : r.checks.exists === 'not_found' ? 'bad' : 'warn'}>Exists: {r.checks.exists.replace('_', ' ')}</Badge>
        <Badge kind={r.checks.metadata === 'incomplete' ? 'bad' : 'neutral'}>Metadata: {r.checks.metadata.replace('_', ' ')}</Badge>
        <label>Supports my claim: <select value={r.support_status} onChange={async (e) => { await api(`/refs/${r.id}`, { method: 'PATCH', body: { support_status: e.target.value } }); onChange(); }}><option value="not_assessed">not assessed</option><option value="user_confirmed">I checked: yes</option><option value="disputed">doubtful</option></select></label>
      </div>
      {r.missing_fields.length > 0 && <div className="small">Missing: {r.missing_fields.join(', ')}</div>}
      {r.tags.length > 0 && <div className="small">{r.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</div>}
      <div className="row">
        {(r.doi || r.isbn) && <button className="btn sm" onClick={async () => { setVerify(await api(`/refs/${r.id}/verify`, { method: 'POST' })); onChange(); }}>Verify {r.doi ? 'DOI' : 'ISBN'}</button>}
        <button className="btn sm ghost danger" onClick={async () => { await api(`/refs/${r.id}`, { method: 'DELETE' }); onChange(); }}>Delete</button>
        <span className="small muted">{r.verified_via ? `Checked via ${r.verified_via} ${fmtDate(r.verified_at)}` : ''}</span>
      </div>
      {verify?.lookup_message && <Notice kind="warn">{verify.lookup_message}</Notice>}
      {verify?.metadata_differences?.length > 0 && <Notice kind="warn">The registry differs on: {verify.metadata_differences.join(', ')}. Your entry was not overwritten; please check and correct it.</Notice>}
    </div>
  );
}

function Sources() {
  const s = useLoad(() => api('/sources'));
  const [f, setF] = useState({ title: '', text: '', url: '' });
  const a = useAsync();
  return (
    <div className="grid cols-2">
      <section className="card">
        <h2>Your reference documents</h2>
        <p className="small muted">These are the only texts your personal similarity checks compare against. They stay private to you.</p>
        <Load state={s}>{(src: any[]) => src.length === 0 ? <Empty>None yet.</Empty> : (
          <table className="data"><tbody>{src.map((x) => <tr key={x.id}><td>{x.title}</td><td>{x.token_count} words</td><td><button className="btn sm ghost danger" onClick={async () => { await api(`/sources/${x.id}`, { method: 'DELETE' }); s.reload(); }}>Remove</button></td></tr>)}</tbody></table>
        )}</Load>
      </section>
      <section className="stack">
        <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/sources', { body: { title: f.title, text: f.text, url: f.url || undefined } }); setF({ title: '', text: '', url: '' }); s.reload(); }); }}>
          <h3>Paste a reference document</h3>
          <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="URL (optional)"><input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
          <Field label="Text"><textarea required rows={6} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
          <button className="btn primary" disabled={a.busy}>Add</button>
          {a.error ? <ErrorBox error={a.error} /> : null}
        </form>
        <ImportPanel as="source" onDone={() => s.reload()} />
      </section>
    </div>
  );
}
