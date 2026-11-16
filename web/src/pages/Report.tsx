import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, download, fmtDate } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Badge, ErrorBox, Load, Notice, Pct, useAsync, useLoad, Empty } from '../components/ui';

const COLORS = ['#f4c95d', '#8fd3c7', '#f2a08a', '#b9b3f2', '#9ccbf2', '#d8e28a'];

export function ReportView({ rep, canExclude, onChange, pdfPath }: { rep: any; canExclude: boolean; onChange?: () => void; pdfPath?: string }) {
  const { t } = useI18n();
  const [focus, setFocus] = useState<any>(null);
  const [pending, setPending] = useState<{ type: 'source' | 'match'; id: string; reason: string } | null>(null);
  const a = useAsync();
  const exclude = (type: 'source' | 'match', id: string) => setPending({ type, id, reason: '' });
  if (rep.kind !== 'similarity') return <pre className="doc-text">{JSON.stringify(rep.result, null, 2)}</pre>;
  const r = rep.result;
  const marks = [...rep.matches].sort((x: any, y: any) => x.doc_start - y.doc_start);
  const parts: React.ReactNode[] = [];
  let cur = 0;
  marks.forEach((m: any) => {
    if (m.doc_start < cur) return;
    parts.push(rep.text.slice(cur, m.doc_start));
    const excluded = m.excluded || !!m.auto_excluded_reason;
    parts.push(
      <mark key={m.id} className={`match ${excluded ? 'excluded' : ''}`} style={{ background: excluded ? undefined : COLORS[m.source_index % COLORS.length] }} tabIndex={0} role="button"
        aria-label={`Match with source ${m.source_index + 1}, ${m.length_tokens} words${excluded ? ', excluded' : ''}`} onClick={() => setFocus(m)} onKeyDown={(e) => e.key === 'Enter' && setFocus(m)}>
        <sup>[{m.source_index + 1}]</sup>{rep.text.slice(m.doc_start, m.doc_end)}
      </mark>,
    );
    cur = m.doc_end;
  });
  parts.push(rep.text.slice(cur));
  return (
    <div>
      {rep.outdated && <Notice kind="warn">{t('studio.outdated')} This report describes version {rep.version_no}.</Notice>}
      <div className="grid cols-3">
        <div className="card">
          <div className="kind-label kind-similarity">Adjusted similarity</div>
          <div className="big-pct">{rep.status === 'no_sources' ? '—' : <Pct value={r.adjusted.percentage} />}</div>
          <div className="small">{r.adjusted.matched} of {r.adjusted.eligible} eligible words</div>
          <div className="small muted">Original: {r.original.percentage ?? '—'}% ({r.original.matched} words)</div>
        </div>
        <div className="card small">
          <div><strong>{rep.report_number}</strong></div>
          <div>{rep.document_title} · version {rep.version_no}</div>
          <div>Scanned {fmtDate(rep.created_at)}</div>
          <div>Engine {rep.engine}</div>
          <div title={rep.version_hash}>Version hash {rep.version_hash?.slice(0, 12)}…</div>
        </div>
        <div className="card small">
          <div><strong>Scope:</strong> {typeof r.scope === 'object' ? Object.entries(r.scope).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ') : r.scope}</div>
          <div><strong>Settings:</strong> min {rep.settings.minMatchWords} words; quotes {rep.settings.excludeQuotes ? 'excluded' : 'included'}; bibliography {rep.settings.excludeBibliography ? 'excluded' : 'included'}</div>
          <div className="row" style={{ marginTop: 6 }}>{pdfPath && <button className="btn sm" onClick={() => download(pdfPath)}>Download PDF</button>}</div>
        </div>
      </div>
      {rep.status === 'no_sources' && <Notice kind="warn">{t('sim.noSources')}</Notice>}
      {rep.status === 'insufficient_text' && <Notice kind="warn">{t('sim.noText')}</Notice>}
      {rep.status === 'completed' && r.original.matched === 0 && <Notice kind="success">{t('sim.zero')} This does not guarantee originality.</Notice>}
      {r.language_detected === 'sw' && <Notice>Text appears to be Swahili. Lexical matching works on any language, but this engine has not been separately validated for Swahili.</Notice>}
      <Notice>A similarity result is evidence for review. It does not by itself establish plagiarism or misconduct.</Notice>
      {a.error ? <ErrorBox error={a.error} /> : null}
      {pending && (
        <form className="card" aria-label="Exclusion reason" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/reports/${rep.id}/exclusions`, { body: { target_type: pending.type, target_id: pending.id, reason: pending.reason } }); setPending(null); onChange?.(); }); }}>
          <label className="field"><span className="field-label">Reason for excluding this {pending.type} (recorded and shown in the report)</span>
            <input autoFocus required minLength={3} value={pending.reason} onChange={(e) => setPending({ ...pending, reason: e.target.value })} /></label>
          <div className="row"><button className="btn primary sm">Exclude</button><button type="button" className="btn ghost sm" onClick={() => setPending(null)}>Cancel</button></div>
        </form>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(260px,1fr)', marginTop: 12 }}>
        <section aria-label="Document with matches"><div className="doc-text">{parts}</div></section>
        <aside className="stack">
          <div className="card">
            <h3>Sources</h3>
            {rep.sources.length === 0 && <Empty>No matching sources.</Empty>}
            {rep.sources.map((s: any) => (
              <div key={s.id} className="sugg similarity" style={{ borderLeftColor: COLORS[s.index % COLORS.length] }}>
                <div><strong>[{s.index + 1}]</strong> {s.label} {s.excluded && <Badge kind="warn">{s.auto_excluded ? 'auto-excluded' : 'excluded'}</Badge>}</div>
                <div className="small">{s.adjusted_percentage}% adjusted · {s.original_percentage}% original · {s.matched_tokens} words</div>
                {s.url && <a className="small" href={s.url} target="_blank" rel="noreferrer noopener">Open source</a>}
                {!s.excerpts_permitted && <div className="small muted">Source text is restricted for this viewer.</div>}
                {canExclude && !s.excluded && <button className="btn sm ghost" onClick={() => exclude('source', s.id)}>Exclude source</button>}
              </div>
            ))}
          </div>
          {focus && (
            <div className="card">
              <h3>Match detail</h3>
              <p className="small">{focus.length_tokens} words · source [{focus.source_index + 1}] {focus.auto_excluded_reason && <Badge>{focus.auto_excluded_reason.replace(/_/g, ' ')}</Badge>}</p>
              {focus.source_excerpt ? <div className="doc-text small">{focus.source_excerpt.slice(0, focus.source_excerpt_offset)}<mark className="match">{focus.source_excerpt.slice(focus.source_excerpt_offset, focus.source_excerpt_offset + focus.source_excerpt_length)}</mark>{focus.source_excerpt.slice(focus.source_excerpt_offset + focus.source_excerpt_length)}</div> : <p className="small muted">Source excerpt not available to you.</p>}
              {canExclude && !focus.excluded && <button className="btn sm ghost" onClick={() => exclude('match', focus.id)}>Exclude this match</button>}
            </div>
          )}
          <div className="card">
            <h3>Exclusions</h3>
            {rep.exclusions.length === 0 && <p className="small muted">None. Quotations and the bibliography were handled by the settings above.</p>}
            <ul className="small">{rep.exclusions.map((e: any) => <li key={e.id} style={{ textDecoration: e.reverted_at ? 'line-through' : undefined }}>{e.target_type}: {e.reason} · {e.reviewer} · {fmtDate(e.created_at)}{e.reverted_at ? ' (reverted)' : canExclude ? <> <button className="btn sm ghost" onClick={() => a.run(async () => { await api(`/reports/${rep.id}/exclusions/${e.id}/revert`, { method: 'POST' }); onChange?.(); })}>Revert</button></> : null}</li>)}</ul>
          </div>
          <div className="card small"><h3>Limitations</h3><ul>{rep.limitations.map((l: string) => <li key={l}>{l}</li>)}</ul></div>
        </aside>
      </div>
    </div>
  );
}

export default function ReportPage() {
  const { id } = useParams();
  const s = useLoad(() => api(`/reports/${id}`), [id]);
  const shares = useLoad(() => api(`/reports/${id}/shares`), [id]);
  const [link, setLink] = useState<string | null>(null);
  const a = useAsync();
  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <h1>Similarity report</h1>
      <Load state={s}>{(rep: any) => (
        <>
          <ReportView rep={rep} canExclude={rep.audience === 'owner' || rep.audience === 'staff'} onChange={s.reload} pdfPath={`/reports/${id}/pdf`} />
          {(rep.audience === 'owner' || rep.audience === 'staff') && (
            <div className="card" style={{ marginTop: 16 }}>
              <h3>Share this report</h3>
              <p className="small muted">Creates a private link that expires. Anyone with the link can view this report (source identities of other students are hidden). You can revoke it at any time.</p>
              <button className="btn" disabled={a.busy} onClick={() => a.run(async () => { const r = await api(`/reports/${id}/shares`, { body: { expires_in_days: 7 } }); setLink(location.origin + r.path); shares.reload(); })}>Create 7-day link</button>
              {link && <p><input readOnly value={link} style={{ width: '100%' }} aria-label="Share link" onFocus={(e) => e.target.select()} /></p>}
              <Load state={shares}>{(sh: any[]) => <ul className="small">{sh.map((x) => <li key={x.id}>Expires {fmtDate(x.expires_at)} {x.revoked_at ? <Badge kind="bad">revoked</Badge> : <button className="btn sm ghost" onClick={async () => { await api(`/shares/${x.id}`, { method: 'DELETE' }); shares.reload(); }}>Revoke</button>}</li>)}</ul>}</Load>
            </div>
          )}
          {rep.submission_id && <p><Link to={`/review/${rep.submission_id}`}>Back to submission</Link></p>}
        </>
      )}</Load>
    </div>
  );
}

export function SharedReport() {
  const { token } = useParams();
  const s = useLoad(() => api(`/shared/${token}`), [token]);
  return (
    <div className="page" style={{ maxWidth: 1300 }}>
      <h1>Shared similarity report</h1>
      <Load state={s}>{(rep: any) => <ReportView rep={rep} canExclude={false} pdfPath={`/shared/${token}/pdf`} />}</Load>
    </div>
  );
}
