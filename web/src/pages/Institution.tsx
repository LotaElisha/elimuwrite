import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, download, fmtDate } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, ErrorBox, Field, Load, Notice, useAsync, useLoad, Empty, Denied } from '../components/ui';
import Billing from './Billing';

export function OrgOnboarding() {
  const nav = useNavigate();
  const { refresh, setWorkspace } = useSession();
  const [f, setF] = useState({ name: '', kind: 'university', timezone: 'Africa/Dar_es_Salaam', logo_url: '', departments: '', seats: 50 });
  const a = useAsync();
  return (
    <div className="page narrow">
      <h1>Set up an institution</h1>
      <p className="muted">Creates a 30-day trial workspace. You become its first administrator. Domain-wide sign-up stays off until you prove control of the domain.</p>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => {
        const o = await api('/orgs', { body: { name: f.name, kind: f.kind, timezone: f.timezone, logo_url: f.logo_url || undefined, departments: f.departments.split(',').map((x) => x.trim()).filter(Boolean), seats: Number(f.seats) } });
        await refresh(); setWorkspace(o.id); nav(`/org/${o.id}`);
      }); }}>
        <Field label="Institution name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="school">School</option><option value="college">College</option><option value="university">University</option><option value="training">Training organization</option><option value="research">Research institution</option></select></Field>
        <Field label="Timezone"><input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
        <Field label="Logo URL (optional)"><input type="url" value={f.logo_url} onChange={(e) => setF({ ...f, logo_url: e.target.value })} /></Field>
        <Field label="Departments" hint="Comma-separated"><input value={f.departments} onChange={(e) => setF({ ...f, departments: e.target.value })} /></Field>
        <Field label="Seats needed"><input type="number" min={1} value={f.seats} onChange={(e) => setF({ ...f, seats: Number(e.target.value) })} /></Field>
        {a.error ? <ErrorBox error={a.error} /> : null}
        <button className="btn primary" disabled={a.busy}>Create trial workspace</button>
      </form>
    </div>
  );
}

export function OrgAdmin() {
  const { id } = useParams();
  const org = useLoad(() => api(`/orgs/${id}`), [id]);
  const [tab, setTab] = useState('overview');
  return (
    <div className="page">
      <Load state={org}>{(o: any) => {
        const admin = o.my_roles.includes('org_admin');
        const billing = o.my_roles.includes('billing_admin');
        if (!admin && !billing) return <Denied />;
        const tabs = [
          ...(admin ? [['overview', 'Overview'], ['members', 'Members'], ['policies', 'Policies & settings'], ['repository', 'Repository'], ['domains', 'Domains'], ['analytics', 'Analytics'], ['integrations', 'Integrations'], ['audit', 'Audit log']] : []),
          ['billing', 'Billing'],
        ];
        return (
          <>
            <div className="row">{o.logo_url && <img src={o.logo_url} alt="" height={40} />}<h1>{o.name}</h1>{o.is_demo && <Badge kind="warn">Demo data</Badge>}</div>
            <p className="muted small">Timezone {o.timezone} · {o.counts.members} members · {o.counts.courses} courses {o.trial_ends_at && `· trial ends ${fmtDate(o.trial_ends_at)}`}</p>
            {billing && !admin && <Notice>Billing administrators manage seats, invoices and usage. They do not have access to student work.</Notice>}
            <div className="tabs" role="tablist">{tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}</div>
            <div style={{ marginTop: 16 }}>
              {tab === 'overview' && <Overview o={o} />}
              {tab === 'members' && <Members id={id!} />}
              {tab === 'policies' && <Policies o={o} onSaved={org.reload} />}
              {tab === 'repository' && <Repository id={id!} />}
              {tab === 'domains' && <Domains id={id!} />}
              {tab === 'analytics' && <Analytics id={id!} />}
              {tab === 'integrations' && <Integrations />}
              {tab === 'audit' && <Audit id={id!} />}
              {tab === 'billing' && <Billing orgId={id} />}
            </div>
          </>
        );
      }}</Load>
    </div>
  );
}

function Overview({ o }: { o: any }) {
  const [dep, setDep] = useState('');
  return (
    <div className="grid cols-2">
      <div className="card"><h2>Departments</h2>{o.departments.length === 0 ? <Empty /> : <ul>{o.departments.map((d: any) => <li key={d.id}>{d.name}</li>)}</ul>}
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await api(`/orgs/${o.id}/departments`, { body: { name: dep } }); setDep(''); location.reload(); }}><input aria-label="New department" value={dep} onChange={(e) => setDep(e.target.value)} /><button className="btn sm" disabled={!dep}>Add</button></form></div>
      <div className="card"><h2>Getting started</h2><ol className="small"><li>Invite instructors and students (Members).</li><li>Set the default assistance policy and retention (Policies).</li><li>Add authorised documents to the repository.</li><li>Instructors create courses and assignments.</li></ol></div>
    </div>
  );
}

