import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { api, download, fmtDate, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { locate, offsetToPos } from '../lib/textmap';
import { Badge, ErrorBox, Field, Loading, Notice, Pct, PolicyList, useAsync, useLoad, Load, Empty } from '../components/ui';
import { ImportPanel } from './Documents';

type Sync = 'saved' | 'saving' | 'unsaved' | 'offline' | 'conflict' | 'error';
const draftKey = (id: string) => `ew.draft.${id}`;

export default function Studio() {
  const { id } = useParams();
  const { t } = useI18n();
  const doc = useLoad(() => api(`/documents/${id}`), [id]);
  if (doc.loading && !doc.data) return <Loading />;
  if (doc.error) return <div className="page"><ErrorBox error={doc.error} onRetry={doc.reload} /></div>;
  return <StudioInner key={id} initial={doc.data} reloadDoc={doc.reload} t={t} />;
}

function StudioInner({ initial, reloadDoc, t }: { initial: any; reloadDoc: () => void; t: (k: any) => string }) {
  const { config } = useSession();
  const id = initial.id as string;
  const [docMeta, setDocMeta] = useState(initial);
  const [title, setTitle] = useState(initial.title);
  const [sync, setSync] = useState<Sync>('saved');
  const [lastSaved, setLastSaved] = useState<string | null>(initial.version.updated_at);
  const [conflict, setConflict] = useState<any>(null);
  const [panel, setPanel] = useState(window.innerWidth > 1000);
  const [tab, setTab] = useState<string>(initial.assignment ? 'assignment' : 'writing');
  const [words, setWords] = useState(initial.version.word_count);
  const base = useRef<{ no: number; versionId: string }>({ no: initial.version.version_no, versionId: initial.version.id });
  const pendingEvent = useRef<any>(null);
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef(false);
  const offlineAllowed = initial.offline_allowed;
  const [localDraft, setLocalDraft] = useState<any>(() => {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? JSON.parse(raw) : null;
  });

  const editor = useEditor({
    extensions: [StarterKit, Table.configure({ resizable: false }), TableRow, TableHeader, TableCell],
    content: initial.version.content_html,
    editorProps: {
      attributes: { 'aria-label': 'Document editor', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' },
      handlePaste: (_v, e) => {
        const n = e.clipboardData?.getData('text/plain')?.length ?? 0;
        if (n > 0) pendingEvent.current = { kind: 'paste', detail: { chars: n } };
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      setWords((editor.getText().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? []).length);
      setSync('unsaved');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => save(), 1500);
    },
  });

  const save = useCallback(async (opts: { origin?: string; event?: any; force?: boolean } = {}) => {
    if (!editor || saving.current) return null;
    saving.current = true;
    setSync('saving');
    const html = editor.getHTML();
    const event = opts.event ?? pendingEvent.current;
    try {
      const r = await api(`/documents/${id}/content`, { method: 'PUT', body: { html, base_version_no: base.current.no, origin: opts.origin ?? 'edit', event: event ?? undefined } });
      pendingEvent.current = null;
      base.current = { no: r.version_no, versionId: r.version_id };
      setLastSaved(r.saved_at);
      setSync('saved');
      localStorage.removeItem(draftKey(id));
      setLocalDraft(null);
      setDocMeta((d: any) => ({ ...d, current_version_id: r.version_id, current_version_no: r.version_no }));
      return r;
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'version_conflict') {
        setConflict({ server: err.detail?.current, mine: html });
        setSync('conflict');
      } else if (err.status === 0 && offlineAllowed) {
        // Offline: keep the work on this device and sync when connectivity returns.
        localStorage.setItem(draftKey(id), JSON.stringify({ html, base_no: base.current.no, at: new Date().toISOString() }));
        setSync('offline');
      } else setSync('error');
      return null;
    } finally {
      saving.current = false;
    }
  }, [editor, id, offlineAllowed]);

  useEffect(() => {
    const on = () => { if (sync === 'offline' || sync === 'error') save(); };
    window.addEventListener('online', on);
    const unload = (e: BeforeUnloadEvent) => { if (sync === 'unsaved' || sync === 'saving') { e.preventDefault(); } };
    window.addEventListener('beforeunload', unload);
    return () => { window.removeEventListener('online', on); window.removeEventListener('beforeunload', unload); };
  }, [sync, save]);

  const flush = async () => {
    window.clearTimeout(timer.current);
    if (sync !== 'saved') return save();
    return { version_id: base.current.versionId, version_no: base.current.no };
  };

  if (!editor) return <Loading />;
  const statusText: Record<Sync, string> = { saved: t('studio.saved'), saving: t('studio.saving'), unsaved: t('studio.unsaved'), offline: t('studio.offline'), conflict: t('studio.conflict'), error: 'Not saved: retrying when possible' };
  const tabs = [
    ...(initial.assignment ? [['assignment', 'Assignment']] : []),
    ['writing', t('studio.writing')], ['similarity', t('studio.similarity')], ['citations', t('studio.citations')], ['tools', t('studio.tools')], ['history', t('studio.history')], ['comments', t('studio.comments')],
  ];
  return (
    <div className={`studio ${panel ? '' : 'panel-closed'}`}>
      <DocNav currentId={id} orgId={initial.org_id} />
      <div className="studio-main">
        <div className="studio-head">
          <label className="sr-only" htmlFor="doc-title">Title</label>
          <input id="doc-title" className="title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== docMeta.title && api(`/documents/${id}`, { method: 'PATCH', body: { title } }).then(() => setDocMeta({ ...docMeta, title }))} />
          {initial.assignment && <Badge kind="info">Assignment: {initial.assignment.course_title}</Badge>}
          <span role="status" aria-live="polite" className={`badge ${sync === 'saved' ? 'ok' : sync === 'conflict' || sync === 'error' ? 'bad' : 'warn'}`}>{statusText[sync]}</span>
          <ExportMenu id={id} styles={config?.citationStyles ?? []} />
          <button className="btn sm" aria-expanded={panel} onClick={() => setPanel(!panel)}>{panel ? 'Hide panel' : 'Show analysis'}</button>
        </div>
        {localDraft && sync !== 'offline' && (
          <Notice kind="warn">
            An unsynced copy from {fmtDate(localDraft.at)} is stored on this device.{' '}
            {localDraft.base_no === base.current.no
              ? <button className="btn sm" onClick={() => { editor.commands.setContent(localDraft.html); save(); }}>Restore and sync it</button>
              : <button className="btn sm" onClick={() => setConflict({ server: { version_no: base.current.no, content_html: editor.getHTML() }, mine: localDraft.html })}>Compare with the saved version</button>}
            {' '}<button className="btn sm ghost" onClick={() => { localStorage.removeItem(draftKey(id)); setLocalDraft(null); }}>Remove local copy</button>
          </Notice>
        )}
        {conflict && (
          <div className="card" role="alertdialog" aria-label="Edit conflict">
            <h3>This document changed elsewhere</h3>
            <p className="small">Nothing has been lost. Choose how to continue.</p>
            <div className="side-by-side">
              <div><strong>Saved version (v{conflict.server?.version_no})</strong><div className="doc-text small" dangerouslySetInnerHTML={{ __html: conflict.server?.content_html ?? '' }} /></div>
              <div><strong>Your text</strong><div className="doc-text small" dangerouslySetInnerHTML={{ __html: conflict.mine }} /></div>
            </div>
            <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" onClick={async () => { base.current.no = conflict.server.version_no; editor.commands.setContent(conflict.mine); setConflict(null); await save(); localStorage.removeItem(draftKey(id)); setLocalDraft(null); }}>Keep my text as the newest version</button>
              <button className="btn" onClick={() => { localStorage.removeItem(draftKey(id)); setLocalDraft(null); setConflict(null); reloadDoc(); }}>Use the saved version</button>
              <button className="btn ghost" onClick={async () => { const d = await api('/documents', { body: { title: `${docMeta.title} (my copy)`, html: conflict.mine } }); window.open(`/studio/${d.id}`, '_blank'); }}>Save my text as a separate copy</button>
            </div>
          </div>
        )}
        <Toolbar editor={editor} />
        <div className="editor-scroll"><EditorContent editor={editor} /></div>
        <div className="status-bar">
          <span>{words} {t('studio.words')}</span>
          <span>{editor.getText().length} characters</span>
          <span>Version {base.current.no}</span>
          {initial.stats.readability.available && <span title={initial.stats.readability.method}>Flesch reading ease {initial.stats.readability.fleschReadingEase} (at load)</span>}
          <span>Last saved {fmtDate(lastSaved)}</span>
          {!navigator.onLine && <Badge kind="warn">Offline: cloud analysis unavailable</Badge>}
          {offlineAllowed ? null : <span className="muted">Offline drafting disabled by your institution</span>}
        </div>
      </div>
      <aside className="panel" aria-label="Analysis panel">
        <div className="tabs" role="tablist">
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
          <button className="btn ghost sm" aria-label="Close panel" onClick={() => setPanel(false)}>✕</button>
        </div>
        <div className="panel-body" role="tabpanel">
          {tab === 'assignment' && <AssignmentTab doc={initial} />}
          {tab === 'writing' && <WritingTab id={id} editor={editor} flush={flush} save={save} base={base} />}
          {tab === 'similarity' && <SimilarityTab id={id} isAssignment={!!initial.assignment} flush={flush} />}
          {tab === 'citations' && <CitationsTab id={id} editor={editor} flush={flush} styles={config?.citationStyles ?? []} />}
          {tab === 'tools' && <ToolsTab id={id} editor={editor} save={save} modes={config?.rewriteModes ?? []} />}
          {tab === 'history' && <HistoryTab id={id} onRestore={reloadDoc} flush={flush} />}
          {tab === 'comments' && <CommentsTab id={id} editor={editor} />}
        </div>
      </aside>
    </div>
  );
}

function DocNav({ currentId, orgId }: { currentId: string; orgId: string | null }) {
  const s = useLoad(() => api('/documents' + (orgId ? `?workspace=${orgId}` : '')), [orgId]);
  return (
    <nav className="studio-nav" aria-label="Documents">
      <div className="row between"><strong>{orgId ? 'Assignment work' : 'Documents'}</strong>{!orgId && <Link to="/documents?new=1" className="small">+ New</Link>}</div>
      <Load state={s}>{(d: any[]) => <div className="stack" style={{ marginTop: 8 }}>{d.map((x) => <Link key={x.id} to={`/studio/${x.id}`} className={x.id === currentId ? 'current' : ''} aria-current={x.id === currentId ? 'page' : undefined}>{x.title}</Link>)}</div>}</Load>
    </nav>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const b = (label: string, active: boolean, fn: () => void, aria?: string) => <button className="btn ghost sm" aria-pressed={active} aria-label={aria ?? label} onClick={fn}>{label}</button>;
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="Formatting">
      {b('B', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'Bold')}
      {b('I', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'Italic')}
      {b('H1', editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'Heading 1')}
      {b('H2', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'Heading 2')}
      {b('• List', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), 'Bulleted list')}
      {b('1. List', editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), 'Numbered list')}
      {b('❝', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Block quote')}
      {b('Table', false, () => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(), 'Insert table')}
      {editor.isActive('table') && <>{b('+Row', false, () => editor.chain().focus().addRowAfter().run(), 'Add row')}{b('+Col', false, () => editor.chain().focus().addColumnAfter().run(), 'Add column')}{b('−Table', false, () => editor.chain().focus().deleteTable().run(), 'Delete table')}</>}
      {b('↶', false, () => editor.chain().focus().undo().run(), 'Undo')}
      {b('↷', false, () => editor.chain().focus().redo().run(), 'Redo')}
    </div>
  );
}

function ExportMenu({ id, styles }: { id: string; styles: any[] }) {
  const [style, setStyle] = useState('apa');
  return (
    <details className="export">
      <summary className="btn sm">Export</summary>
      <div className="card" style={{ position: 'absolute', right: 20, zIndex: 4, minWidth: 220 }}>
        <Field label="Bibliography style"><select value={style} onChange={(e) => setStyle(e.target.value)}>{styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></Field>
        <div className="stack">
          {['docx', 'pdf', 'txt'].map((f) => <button key={f} className="btn sm" onClick={() => download(`/documents/${id}/export?format=${f}&style=${style}`)}>Download {f.toUpperCase()}</button>)}
          <button className="btn sm" onClick={() => download(`/refs/export?format=bibtex&document_id=${id}`)}>References (BibTeX)</button>
          <button className="btn sm" onClick={() => download(`/refs/export?format=ris&document_id=${id}`)}>References (RIS)</button>
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- tabs

function AssignmentTab({ doc }: { doc: any }) {
  const a = doc.assignment;
  return (
    <div className="stack">
      <div className="kind-label kind-feedback">Assignment</div>
      <h3>{a.title}</h3>
      <p className="small">Due {fmtDate(a.due_at, a.timezone)} · up to {a.max_attempts} submission(s)</p>
      <h4>{'Assistance rules'}</h4>
      <PolicyList policy={a.assistance_policy} />
      <p className="small muted">These rules apply to tools inside this platform for this assignment, and are enforced by the server. A personal subscription does not change them.</p>
      <Link className="btn primary" to={`/assignments/${a.id}`}>Review and submit</Link>
    </div>
  );
}

function WritingTab({ id, editor, flush, save, base }: { id: string; editor: Editor; flush: () => Promise<any>; save: (o?: any) => Promise<any>; base: any }) {
  const [res, setRes] = useState<any>(null);
  const [learning, setLearning] = useState(false);
  const [lesson, setLesson] = useState<Record<string, any>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const a = useAsync();
  const run = () => a.run(async () => { await flush(); setMsg(null); setRes(await api(`/documents/${id}/writing-check`, { method: 'POST' })); });
  const decide = async (s: any, decision: 'accept' | 'reject' | 'ignore') => {
    setMsg(null);
    if (decision === 'accept') {
      await flush();
      if (base.current.versionId !== res.version_id) { setMsg('The document changed after the check. Run the check again so suggestions match the current text.'); return; }
      const range = locate(editor.state.doc, s.start_offset, s.end_offset, s.original);
      if (!range) { setMsg('This suggestion no longer matches the text. Run the check again.'); return; }
      try { await api(`/suggestions/${s.id}/decision`, { body: { decision, current_version_id: base.current.versionId } }); } catch (e: any) { setMsg(e.message); return; }
      editor.chain().focus().insertContentAt(range, s.replacement ?? '').run();
      await save({ origin: 'suggestion', event: { kind: 'suggestion_accepted', detail: { rule: s.rule_id } } });
      // Other suggestions were bound to the previous version; re-run to rebind them.
      setRes({ ...res, suggestions: res.suggestions.map((x: any) => (x.id === s.id ? { ...x, status: 'accepted' } : { ...x, stale: true })) });
      return;
    }
    await api(`/suggestions/${s.id}/decision`, { body: { decision, current_version_id: base.current.versionId } });
    setRes({ ...res, suggestions: res.suggestions.map((x: any) => (x.id === s.id ? { ...x, status: decision === 'reject' ? 'rejected' : 'ignored' } : x)) });
  };
  const undo = async (s: any) => {
    if (s.status === 'accepted') editor.chain().focus().undo().run();
    await api(`/suggestions/${s.id}/decision`, { body: { decision: 'undo', current_version_id: base.current.versionId } });
    setRes({ ...res, suggestions: res.suggestions.map((x: any) => (x.id === s.id ? { ...x, status: 'open' } : x)) });
  };
  const select = (s: any) => {
    const r = locate(editor.state.doc, s.start_offset, s.end_offset, s.original);
    if (r) editor.chain().focus().setTextSelection(r).scrollIntoView().run();
  };
  return (
    <div>
      <div className="kind-label kind-writing">Writing · rule-based checks (English)</div>
      <div className="row" style={{ margin: '8px 0' }}>
        <button className="btn primary" onClick={run} disabled={a.busy}>{a.busy ? 'Checking…' : 'Check writing'}</button>
        <label className="small"><input type="checkbox" checked={learning} onChange={(e) => setLearning(e.target.checked)} /> Learning mode</label>
      </div>
      {a.error ? <ErrorBox error={a.error} /> : null}
      {msg && <Notice kind="warn">{msg}</Notice>}
      {res?.status === 'unsupported_language' && <Notice kind="warn">{res.message}</Notice>}
      {res?.readability && <details className="small"><summary>Readability {res.readability.available ? `: Flesch ${res.readability.fleschReadingEase}, ${res.readability.averageSentenceLength} words/sentence` : '(unavailable)'}</summary><p>{res.readability.available ? res.readability.method : res.readability.reason}</p><p className="muted">An indicator only. It is separate from grades and similarity.</p></details>}
      {res && res.suggestions?.length === 0 && res.status === 'completed' && <Empty>No rule-based issues found. This does not guarantee the text is error-free.</Empty>}
      {res?.suggestions?.map((s: any) => (
        <div className="sugg" key={s.id} style={{ opacity: s.status !== 'open' ? 0.6 : 1 }}>
          <div className="row between"><span className="kind-label kind-writing">{s.category.replace('_', ' ')}</span>{s.status !== 'open' && <Badge>{s.status}</Badge>}{s.stale && s.status === 'open' && <Badge kind="warn">re-check needed</Badge>}</div>
          <button className="btn ghost sm" onClick={() => select(s)} aria-label="Show in document">“<span className="orig">{s.original.length > 80 ? s.original.slice(0, 80) + '…' : s.original}</span>”</button>
          {s.replacement !== null && <div>→ <span className="repl">{s.replacement === '' ? '(remove)' : s.replacement}</span></div>}
          <div className="small muted">{s.explanation}</div>
          {learning && (
            <div className="small">
              {lesson[s.rule_id] ? <><p>📘 {lesson[s.rule_id].rule}</p><p><em>Practice:</em> {lesson[s.rule_id].practice.prompt} <details><summary>Answer</summary>{lesson[s.rule_id].practice.answer}</details></p></>
                : <button className="btn ghost sm" onClick={async () => setLesson({ ...lesson, [s.rule_id]: await api(`/lessons/${s.rule_id}`) })}>Explain the rule</button>}
            </div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            {s.status === 'open' && !s.stale && s.replacement !== null && <button className="btn sm teal" onClick={() => decide(s, 'accept')}>Accept</button>}
            {s.status === 'open' && <button className="btn sm" onClick={() => decide(s, 'reject')}>Reject</button>}
            {s.status === 'open' && <button className="btn sm ghost" onClick={() => decide(s, 'ignore')}>Ignore</button>}
            {s.status === 'open' && s.category === 'spelling' && <button className="btn sm ghost" onClick={async () => { await api('/me/dictionary', { body: { word: s.original } }); decide(s, 'ignore'); }}>Add to dictionary</button>}
            {s.status !== 'open' && <button className="btn sm ghost" onClick={() => undo(s)}>Undo</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

function SimilarityTab({ id, isAssignment, flush }: { id: string; isAssignment: boolean; flush: () => Promise<any> }) {
  const sources = useLoad(() => api('/sources'));
  const jobs = useLoad(() => api(`/documents/${id}/jobs`), [id]);
  const [sel, setSel] = useState<string[] | null>(null);
  const [opts, setOpts] = useState({ exclude_quotes: true, exclude_bibliography: true, min_match_words: 8 });
  const [est, setEst] = useState<any>(null);
  const a = useAsync();
  const active = (jobs.data ?? []).find((j: any) => j.kind === 'similarity' && (j.status === 'queued' || j.status === 'processing'));
  // Jobs continue on the server; when the user returns the panel resumes polling.
  useEffect(() => {
    if (!active) return;
    const h = window.setInterval(jobs.reload, 2000);
    return () => window.clearInterval(h);
  }, [active?.id, active?.status]);
  if (isAssignment) return <Notice>For assignment work, similarity analysis runs when you submit, against the sources your institution has configured.</Notice>;
  const latest = (jobs.data ?? []).find((j: any) => j.kind === 'similarity');
  return (
    <div className="stack">
      <div className="kind-label kind-similarity">Source similarity · local corpus</div>
      <p className="small muted">Compares this document with reference documents you choose. The internet, publisher databases and other institutions are not checked. External services: <Badge kind="warn">Not configured</Badge></p>
      <Load state={sources}>{(src: any[]) => src.length === 0 ? <Notice kind="warn">You have no reference documents yet. A scan with no sources cannot produce a meaningful result. <Link to="/library?tab=sources">Add reference documents</Link>.</Notice> : (
        <fieldset><legend className="small">Sources to check ({(sel ?? src.map((s) => s.id)).length} of {src.length})</legend>
          {src.map((s) => <label key={s.id} className="small" style={{ display: 'block' }}><input type="checkbox" checked={(sel ?? src.map((x) => x.id)).includes(s.id)} onChange={(e) => { const cur = sel ?? src.map((x) => x.id); setSel(e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)); }} /> {s.title}</label>)}
        </fieldset>
      )}</Load>
      <details className="small"><summary>Settings</summary>
        <label style={{ display: 'block' }}><input type="checkbox" checked={opts.exclude_quotes} onChange={(e) => setOpts({ ...opts, exclude_quotes: e.target.checked })} /> Exclude quotations</label>
        <label style={{ display: 'block' }}><input type="checkbox" checked={opts.exclude_bibliography} onChange={(e) => setOpts({ ...opts, exclude_bibliography: e.target.checked })} /> Exclude bibliography</label>
        <label>Minimum match length (words) <input type="number" min={5} max={50} value={opts.min_match_words} onChange={(e) => setOpts({ ...opts, min_match_words: Number(e.target.value) })} style={{ width: 70 }} /></label>
      </details>
      <div className="row">
        <button className="btn" onClick={() => a.run(async () => { await flush(); setEst(await api(`/documents/${id}/estimate`, { method: 'POST' })); })}>Check cost</button>
        <button className="btn primary" disabled={a.busy || !!active} onClick={() => a.run(async () => { await flush(); await api(`/documents/${id}/analysis`, { body: { kind: 'similarity', source_ids: sel ?? undefined, ...opts } }); jobs.reload(); })}>Run similarity check</button>
      </div>
      {est && <Notice>{est.already_checked ? 'This version has already been checked with these settings; running again uses no allowance.' : `This check uses 1 of your ${est.allowance ?? 'unlimited'} monthly checks (${est.used} used). ${est.policy}`}</Notice>}
      {a.error ? <ErrorBox error={a.error} /> : null}
      {active && <div role="status"><Badge kind="info">{active.status === 'queued' ? 'Queued' : 'Processing'}</Badge> You can leave this page; the scan continues.</div>}
      {latest && !active && (
        <div className="sugg similarity">
          <div className="row between"><strong>Latest scan · v{latest.version_no}</strong><Badge kind={latest.status === 'completed' ? 'ok' : 'bad'}>{latest.status}</Badge></div>
          {latest.error && <p className="small">{latest.error}</p>}
          {latest.report_id && <LatestReport reportId={latest.report_id} />}
        </div>
      )}
    </div>
  );
}

function LatestReport({ reportId }: { reportId: string }) {
  const { t } = useI18n();
  const r = useLoad(() => api(`/reports/${reportId}`), [reportId]);
  return <Load state={r}>{(rep: any) => (
    <div>
      {rep.outdated && <Notice kind="warn">{t('studio.outdated')}</Notice>}
      {rep.status === 'no_sources' ? <Notice kind="warn">{t('sim.noSources')}</Notice> : rep.status === 'insufficient_text' ? <p>{t('sim.noText')}</p> : (
        <><div className="big-pct"><Pct value={rep.result.adjusted.percentage} /></div>
          <p className="small">{rep.result.original.matched === 0 ? t('sim.zero') : `${rep.result.adjusted.matched} of ${rep.result.adjusted.eligible} eligible words match ${rep.sources.length} source(s).`}</p></>
      )}
      <Link className="btn sm" to={`/reports/${reportId}`}>Open full report</Link>
    </div>
  )}</Load>;
}

function CitationsTab({ id, editor, flush, styles }: { id: string; editor: Editor; flush: () => Promise<any>; styles: any[] }) {
  const refs = useLoad(() => api(`/refs?document_id=${id}`), [id]);
  const [check, setCheck] = useState<any>(null);
  const [style, setStyle] = useState('apa');
  const [doi, setDoi] = useState('');
  const [lookupMsg, setLookupMsg] = useState<string | null>(null);
  const a = useAsync();
  return (
    <div className="stack">
      <div className="kind-label kind-citations">Citations</div>
      {lookupMsg && <Notice kind="warn">{lookupMsg} The reference was saved and labelled unverified.</Notice>}
      <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { await flush(); setCheck(await api(`/documents/${id}/citation-check`, { method: 'POST' })); })}>Check citations</button>
      {a.error ? <ErrorBox error={a.error} /> : null}
      {check && (
        <div>
          <p className="small">{check.citations.length} in-text citation(s), {check.entries.length} reference-list entr{check.entries.length === 1 ? 'y' : 'ies'}. {check.note}</p>
          {check.issues.length === 0 && <Empty>No citation issues found.</Empty>}
          {check.issues.map((i: any, k: number) => (
            <div className="sugg citations" key={k}><div className="row between"><span className="kind-label kind-citations">{i.kind.replace(/_/g, ' ')}</span><Badge kind={i.certainty === 'definite' ? 'warn' : 'neutral'}>{i.certainty}</Badge></div>
              <div className="small">{i.message}</div>{i.detail && <div className="small muted">{i.detail}</div>}
              {i.start !== undefined && <button className="btn ghost sm" onClick={() => { const f = offsetToPos(editor.state.doc, i.start), t2 = offsetToPos(editor.state.doc, i.end); if (f !== null && t2 !== null) editor.chain().focus().setTextSelection({ from: f, to: t2 }).scrollIntoView().run(); }}>Show in document</button>}
            </div>
          ))}
        </div>
      )}
      <h4>References linked to this document</h4>
      <Load state={refs}>{(r: any[]) => r.length === 0 ? <Empty>None yet.</Empty> : (
        <ul className="small" style={{ paddingLeft: 16 }}>{r.map((x) => <li key={x.id}>{x.csl.title ?? 'Untitled'} {' '}
          <Badge kind={x.checks.exists === 'verified' ? 'ok' : 'warn'}>exists: {x.checks.exists.replace('_', ' ')}</Badge>{' '}
          <Badge kind={x.checks.metadata === 'incomplete' ? 'bad' : 'neutral'}>metadata: {x.checks.metadata.replace('_', ' ')}</Badge>{' '}
          <Badge>claim support: {x.checks.supports_claim.replace('_', ' ')}</Badge></li>)}</ul>
      )}</Load>
      <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api('/refs', { body: { doi, document_id: id } }); setDoi(''); refs.reload(); setLookupMsg(r.lookup_message ?? null); }); }}>
        <input placeholder="Add by DOI, e.g. 10.1000/xyz" aria-label="DOI" value={doi} onChange={(e) => setDoi(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm" disabled={!doi}>Add</button>
      </form>
      <Link className="small" to="/library">Open reference library (manual entry, ISBN, tags)</Link>
      <div className="row">
        <select aria-label="Citation style" value={style} onChange={(e) => setStyle(e.target.value)}>{styles.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
        <button className="btn sm" onClick={() => a.run(async () => {
          const b = await api(`/documents/${id}/bibliography?style=${style}`);
          if (!b.text) return;
          const paras = b.text.split('\n').filter(Boolean).map((l: string) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`).join('');
          editor.chain().focus('end').insertContent(`<h2>References</h2>${paras}`).run();
        })}>Insert bibliography</button>
      </div>
    </div>
  );
}


function ToolsTab({ id, editor, save, modes }: { id: string; editor: Editor; save: (o?: any) => Promise<any>; modes: any[] }) {
  const [mode, setMode] = useState('concise');
  const [locked, setLocked] = useState('');
  const [rw, setRw] = useState<any>(null);
  const [sum, setSum] = useState<any>(null);
  const [len, setLen] = useState<'short' | 'medium' | 'long'>('medium');
  const [fmt, setFmt] = useState<'bullets' | 'paragraph'>('bullets');
  const [sel, setSel] = useState<{ from: number; to: number; text: string } | null>(null);
  const a = useAsync();
  const grab = () => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n\n', '\n');
    return text.trim() ? { from, to, text } : null;
  };
  return (
    <div className="stack">
      <div className="kind-label kind-feedback">Rewrite</div>
      <p className="small muted">Select a sentence or paragraph, choose a mode, then compare alternatives. Changes apply only when you accept them. This is a writing aid, not a way to disguise sources.</p>
      <div className="row">
        <select aria-label="Rewrite mode" value={mode} onChange={(e) => setMode(e.target.value)}>
          {modes.map((m) => <option key={m.key} value={m.key}>{m.key[0].toUpperCase() + m.key.slice(1)}{m.local ? '' : ' (AI provider)'}</option>)}
        </select>
        <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => {
          const s = grab();
          if (!s) throw new Error('Select some text in the editor first.');
          setSel(s);
          setRw(await api('/tools/rewrite', { body: { text: s.text, mode, document_id: id, locked: locked.split(';').map((x) => x.trim()).filter(Boolean) } }));
        })}>Rewrite selection</button>
      </div>
      <Field label="Locked terms" hint="Separate with semicolons. Quotations and citations are always locked."><input value={locked} onChange={(e) => setLocked(e.target.value)} /></Field>
      {a.error ? <ErrorBox error={a.error} /> : null}
      {rw && rw.status !== 'ok' && <Notice kind="warn">{rw.message ?? 'Not available.'}</Notice>}
      {rw && rw.status === 'ok' && (
        <div>
          {rw.provider_status !== 'ok' && rw.message && <Notice>{rw.message}</Notice>}
          {rw.alternatives.map((alt: any, i: number) => (
            <div className="sugg" key={i}>
              <div className="side-by-side small"><div><strong>Original</strong><p>{rw.original}</p></div><div><strong>Alternative ({alt.source})</strong><p>{alt.text}</p></div></div>
              {alt.unchanged && <Notice>No changes were suggested for this text in this mode.</Notice>}
              {alt.flags.map((f: any, k: number) => <Notice kind="warn" key={k}>Check meaning: {f.message}</Notice>)}
              {!alt.unchanged && <button className="btn sm teal" onClick={async () => {
                if (!sel || editor.state.doc.textBetween(sel.from, sel.to, '\n\n', '\n') !== sel.text) { setRw({ ...rw, status: 'stale', message: 'The selected text changed. Select it again and retry.' }); return; }
                editor.chain().focus().insertContentAt({ from: sel.from, to: sel.to }, alt.text).run();
                await save({ origin: 'rewrite', event: { kind: 'rewrite_accepted', detail: { mode, source: alt.source, flags: alt.flags.length } } });
                setRw(null);
              }}>Accept and replace</button>}
            </div>
          ))}
          <p className="small muted">{rw.note}</p>
        </div>
      )}
      <hr />
      <div className="kind-label kind-feedback">Summarize</div>
      <div className="row">
        <select aria-label="Length" value={len} onChange={(e) => setLen(e.target.value as any)}><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long</option></select>
        <select aria-label="Format" value={fmt} onChange={(e) => setFmt(e.target.value as any)}><option value="bullets">Bullets</option><option value="paragraph">Paragraph</option></select>
        <button className="btn" onClick={() => a.run(async () => { const s = grab(); setSum(await api('/tools/summarize', { body: { text: s?.text ?? editor.getText({ blockSeparator: '\n\n' }), length: len, format: fmt, document_id: id } })); })}>Summarize {editor.state.selection.empty ? 'document' : 'selection'}</button>
      </div>
      {sum && (
        <div className="small">
          <p className="muted">{sum.methodNote}</p>
          {sum.points.length === 0 ? <Empty>Not enough text to summarize.</Empty> : fmt === 'bullets' ? <ul>{sum.points.map((p: any, i: number) => <li key={i}>{p.text}</li>)}</ul> : <p>{sum.text}</p>}
        </div>
      )}
      <hr />
      <div className="kind-label kind-feedback">Translate & tutor</div>
      <ProviderTool id={id} editor={editor} />
    </div>
  );
}

function ProviderTool({ id, editor }: { id: string; editor: Editor }) {
  const [out, setOut] = useState<any>(null);
  const [q, setQ] = useState('');
  const a = useAsync();
  const sel = () => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, '\n\n', '\n');
  return (
    <div className="stack">
      <div className="row">
        <button className="btn sm" onClick={() => a.run(async () => setOut(await api('/tools/translate', { body: { text: sel() || editor.getText().slice(0, 5000), target: 'sw', document_id: id } })))}>Translate to Swahili</button>
        <button className="btn sm" onClick={() => a.run(async () => setOut(await api('/tools/translate', { body: { text: sel() || editor.getText().slice(0, 5000), target: 'en', document_id: id } })))}>Translate to English</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => setOut(await api('/tools/tutor', { body: { text: editor.getText().slice(0, 20000), question: q, document_id: id } }))); }}>
        <input placeholder="Ask the writing tutor (structure, argument, outline)…" aria-label="Tutor question" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button className="btn sm" disabled={!q}>Ask</button>
      </form>
      {a.error ? <ErrorBox error={a.error} /> : null}
      {out && (out.status === 'ok' ? <div className="doc-text small">{out.output}{out.note && <p className="muted">{out.note}</p>}</div> : <Notice kind="warn">{out.status === 'not_configured' ? 'Not configured: ' : ''}{out.message}</Notice>)}
    </div>
  );
}

function HistoryTab({ id, onRestore, flush }: { id: string; onRestore: () => void; flush: () => Promise<any> }) {
  const v = useLoad(() => flush().then(() => api(`/documents/${id}/versions`)), [id]);
  const ev = useLoad(() => api(`/documents/${id}/events`), [id]);
  const [pair, setPair] = useState<number[]>([]);
  const cmp = useLoad(() => (pair.length === 2 ? api(`/documents/${id}/compare?a=${Math.min(...pair)}&b=${Math.max(...pair)}`) : Promise.resolve(null)), [pair.join()]);
  return (
    <div className="stack">
      <p className="small muted">Pick two versions to compare side by side. Submitted and analysed versions are frozen and never change.</p>
      <Load state={v}>{(vs: any[]) => (
        <table className="data small"><tbody>{vs.map((x) => (
          <tr key={x.id}>
            <td><input type="checkbox" aria-label={`Compare version ${x.version_no}`} checked={pair.includes(x.version_no)} onChange={(e) => setPair(e.target.checked ? [...pair, x.version_no].slice(-2) : pair.filter((p) => p !== x.version_no))} /></td>
            <td>v{x.version_no}</td><td>{x.origin}</td><td>{x.word_count}w</td><td>{fmtDate(x.updated_at)}</td>
            <td>{x.submitted ? <Badge kind="info">submitted</Badge> : x.frozen ? <Badge>frozen</Badge> : null}</td>
            <td><button className="btn sm ghost" onClick={async () => { await api(`/documents/${id}/restore/${x.version_no}`, { method: 'POST' }); onRestore(); }}>Restore</button></td>
          </tr>
        ))}</tbody></table>
      )}</Load>
      {pair.length === 2 && <Load state={cmp}>{(c: any) => c && (
        <div className="diff doc-text small">{c.diff.map((d: any, i: number) => d.op === 'eq' ? <span key={i}>{d.text}</span> : d.op === 'ins' ? <ins key={i}>{d.text}</ins> : <del key={i}>{d.text}</del>)}</div>
      )}</Load>}
      <h4>Activity recorded on this platform</h4>
      <p className="small muted">Pasted text has unknown origin; typed text alone does not prove authorship. Paste events record size only, never content.</p>
      <Load state={ev}>{(e: any[]) => e.length === 0 ? <Empty /> : <ul className="small">{e.slice(0, 50).map((x, i) => <li key={i}>{fmtDate(x.created_at)} · {x.kind.replace('_', ' ')}{x.version_no ? ` · v${x.version_no}` : ''}{x.detail?.chars ? ` · ${x.detail.chars} characters` : ''}</li>)}</ul>}</Load>
    </div>
  );
}

function CommentsTab({ id, editor }: { id: string; editor: Editor }) {
  const c = useLoad(() => api(`/documents/${id}/comments`), [id]);
  const [body, setBody] = useState('');
  return (
    <div className="stack">
      <Load state={c}>{(cs: any[]) => cs.length === 0 ? <Empty>No comments.</Empty> : <div>{cs.map((x) => <div key={x.id} className="sugg"><div className="small muted">{x.author} · {fmtDate(x.created_at)}</div>{x.quote && <blockquote className="small">“{x.quote}”</blockquote>}<div>{x.body}</div></div>)}</div>}</Load>
      <form onSubmit={async (e) => { e.preventDefault(); const { from, to } = editor.state.selection; await api(`/documents/${id}/comments`, { body: { body, quote: editor.state.doc.textBetween(from, to).slice(0, 1000) || undefined } }); setBody(''); c.reload(); }}>
        <Field label="Add a comment" hint="Selected text is attached as a quote."><textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <button className="btn sm" disabled={!body.trim()}>Comment</button>
      </form>
      <details><summary className="small">Import a file into this document</summary><ImportPanel documentId={id} onDone={() => location.reload()} /></details>
    </div>
  );
}
