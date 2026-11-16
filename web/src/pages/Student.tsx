import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, uid } from '../lib/api';
import { useSession } from '../lib/session';
import { useI18n } from '../lib/i18n';
import { Badge, ErrorBox, Field, Load, Notice, PolicyList, useAsync, useLoad, Empty } from '../components/ui';

export function MyAssignments() {
  const { workspace } = useSession();
  const s = useLoad(() => api('/me/assignments' + (workspace?.kind === 'institution' ? `?org=${workspace.id}` : '')), [workspace?.id]);
  return (
    <div className="page">
      <h1>My assignments</h1>
      <Load state={s}>{(a: any[]) => a.length === 0 ? <Empty>You are not enrolled in any course with assignments yet.</Empty> : (
        <div className="card table-wrap"><table className="data">
          <thead><tr><th>Assignment</th><th>Course</th><th>Due</th><th>Submissions</th><th>Feedback</th></tr></thead>
          <tbody>{a.map((x) => (
            <tr key={x.id}><td><Link to={`/assignments/${x.id}`}>{x.title}</Link></td><td>{x.course_code}</td><td>{fmtDate(x.due_at, x.timezone)}</td><td>{x.attempts}/{x.max_attempts}</td>
              <td>{x.grade_status === 'released' ? <Badge kind="ok">Released</Badge> : x.grade_status === 'revision_requested' ? <Badge kind="warn">Revision requested</Badge> : x.attempts ? <Badge>Awaiting feedback</Badge> : <Badge>Not submitted</Badge>}</td></tr>
          ))}</tbody>
        </table></div>
      )}</Load>
    </div>
  );
}

