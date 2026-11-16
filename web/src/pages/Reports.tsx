import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../lib/api';
import { Badge, Load, useLoad, Empty, Pct } from '../components/ui';

export default function Reports() {
  const s = useLoad(() => api('/reports'));
  const [sel, setSel] = useState<string[]>([]);
  const cmp = useLoad(() => (sel.length === 2 ? api(`/reports/compare?a=${sel[0]}&b=${sel[1]}`) : Promise.resolve(null)), [sel.join()]);
  return (
    <div className="page">
      <h1>Reports</h1>
      <p className="muted">Select two similarity reports for the same document to compare successive revisions.</p>
      <Load state={s}>{(r: any[]) => r.length === 0 ? <Empty>No reports yet. Run a similarity check from the Writing Studio.</Empty> : (
        <div className="table-wrap card"><table className="data">
          <thead><tr><th>Compare</th><th>Report</th><th>Document</th><th>Version</th><th>Type</th><th>Result</th><th>Date</th></tr></thead>
          <tbody>{r.map((x) => (
            <tr key={x.id}>
              <td>{x.kind === 'similarity' && <input type="checkbox" aria-label={`Compare ${x.report_number}`} checked={sel.includes(x.id)} onChange={(e) => setSel(e.target.checked ? [...sel, x.id].slice(-2) : sel.filter((i) => i !== x.id))} />}</td>
              <td><Link to={`/reports/${x.id}`}>{x.report_number}</Link></td><td>{x.document_title}</td><td>v{x.version_no} {x.outdated && <Badge kind="warn">Outdated</Badge>}</td>
              <td>{x.kind}</td><td>{x.kind === 'similarity' ? (x.status === 'completed' ? <Pct value={x.percentage === null ? null : Number(x.percentage)} /> : <Badge kind="warn">{x.status.replace('_', ' ')}</Badge>) : x.status}</td><td>{fmtDate(x.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}</Load>
      {sel.length === 2 && <Load state={cmp}>{(c: any) => c && (
        <div className="side-by-side" style={{ marginTop: 16 }}>
          {c.map((r: any) => (
            <div className="card" key={r.id}>
              <h3>{r.report_number} · version {r.version_no}</h3>
              <div className="big-pct"><Pct value={r.result.adjusted.percentage} /></div>
              <p className="small">Original {r.result.original.percentage ?? '—'}% · {r.result.original.matched}/{r.result.original.eligible} eligible words</p>
              <ul className="small">{r.sources.map((s: any) => <li key={s.id}>{s.label}: {s.adjusted_percentage}%</li>)}</ul>
            </div>
          ))}
        </div>
      )}</Load>}
    </div>
  );
}
