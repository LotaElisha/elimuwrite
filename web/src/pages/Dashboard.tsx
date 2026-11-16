import { Link } from 'react-router-dom';
import { api, fmtDate } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Load, useLoad, Empty } from '../components/ui';

export default function Dashboard() {
  const { me, workspace } = useSession();
  const docs = useLoad(() => api('/documents'));
  const reps = useLoad(() => api('/reports'));
  const bill = useLoad(() => api('/billing'));
  const prog = useLoad(() => api('/me/progress'));
  if (workspace?.kind === 'institution') {
    return <div className="page"><h1>{workspace.name}</h1><p>Use the menu to open your courses or assignments. Your personal documents are in your personal workspace and are not visible to this institution.</p></div>;
  }
  return (
    <div className="page">
      <div className="row between"><h1>Welcome, {me?.name}</h1><Link className="btn primary" to="/documents?new=1">New document</Link></div>
      <div className="grid cols-2">
        <section className="card">
          <h2>Recent documents</h2>
          <Load state={docs}>{(d: any[]) => d.length === 0 ? <Empty>No documents yet. <Link to="/documents?new=1">Create</Link> or <Link to="/documents?import=1">import</Link> one.</Empty> : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{d.slice(0, 6).map((x) => <li key={x.id}><Link to={`/studio/${x.id}`}>{x.title}</Link> <span className="muted small">· v{x.current_version_no} · {x.word_count} words · {fmtDate(x.updated_at)}</span></li>)}</ul>
          )}</Load>
        </section>
        <section className="card">
          <h2>Recent reports</h2>
          <Load state={reps}>{(r: any[]) => r.length === 0 ? <Empty>No reports yet.</Empty> : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{r.slice(0, 6).map((x) => <li key={x.id}><Link to={`/reports/${x.id}`}>{x.document_title}</Link> <span className="muted small">v{x.version_no} · {x.kind}{x.percentage !== null ? ` · ${x.percentage}%` : ''}</span> {x.outdated && <Badge kind="warn">Outdated</Badge>}</li>)}</ul>
          )}</Load>
        </section>
        <section className="card">
          <h2>Usage this month</h2>
          <Load state={bill}>{(b: any) => (
            <div className="stack">
              <div>Plan: <strong>{b.plan_name}</strong></div>
              <Meter label="Similarity checks" used={(b.usage.similarity_check ?? 0) + (b.usage.pending_similarity ?? 0)} limit={b.limits.similarity_checks_per_month} />
              <Meter label="Words checked" used={b.usage.writing_check ?? 0} limit={b.limits.words_per_month} />
              <Link to="/billing" className="small">Plan & usage details</Link>
            </div>
          )}</Load>
        </section>
        <section className="card">
          <h2>Writing progress</h2>
          <Load state={prog}>{(p: any) => p.recurring.length === 0 ? <Empty>Run a writing check to see recurring learning needs.</Empty> : (
            <div><p className="small muted">Most frequent suggestions in the last 90 days:</p>
              <ul>{p.recurring.slice(0, 5).map((r: any) => <li key={r.rule_id}>{r.category.replace('_', ' ')} ({r.rule_id.replace('_', ' ')}): {r.times}</li>)}</ul>
              <Link to="/progress" className="small">Practice exercises</Link></div>
          )}</Load>
        </section>
      </div>
    </div>
  );
}

export function Meter({ label, used, limit }: { label: string; used: number; limit: number | null }) {
  const pct = limit ? Math.min(100, Math.round((100 * used) / limit)) : 0;
  return (
    <div>
      <div className="row between small"><span>{label}</span><span>{used.toLocaleString()} / {limit === null || limit === undefined ? 'unlimited' : limit.toLocaleString()}</span></div>
      {limit ? <div className="progress-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}><span style={{ width: pct + '%' }} /></div> : null}
    </div>
  );
}