function Members({ id }: { id: string }) {
  const s = useLoad(() => api(`/orgs/${id}/members`), [id]);
  const [inv, setInv] = useState({ email: '', roles: 'student', max_uses: 1 });
  const [link, setLink] = useState<string | null>(null);
  const [csv, setCsv] = useState('email,name,role\n');
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const a = useAsync();
  return (
    <div className="grid cols-2">
      <section className="card">
        <h2>Members</h2>
        <Load state={s}>{(m: any[]) => (
          <table className="data small"><tbody>{m.map((x) => (
            <tr key={x.id}><td>{x.name}<div className="muted">{x.email}</div></td><td>{x.roles.map((r: string) => <Badge key={r}>{r.replace('_', ' ')}</Badge>)}</td>
              <td><select aria-label={`Roles for ${x.name}`} value="" onChange={async (e) => { if (!e.target.value) return; const roles = x.roles.includes(e.target.value) ? x.roles.filter((r: string) => r !== e.target.value) : [...x.roles, e.target.value]; if (!roles.length) return; await a.run(() => api(`/orgs/${id}/members/${x.id}`, { method: 'PATCH', body: { roles } })); s.reload(); }}>
                <option value="">Toggle role…</option>{['student', 'instructor', 'reviewer', 'org_admin', 'billing_admin'].map((r) => <option key={r} value={r}>{r}</option>)}</select>
                <Badge kind={x.status === 'active' ? 'ok' : 'bad'}>{x.status}</Badge></td></tr>
          ))}</tbody></table>
        )}</Load>
        {a.error ? <ErrorBox error={a.error} /> : null}
      </section>
      <section className="stack">
        <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api(`/orgs/${id}/invitations`, { body: { email: inv.email || undefined, roles: [inv.roles], max_uses: Number(inv.max_uses) } }); setLink(r.link); }); }}>
          <h3>Invitation link</h3>
          <Field label="Email (leave blank for a shared link)"><input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
          <Field label="Role"><select value={inv.roles} onChange={(e) => setInv({ ...inv, roles: e.target.value })}>{['student', 'instructor', 'reviewer', 'org_admin', 'billing_admin'].map((r) => <option key={r}>{r}</option>)}</select></Field>
          {!inv.email && <Field label="Maximum uses"><input type="number" min={1} value={inv.max_uses} onChange={(e) => setInv({ ...inv, max_uses: Number(e.target.value) })} /></Field>}
          <button className="btn">Create link</button>
          {link && <p><input readOnly value={link} aria-label="Invitation link" style={{ width: '100%' }} onFocus={(e) => e.target.select()} /></p>}
          <p className="small muted">Administrator roles can only be invited by email. Email delivery is not configured: share links directly.</p>
        </form>
        <div className="card">
          <h3>Bulk import (CSV)</h3>
          <Field label="CSV with columns email, name, role" hint="Roles: student, instructor, reviewer. Administrators must be invited individually."><textarea rows={6} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} /></Field>
          <input type="file" accept=".csv,text/csv" aria-label="Upload CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setCsv(await f.text()); setPreview(null); } }} />
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => a.run(async () => setPreview(await api(`/orgs/${id}/members/import/preview`, { body: { csv } })))}>Preview</button>
            <button className="btn primary" disabled={!preview} onClick={() => a.run(async () => { setResult(await api(`/orgs/${id}/members/import/commit`, { body: { csv, preview_hash: preview.preview_hash } })); setPreview(null); s.reload(); })}>Confirm import</button>
          </div>
          {preview && (
            <div>
              <p className="small">{Object.entries(preview.summary).map(([k, v]) => `${String(k).replace(/_/g, ' ')}: ${v}`).join(' · ')}</p>
              <table className="data small"><thead><tr><th>Line</th><th>Email</th><th>Role</th><th>Result</th></tr></thead><tbody>{preview.rows.map((r: any) => <tr key={r.line}><td>{r.line}</td><td>{r.email}</td><td>{r.role}</td><td><Badge kind={['new_invitation', 'add_existing_user'].includes(r.status) ? 'ok' : 'warn'}>{r.status.replace(/_/g, ' ')}</Badge></td></tr>)}</tbody></table>
            </div>
          )}
          {result && <Notice kind="success">Added {result.added_existing} existing user(s); created {result.invitations.length} invitation(s); skipped {result.skipped}. {result.note}<ul className="small">{result.invitations.map((i: any) => <li key={i.email}>{i.email}: <code>{i.link}</code></li>)}</ul></Notice>}
        </div>
      </section>
    </div>
  );
}

