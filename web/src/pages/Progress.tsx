import { useState } from 'react';
import { api } from '../lib/api';
import { Load, useLoad, Empty } from '../components/ui';

export default function Progress() {
  const s = useLoad(() => api('/me/progress'));
  const [lessons, setLessons] = useState<Record<string, any>>({});
  return (
    <div className="page">
      <h1>Learning progress</h1>
      <p className="muted">Based on suggestions from writing checks in the last 90 days. These indicators are separate from grades and similarity results.</p>
      <Load state={s}>{(p: any) => (
        <div className="grid cols-2">
          <section className="card">
            <h2>Recurring difficulties</h2>
            {p.recurring.length === 0 ? <Empty>Run a writing check to see patterns.</Empty> : p.recurring.map((r: any) => (
              <div key={r.rule_id} className="sugg">
                <div className="row between"><strong>{r.category.replace('_', ' ')} · {r.rule_id.replace('_', ' ')}</strong><span>{r.times}×</span></div>
                {lessons[r.rule_id] ? <div className="small"><p>{lessons[r.rule_id].rule}</p><p><em>Practice:</em> {lessons[r.rule_id].practice.prompt}</p><details><summary>Answer</summary>{lessons[r.rule_id].practice.answer}</details></div>
                  : <button className="btn sm" onClick={async () => setLessons({ ...lessons, [r.rule_id]: await api(`/lessons/${r.rule_id}`) })}>Optional exercise</button>}
              </div>
            ))}
          </section>
          <section className="card">
            <h2>Activity (30 days)</h2>
            {p.activity.length === 0 ? <Empty /> : <table className="data"><thead><tr><th>Day</th><th>Saves</th><th>Words (latest)</th></tr></thead><tbody>{p.activity.map((a: any) => <tr key={a.day}><td>{String(a.day).slice(0, 10)}</td><td>{a.saves}</td><td>{a.words}</td></tr>)}</tbody></table>}
            <p className="small">Documents: {p.documents} · Reports: {p.reports}</p>
            <p className="small">Suggestion decisions: {p.decisions.map((d: any) => `${d.outcome} ${d.n}`).join(', ') || 'none yet'}</p>
          </section>
        </div>
      )}</Load>
    </div>
  );
}