export function AssignmentPage() {
  const { id } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const s = useLoad(() => api(`/assignments/${id}`), [id]);
  const [disclosure, setDisclosure] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [receipt, setReceipt] = useState<any>(null);
  const [key] = useState(() => uid()); // one idempotency key per submit intent: retries can't double-submit
  const a = useAsync();
  return (
    <div className="page">
      <Load state={s}>{(as: any) => {
        if (as.is_instructor) { nav(`/teach/assignments/${id}`, { replace: true }); return null; }
        const latestNo = as.my_document?.current_version_no;
        const lastSubmittedVersion = as.my_submissions[0]?.version_no;
        return (
          <>
            <p className="muted">{as.org_name} · {as.course_code} {as.course_title}</p>
            <h1>{as.title}</h1>
            <div className="grid cols-2">
              <section className="card">
                <h2>Instructions</h2>
                <p style={{ whiteSpace: 'pre-wrap' }}>{as.instructions || <em>No instructions.</em>}</p>
                <p>Due: <strong>{fmtDate(as.due_at, as.timezone)}</strong> · Up to {as.max_attempts} submission(s)</p>
                {as.rubric && <details><summary>Rubric: {as.rubric.title}</summary><ul>{as.rubric.criteria.map((c: any) => <li key={c.id}><strong>{c.title}</strong> ({c.max_points} pts): {c.description}</li>)}</ul></details>}
              </section>
              <section className="card">
                <h2>{t('policy.title')}</h2>
                <p><Badge kind="info">{as.assistance_label}</Badge> <span className="small muted">policy version {as.policy_version}</span></p>
                <PolicyList policy={as.policy} />
                <p className="small muted">{as.policy_scope_note}</p>
              </section>
            </div>
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Your work</h2>
              {!as.my_document ? (
                <button className="btn primary" disabled={a.busy} onClick={() => a.run(async () => { const r = await api(`/assignments/${id}/start`, { method: 'POST' }); nav(`/studio/${r.document_id}`); })}>I have read the rules: start writing</button>
              ) : (
                <div className="stack">
                  <div className="row"><Link className="btn" to={`/studio/${as.my_document.id}`}>Open draft (version {latestNo})</Link></div>
                  {as.my_submissions.length < as.max_attempts && latestNo !== lastSubmittedVersion && (
                    <div className="stack">
                      {as.policy.disclosure_required && <Field label="AI-assistance disclosure (required)" hint="Describe any AI tools you used and how. You can edit this before submitting."><textarea value={disclosure} onChange={(e) => setDisclosure(e.target.value)} rows={4} /></Field>}
                      {!as.policy.disclosure_required && <Field label="AI-assistance disclosure (optional)"><textarea value={disclosure} onChange={(e) => setDisclosure(e.target.value)} rows={3} /></Field>}
                      <label><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I want to submit version {latestNo}. I understand it will be frozen and cannot be changed.</label>
                      <button className="btn primary" disabled={!confirm || a.busy || !navigator.onLine} onClick={() => a.run(async () => { const r = await api(`/assignments/${id}/submissions`, { body: { document_id: as.my_document.id, idempotency_key: key, disclosure: disclosure || undefined, expected_version_no: latestNo } }); setReceipt(r); s.reload(); })}>{a.busy ? 'Submitting…' : 'Submit'}</button>
                      {!navigator.onLine && <Notice kind="warn">You are offline. A draft is not submitted until the server confirms receipt.</Notice>}
                    </div>
                  )}
                  {latestNo === lastSubmittedVersion && <Notice>Your latest version is already submitted. Edit your draft to prepare a new attempt.</Notice>}
                  {a.error ? <ErrorBox error={a.error} /> : null}
                  {receipt && <Notice kind="success"><strong>Submission received.</strong> Attempt {receipt.receipt.attempt_no} at {fmtDate(receipt.receipt.received_at, receipt.receipt.timezone)}. Receipt fingerprint {receipt.receipt.content_hash.slice(0, 16)}… {receipt.receipt.is_late && <Badge kind="warn">Late</Badge>} <br /><span className="small">{receipt.note}</span></Notice>}
                </div>
              )}
            </section>
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Submission receipts</h2>
              {as.my_submissions.length === 0 ? <Empty>No submissions yet.</Empty> : (
                <table className="data"><thead><tr><th>Attempt</th><th>Received (server time)</th><th>Version</th><th>Fingerprint</th><th>Status</th></tr></thead>
                  <tbody>{as.my_submissions.map((x: any) => <tr key={x.id}><td><Link to={`/submissions/${x.id}`}>#{x.attempt_no}</Link></td><td>{fmtDate(x.received_at, as.timezone)} {x.is_late && <Badge kind="warn">Late</Badge>}</td><td>v{x.version_no}</td><td><code>{x.content_hash.slice(0, 12)}</code></td><td>{x.feedback_released ? <Link to={`/submissions/${x.id}`}>Feedback available</Link> : 'Submitted'}</td></tr>)}</tbody></table>
              )}
            </section>
          </>
        );
      }}</Load>
    </div>
  );
}

export function SubmissionPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const s = useLoad(() => api(`/submissions/${id}`), [id]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'response' | 'appeal'>('response');
  const a = useAsync();
  return (
    <div className="page">
      <Load state={s}>{(x: any) => {
        if (x.role === 'staff') { nav(`/review/${id}`, { replace: true }); return null; }
        const r = x.receipt;
        return (
          <>
            <h1>{r.assignment_title}: attempt {r.attempt_no}</h1>
            <section className="card">
              <h2>Receipt</h2>
              <p>Received {fmtDate(r.received_at, r.timezone)} {r.is_late && <Badge kind="warn">Late</Badge>}</p>
              <p className="small">Content fingerprint (SHA-256): <code>{r.content_hash}</code> · assistance policy version {r.policy_version}</p>
            </section>
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Feedback</h2>
              {!x.feedback ? <Empty>Your instructor has not released feedback yet.</Empty> : (
                <div className="stack">
                  {x.feedback.status === 'revision_requested' && <Notice kind="warn">Your instructor has requested a revision.</Notice>}
                  {x.feedback.total !== null && <p className="big-pct" style={{ color: 'var(--c-feedback)' }}>{x.feedback.total} / {x.feedback.max_total}</p>}
                  {x.rubric && <table className="data"><tbody>{x.rubric.criteria.map((c: any) => <tr key={c.id}><td>{c.title}</td><td>{x.feedback.rubric_scores[c.id] ?? '—'} / {c.max_points}</td></tr>)}</tbody></table>}
                  <p style={{ whiteSpace: 'pre-wrap' }}>{x.feedback.feedback}</p>
                  {x.comments.map((c: any, i: number) => <div className="sugg" key={i}>{c.quote && <blockquote className="small">“{c.quote}”</blockquote>}{c.body}</div>)}
                  <p className="small muted">Released {fmtDate(x.feedback.released_at)}. Approved by your instructor.</p>
                </div>
              )}
            </section>
            {x.feedback && (
              <section className="card" style={{ marginTop: 16 }}>
                <h2>Respond or request a review</h2>
                {x.responses.map((r: any) => <div key={r.id} className="sugg"><Badge>{r.kind}</Badge> <Badge kind={r.status === 'open' ? 'warn' : 'ok'}>{r.status}</Badge><p>{r.body}</p>{r.decision && <p className="small"><strong>Decision:</strong> {r.decision}</p>}</div>)}
                <Field label="Type"><select value={kind} onChange={(e) => setKind(e.target.value as any)}><option value="response">Response to feedback</option><option value="appeal">Request a review of the grade</option></select></Field>
                <Field label="Message"><textarea value={body} onChange={(e) => setBody(e.target.value)} /></Field>
                <button className="btn primary" disabled={!body.trim() || a.busy} onClick={() => a.run(async () => { await api(`/submissions/${id}/responses`, { body: { kind, body } }); setBody(''); s.reload(); })}>Send</button>
                {a.error ? <ErrorBox error={a.error} /> : null}
              </section>
            )}
          </>
        );
      }}</Load>
    </div>
  );
}