function Policies({ o, onSaved }: { o: any; onSaved: () => void }) {
  const { config } = useSession();
  const [st, setSt] = useState(o.settings);
  const a = useAsync();
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/orgs/${o.id}`, { method: 'PATCH', body: { settings: { anonymous_marking: st.anonymous_marking, repository_inclusion: st.repository_inclusion, retention_days: Number(st.retention_days), offline_drafts_allowed: st.offline_drafts_allowed, default_assistance_preset: st.default_assistance_preset } } }); onSaved(); }); }}>
      <h2>Policies & settings</h2>
      <Field label="Default assistance policy for new assignments"><select value={st.default_assistance_preset} onChange={(e) => setSt({ ...st, default_assistance_preset: e.target.value })}>{(config?.assistancePresets ?? []).map((p: any) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
      <label style={{ display: 'block' }}><input type="checkbox" checked={st.anonymous_marking} onChange={(e) => setSt({ ...st, anonymous_marking: e.target.checked })} /> Anonymous marking (hide student names from markers)</label>
      <label style={{ display: 'block' }}><input type="checkbox" checked={st.offline_drafts_allowed} onChange={(e) => setSt({ ...st, offline_drafts_allowed: e.target.checked })} /> Allow offline drafts on devices (consider shared computers)</label>
      <Field label="Repository inclusion" hint="Submissions are always compared within their own assignment. Adding documents to the institution repository is a separate, explicit action."><select value={st.repository_inclusion} onChange={(e) => setSt({ ...st, repository_inclusion: e.target.value })}><option value="none">No repository</option><option value="opt_in">Administrators add items explicitly</option></select></Field>
      <Field label="Retention of submissions (days)" hint="Submissions, their frozen versions, indexes and reports are deleted after this period by the retention job."><input type="number" min={30} max={3650} value={st.retention_days} onChange={(e) => setSt({ ...st, retention_days: e.target.value })} /></Field>
      <p className="small">Cross-institution comparison: <Badge>Disabled</Badge> (not available without agreements between institutions).</p>
      {a.error ? <ErrorBox error={a.error} /> : null}
      <button className="btn primary" disabled={a.busy}>Save settings</button>
    </form>
  );
}

function Repository({ id }: { id: string }) {
  const s = useLoad(() => api(`/orgs/${id}/repository`), [id]);
  const [f, setF] = useState({ title: '', text: '', inclusion_reason: '', rights: false });
  const a = useAsync();
  return (
    <div className="grid cols-2">
      <section className="card"><h2>Institution repository</h2><p className="small muted">Only these documents (plus assignment templates and same-assignment submissions) are used for institutional similarity checks.</p>
        <Load state={s}>{(r: any[]) => r.length === 0 ? <Empty /> : <table className="data small"><tbody>{r.map((x) => <tr key={x.id}><td>{x.title}<div className="muted">{x.inclusion_reason}</div></td><td>{x.token_count} words</td><td><button className="btn sm ghost danger" onClick={async () => { await api(`/orgs/${id}/repository/${x.id}`, { method: 'DELETE' }); s.reload(); }}>Remove</button></td></tr>)}</tbody></table>}</Load></section>
      <form className="card" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/orgs/${id}/repository`, { body: { title: f.title, text: f.text, inclusion_reason: f.inclusion_reason, rights_confirmed: f.rights } }); setF({ title: '', text: '', inclusion_reason: '', rights: false }); s.reload(); }); }}>
        <h3>Add authorised document</h3>
        <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Text"><textarea required rows={6} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></Field>
        <Field label="Why is this included?"><input required minLength={10} value={f.inclusion_reason} onChange={(e) => setF({ ...f, inclusion_reason: e.target.value })} /></Field>
        <label><input type="checkbox" required checked={f.rights} onChange={(e) => setF({ ...f, rights: e.target.checked })} /> The institution has the right to use this document for comparison.</label>
        {a.error ? <ErrorBox error={a.error} /> : null}
        <button className="btn primary" disabled={a.busy}>Add to repository</button>
      </form>
    </div>
  );
}

