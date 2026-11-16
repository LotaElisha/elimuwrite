import { useState } from 'react';
import { api, fmtDate } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, ErrorBox, Field, Load, Notice, useAsync, useLoad, Denied } from '../components/ui';

export default function PlatformAdmin() {
  const { me } = useSession();
  const [tab, setTab] = useState('health');
  if (!me?.is_platform_admin) return <div className="page"><Denied /></div>;
  const tabs = [['health', 'Service status'], ['plans', 'Plans'], ['orgs', 'Organizations'], ['invoices', 'Invoices'], ['flags', 'Feature flags'], ['support', 'Support access'], ['audit', 'Audit']];
  return (
    <div className="page">
      <h1>Platform administration</h1>
      <Notice>Platform administration has no automatic access to documents. Support access requires a written justification, expires within 24 hours and is audited.</Notice>
      <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
      <div style={{ marginTop: 16 }}>
        {tab === 'health' && <Health />}
        {tab === 'plans' && <Plans />}
        {tab === 'orgs' && <Orgs />}
        {tab === 'invoices' && <Invoices />}
        {tab === 'flags' && <Flags />}
        {tab === 'support' && <Support />}
        {tab === 'audit' && <AuditAll />}
      </div>
    </div>
  );
}

function Health() {
  const s = useLoad(() => api('/admin/health'));
  return <Load state={s}>{(h: any) => (
    <div className="grid cols-2">
      <div className="card"><h3>Database</h3><Badge kind="ok">OK</Badge> {h.database.latency_ms} ms</div>
      <div className="card"><h3>Analysis queue (7 days)</h3><ul>{h.jobs_last_7_days.map((j: any) => <li key={j.status}>{j.status}: {j.n}</li>)}</ul><p className="small">Oldest queued: {h.oldest_queued_seconds ?? 0}s</p></div>
      <div className="card" style={{ gridColumn: '1/-1' }}><h3>Providers</h3><table className="data small"><tbody>{h.providers.map((p: any) => <tr key={p.key}><td>{p.name}</td><td><Badge kind={p.status === 'configured' ? 'ok' : 'warn'}>{p.status.replace('_', ' ')}</Badge></td><td className="muted">{p.detail}</td></tr>)}</tbody></table></div>
    </div>
  )}</Load>;
}

function Plans() {
  const s = useLoad(() => api('/admin/plans'));
  const a = useAsync();
  return <Load state={s}>{(plans: any[]) => (
    <div className="grid cols-2">{plans.map((p) => <PlanEditor key={p.code} p={p} onSave={(b) => a.run(async () => { await api(`/admin/plans/${p.code}`, { method: 'PATCH', body: b }); s.reload(); })} />)}{a.error ? <ErrorBox error={a.error} /> : null}</div>
  )}</Load>;
}

function PlanEditor({ p, onSave }: { p: any; onSave: (b: any) => void }) {
  const [prices, setPrices] = useState(p.prices);
  const [limits, setLimits] = useState(p.limits);
  const num = (v: string) => (v === '' ? null : Number(v));
  return (
    <div className="card">
      <h3>{p.name} <Badge>{p.code}</Badge></h3>
      {(['TZS', 'USD'] as const).map((c) => (
        <div className="row" key={c}>{(['monthly', 'annual'] as const).map((i) => <Field key={i} label={`${c} ${i}`}><input type="number" min={0} placeholder="not set" value={prices[c]?.[i] ?? ''} onChange={(e) => setPrices({ ...prices, [c]: { ...prices[c], [i]: num(e.target.value) } })} /></Field>)}</div>
      ))}
      {Object.keys(limits).map((k) => <Field key={k} label={k.replace(/_/g, ' ')} hint="Blank = unlimited"><input type="number" min={0} value={limits[k] ?? ''} onChange={(e) => setLimits({ ...limits, [k]: num(e.target.value) })} /></Field>)}
      <button className="btn primary" onClick={() => onSave({ prices, limits })}>Save</button>
    </div>
  );
}

function Orgs() {
  const s = useLoad(() => api('/admin/orgs'));
  return <div className="card"><Load state={s}>{(o: any[]) => <table className="data"><thead><tr><th>Name</th><th>Plan</th><th>Members</th><th>Seats</th><th>Created</th></tr></thead><tbody>{o.map((x) => <tr key={x.id}><td>{x.name} {x.is_demo && <Badge kind="warn">demo</Badge>}</td><td>{x.plan}</td><td>{x.members}</td><td>{x.seat_limit}</td><td>{fmtDate(x.created_at)}</td></tr>)}</tbody></table>}</Load></div>;
}

