import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, fmtDate } from '../lib/api';
import { Badge, ErrorBox, Field, Load, Notice, useAsync, useLoad, Empty } from '../components/ui';

/** Upload → extract → review extracted text → confirm. Failed or scanned files are never imported as empty documents. */
export function ImportPanel({ onDone, as = 'document', documentId }: { onDone: (r: any) => void; as?: 'document' | 'source'; documentId?: string }) {
  const [imp, setImp] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [progress, setProgress] = useState<string>('');
  const a = useAsync();
  const upload = (file: File) => a.run(async () => {
    setProgress('Uploading…');
    const fd = new FormData();
    fd.append('file', file);
    setProgress('Uploading and extracting text…');
    const r = await api('/imports', { form: fd });
    setImp(r);
    setTitle(file.name.replace(/\.[^.]+$/, ''));
    setProgress('');
  }).finally(() => setProgress(''));
  return (
    <div className="card">
      <h3>Import a file</h3>
      <p className="small muted">TXT, DOCX or text-based PDF. The original file is kept unchanged; you edit a separate copy.</p>
      <input type="file" accept=".txt,.docx,.pdf,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" aria-label="Choose file to import" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      {progress && <p role="status">{progress}</p>}
      {a.error ? <ErrorBox error={a.error} /> : null}
      {imp && imp.status === 'failed' && <Notice kind="error">{imp.error}</Notice>}
      {imp && imp.status === 'needs_ocr' && <Notice kind="warn">{imp.error} {imp.ocr_configured ? 'It has been sent for OCR.' : 'OCR is not configured on this server, so this file cannot be analysed yet.'}</Notice>}
      {imp && imp.status === 'needs_review' && (
        <div className="stack">
          {imp.warnings.map((w: string, i: number) => <Notice kind="warn" key={i}>{w}</Notice>)}
          <Field label="Review the extracted text before continuing">
            <textarea readOnly value={imp.preview} rows={10} />
          </Field>
          {!documentId && <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>}
          <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => onDone(await api(`/imports/${imp.id}/confirm`, { body: { title: title || 'Imported document', as, document_id: documentId } })))}>
            {documentId ? 'Use this text as a new version' : as === 'source' ? 'Add as reference document' : 'Create editable document'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Documents() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [folder, setFolder] = useState<string>('');
  const folders = useLoad(() => api('/folders'));
  const docs = useLoad(() => api('/documents' + (folder ? `?folder=${folder}` : '')), [folder]);
  const [newTitle, setNewTitle] = useState('');
  const a = useAsync();
  const [showNew, setShowNew] = useState(sp.has('new'));
  const [showImport, setShowImport] = useState(sp.has('import'));
  useEffect(() => { setShowNew(sp.has('new')); setShowImport(sp.has('import')); }, [sp]);
  return (
    <div className="page">
      <div className="row between">
        <h1>Documents</h1>
        <div className="row">
          <button className="btn primary" onClick={() => setSp({ new: '1' })}>New document</button>
          <button className="btn" onClick={() => setSp({ import: '1' })}>Import file</button>
        </div>
      </div>
      {showNew && (
        <form className="card row" onSubmit={async (e) => { e.preventDefault(); const d = await a.run(() => api('/documents', { body: { title: newTitle || 'Untitled document', folder_id: folder || null } })); if (d) nav(`/studio/${d.id}`); }}>
          <label className="sr-only" htmlFor="nt">Title</label>
          <input id="nt" placeholder="Document title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} style={{ flex: 1 }} />
          <button className="btn primary" disabled={a.busy}>Create</button>
          <button type="button" className="btn ghost" onClick={() => setSp({})}>Cancel</button>
        </form>
      )}
      {showImport && <ImportPanel onDone={(r) => nav(`/studio/${r.document_id}`)} />}
      {a.error ? <ErrorBox error={a.error} /> : null}
      <div className="grid" style={{ gridTemplateColumns: '220px 1fr', marginTop: 16 }}>
        <aside className="card" aria-label="Folders">
          <h3>Folders</h3>
          <button className={`btn ghost sm`} aria-pressed={!folder} onClick={() => setFolder('')}>All documents</button>
          <Load state={folders}>{(f: any[]) => <div className="stack">{f.map((x) => <button key={x.id} className="btn ghost sm" aria-pressed={folder === x.id} onClick={() => setFolder(x.id)}>📁 {x.name}</button>)}</div>}</Load>
          <form onSubmit={async (e) => { e.preventDefault(); const name = (e.currentTarget.elements.namedItem('fname') as HTMLInputElement).value; if (name) { await api('/folders', { body: { name } }); folders.reload(); (e.target as HTMLFormElement).reset(); } }}>
            <input name="fname" placeholder="New folder" aria-label="New folder name" style={{ width: '100%', marginTop: 8 }} />
          </form>
        </aside>
        <section className="card">
          <Load state={docs}>{(d: any[]) => d.length === 0 ? <Empty>No documents in this folder.</Empty> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>Title</th><th>Version</th><th>Words</th><th>Updated</th><th>Folder</th></tr></thead>
              <tbody>{d.map((x) => (
                <tr key={x.id}>
                  <td><Link to={`/studio/${x.id}`}>{x.title}</Link></td><td>v{x.current_version_no}</td><td>{x.word_count}</td><td>{fmtDate(x.updated_at)}</td>
                  <td><select aria-label={`Move ${x.title} to folder`} value={x.folder_id ?? ''} onChange={async (e) => { await api(`/documents/${x.id}`, { method: 'PATCH', body: { folder_id: e.target.value || null } }); docs.reload(); }}>
                    <option value="">—</option>{(folders.data ?? []).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}</Load>
        </section>
      </div>
      <p className="small muted">Assignment drafts live in each assignment, under your institution workspace. <Badge>Private</Badge> Personal documents are visible only to you.</p>
    </div>
  );
}