function Domains({ id }: { id: string }) {
  const s = useLoad(() => api(`/orgs/${id}/domains`), [id]);
  const [domain, setDomain] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const a = useAsync();
  return (
    <div className="card">
      <h2>Email domains</h2>
      <Notice>Verify control of a domain with a DNS TXT record before enabling domain sign-up. Accounts created through a verified domain join as students only; an email address never grants administrator rights.</Notice>
      <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { const r = await api(`/orgs/${id}/domains`, { body: { domain } }); setMsg(r.instructions); setDomain(''); s.reload(); }); }}><input placeholder="example.ac.tz" aria-label="Domain" value={domain} onChange={(e) => setDomain(e.target.value)} /><button className="btn">Add domain</button></form>
      {msg && <Notice>{msg}</Notice>}
      {a.error ? <ErrorBox error={a.error} /> : null}
      <Load state={s}>{(d: any[]) => d.length === 0 ? <Empty /> : <table className="data"><tbody>{d.map((x) => (
        <tr key={x.id}><td>{x.domain}</td><td><code className="small">{x.verification_token}</code></td><td>{x.verified_at ? <Badge kind="ok">Verified</Badge> : <button className="btn sm" onClick={() => a.run(async () => { const r = await api(`/orgs/${id}/domains/${x.id}/verify`, { method: 'POST' }); setMsg(r.verified ? 'Domain verified.' : r.message); s.reload(); })}>Verify</button>}</td>
          <td><label className="small"><input type="checkbox" disabled={!x.verified_at} checked={x.provisioning_enabled} onChange={(e) => a.run(async () => { await api(`/orgs/${id}/domains/${x.id}`, { method: 'PATCH', body: { provisioning_enabled: e.target.checked } }); s.reload(); })} /> Students with this domain can join</label></td></tr>
      ))}</tbody></table>}</Load>
    </div>
  );
}

function Analytics({ id }: { id: string }) {
  const s = useLoad(() => api(`/orgs/${id}/analytics`), [id]);
  return (
    <Load state={s}>{(d: any) => (
      <div className="grid cols-2">
        <section className="card"><h3>Adoption</h3><ul>{d.adoption.map((x: any) => <li key={x.role}>{x.role.replace('_', ' ')}: {x.members}</li>)}</ul></section>
        <section className="card"><h3>Marking workload</h3><p>Awaiting marking: {d.marking_workload.awaiting_marking} · approved, not released: {d.marking_workload.awaiting_release} · released: {d.marking_workload.released}</p></section>
        <section className="card"><h3>Submission completion</h3><table className="data small"><tbody>{d.submission_completion.map((x: any) => <tr key={x.id}><td>{x.course} · {x.title}</td><td>{x.submitted} / {x.enrolled}</td></tr>)}</tbody></table></section>
        <section className="card"><h3>Common writing difficulties</h3>{d.common_writing_difficulties.length === 0 ? <p className="small muted">Not enough data yet.</p> : <ul>{d.common_writing_difficulties.map((x: any) => <li key={x.category}>{x.category.replace('_', ' ')}: {x.students} students</li>)}</ul>}<p className="small muted">{d.note}</p></section>
        <section className="card"><h3>Resource consumption</h3><table className="data small"><tbody>{d.resource_consumption.map((x: any) => <tr key={x.kind + x.period}><td>{x.period}</td><td>{x.kind.replace('_', ' ')}</td><td>{x.quantity}</td></tr>)}</tbody></table>
          <button className="btn sm" onClick={() => download(`/orgs/${id}/exports/submissions.csv`)}>Export submissions CSV</button></section>
        <p className="small muted">Similarity and detection scores are never used to rank students.</p>
      </div>
    )}</Load>
  );
}

function Integrations() {
  const { config } = useSession();
  return (
    <div className="card">
      <h2>Integrations</h2>
      <p className="small muted">A settings screen is not a working integration. Each item shows its real status.</p>
      <table className="data"><tbody>{(config?.providers ?? []).map((p: any) => <tr key={p.key}><td>{p.name}</td><td><Badge kind={p.status === 'configured' ? 'ok' : 'warn'}>{p.status === 'configured' ? 'Configured' : 'Not configured'}</Badge></td><td className="small muted">{p.detail}</td></tr>)}</tbody></table>
    </div>
  );
}

function Audit({ id }: { id: string }) {
  const s = useLoad(() => api(`/orgs/${id}/audit`), [id]);
  return <div className="card table-wrap"><Load state={s}>{(r: any[]) => <table className="data small"><tbody>{r.map((x, i) => <tr key={i}><td>{fmtDate(x.created_at)}</td><td>{x.actor ?? 'system'}</td><td>{x.action}</td><td className="muted">{x.target_type} {x.target_id?.slice(0, 8)}</td></tr>)}</tbody></table>}</Load></div>;
}