function Invoices() {
  const s = useLoad(() => api('/admin/invoices'));
  const orgs = useLoad(() => api('/admin/orgs'));
  const [f, setF] = useState({ org_id: '', amount: '', currency: 'TZS' });
  const [rec, setRec] = useState<Record<string, string>>({});
  const a = useAsync();
  return (
    <div className="grid cols-2">
      <div className="card"><h3>Invoices</h3><Load state={s}>{(inv: any[]) => <table className="data small"><tbody>{inv.map((i) => (
        <tr key={i.id}><td>{i.number}<div className="muted">{i.org_name}</div></td><td>{Number(i.amount).toLocaleString()} {i.currency}</td><td><Badge kind={i.status === 'paid' ? 'ok' : 'warn'}>{i.status}</Badge></td>
          <td>{i.status !== 'paid' && <div className="row"><input placeholder="Bank reference" aria-label="Bank reference" value={rec[i.id] ?? ''} onChange={(e) => setRec({ ...rec, [i.id]: e.target.value })} style={{ width: 120 }} /><button className="btn sm" disabled={!rec[i.id]} onClick={() => a.run(async () => { await api(`/admin/invoices/${i.id}/reconcile`, { body: { bank_reference: rec[i.id], amount_received: Number(i.amount), received_on: new Date().toISOString().slice(0, 10) } }); s.reload(); })}>Mark paid</button></div>}</td></tr>
      ))}</tbody></table>}</Load></div>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/admin/invoices', { body: { org_id: f.org_id, amount: Number(f.amount), currency: f.currency } }); s.reload(); }); }}>
        <h3>Issue invoice</h3>
        <Load state={orgs}>{(o: any[]) => <Field label="Organization"><select required value={f.org_id} onChange={(e) => setF({ ...f, org_id: e.target.value })}><option value="">—</option>{o.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}</Load>
        <Field label="Amount"><input type="number" required min={1} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Currency"><select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>TZS</option><option>USD</option></select></Field>
        <button className="btn primary">Issue</button>
        {a.error ? <ErrorBox error={a.error} /> : null}
      </form>
    </div>
  );
}

function Flags() {
  const s = useLoad(() => api('/admin/flags'));
  return <div className="card"><Load state={s}>{(f: any[]) => <table className="data"><tbody>{f.map((x) => <tr key={x.key}><td><code>{x.key}</code><div className="small muted">{x.description}</div></td><td><label><input type="checkbox" checked={x.enabled} onChange={async (e) => { await api(`/admin/flags/${x.key}`, { method: 'PATCH', body: { enabled: e.target.checked } }); s.reload(); }} /> enabled</label></td></tr>)}</tbody></table>}</Load></div>;
}

function Support() {
  const s = useLoad(() => api('/admin/support-access'));
  const [f, setF] = useState({ document_id: '', justification: '', hours: 2 });
  const [doc, setDoc] = useState<any>(null);
  const a = useAsync();
  return (
    <div className="grid cols-2">
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api('/admin/support-access', { body: { ...f, hours: Number(f.hours) } }); s.reload(); }); }}>
        <h3>Request time-limited support access</h3>
        <Field label="Document ID"><input required value={f.document_id} onChange={(e) => setF({ ...f, document_id: e.target.value })} /></Field>
        <Field label="Justification (min. 20 characters, e.g. ticket reference)"><textarea required minLength={20} value={f.justification} onChange={(e) => setF({ ...f, justification: e.target.value })} /></Field>
        <Field label="Hours (max 24)"><input type="number" min={1} max={24} value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} /></Field>
        <button className="btn primary">Grant (audited)</button>
        {a.error ? <ErrorBox error={a.error} /> : null}
      </form>
      <div className="card"><h3>Grants</h3><Load state={s}>{(g: any[]) => <table className="data small"><tbody>{g.map((x) => {
        const live = !x.revoked_at && new Date(x.expires_at) > new Date();
        return <tr key={x.id}><td><code>{x.document_id.slice(0, 8)}</code><div className="muted">{x.justification}</div></td><td>{live ? <Badge kind="warn">active until {fmtDate(x.expires_at)}</Badge> : <Badge>ended</Badge>}</td>
          <td>{live && <><button className="btn sm" onClick={() => a.run(async () => setDoc(await api(`/admin/support/documents/${x.document_id}`)))}>View</button><button className="btn sm ghost" onClick={async () => { await api(`/admin/support-access/${x.id}`, { method: 'DELETE' }); s.reload(); }}>Revoke</button></>}</td></tr>;
      })}</tbody></table>}</Load>
        {doc && <div className="doc-text small" style={{ whiteSpace: 'normal' }}><strong>{doc.title}</strong> (v{doc.version_no})<div dangerouslySetInnerHTML={{ __html: doc.content_html }} /></div>}
      </div>
    </div>
  );
}

function AuditAll() {
  const s = useLoad(() => api('/admin/audit'));
  return <div className="card table-wrap"><Load state={s}>{(r: any[]) => <table className="data small"><tbody>{r.map((x) => <tr key={x.id}><td>{fmtDate(x.created_at)}</td><td>{x.actor ?? 'system'}</td><td>{x.action}</td><td className="muted">{x.target_type} {String(x.target_id ?? '').slice(0, 8)}</td></tr>)}</tbody></table>}</Load></div>;
}
