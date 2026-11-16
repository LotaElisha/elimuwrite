import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, ErrorBox, Field, Load, Notice, PolicyList, useAsync, useLoad, Empty, Pct } from '../components/ui';
import { ReportView } from './Report';

export function Courses() {
  const { workspace } = useSession();
  const orgId = workspace?.kind === 'institution' ? workspace.id : null;
  const s = useLoad(() => (orgId ? api(`/orgs/${orgId}/courses`) : api('/me/courses')), [orgId]);
  const [f, setF] = useState({ code: '', title: '', term: '' });
  const a = useAsync();
  const canCreate = workspace?.roles?.some((r) => r === 'org_admin' || r === 'instructor');
  return (
    <div className="page">
      <h1>Courses</h1>
      {!orgId && <Notice>Switch to an institution workspace to manage courses.</Notice>}
      <Load state={s}>{(c: any[]) => c.length === 0 ? <Empty>No courses yet.</Empty> : (
        <div className="grid cols-3">{c.map((x) => <Link key={x.id} to={`/courses/${x.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}><h3>{x.code}</h3><p>{x.title}</p><p className="small muted">{x.term ?? ''} · {x.students ?? '—'} students</p></Link>)}</div>
      )}</Load>
      {orgId && canCreate && (
        <form className="card row" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/orgs/${orgId}/courses`, { body: { code: f.code, title: f.title, term: f.term || undefined } }); setF({ code: '', title: '', term: '' }); s.reload(); }); }}>
          <Field label="Code"><input required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
          <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Term"><input value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })} /></Field>
          <button className="btn primary" disabled={a.busy}>Create course</button>
          {a.error ? <ErrorBox error={a.error} /> : null}
        </form>
      )}
    </div>
  );
}

export function CoursePage() {
  const { id } = useParams();
  const { config } = useSession();
  const s = useLoad(() => api(`/courses/${id}`), [id]);
  const [email, setEmail] = useState('');
  const [show, setShow] = useState(false);
  const a = useAsync();
  return (
    <div className="page">
      <Load state={s}>{(c: any) => (
        <>
          <p className="muted">{c.org_name} · {c.term}</p>
          <h1>{c.code}: {c.title}</h1>
          <div className="grid cols-2">
            <section className="card">
              <div className="row between"><h2>Assignments</h2>{c.is_instructor && <button className="btn primary sm" onClick={() => setShow(!show)}>New assignment</button>}</div>
              {c.assignments.length === 0 ? <Empty /> : <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>{c.assignments.map((x: any) => <li key={x.id}><Link to={c.is_instructor ? `/teach/assignments/${x.id}` : `/assignments/${x.id}`}>{x.title}</Link> <span className="small muted">due {fmtDate(x.due_at, c.timezone)}</span></li>)}</ul>}
            </section>
            {c.is_instructor && (
              <section className="card">
                <h2>Members</h2>
                <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/courses/${id}/members`, { body: { email, role: 'student' } }); setEmail(''); s.reload(); }); }}>
                  <input type="email" placeholder="Student email (must be an institution member)" aria-label="Student email" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn sm">Enroll</button>
                </form>
                {a.error ? <ErrorBox error={a.error} /> : null}
                <table className="data small"><tbody>{c.members.map((m: any) => <tr key={m.id + m.role}><td>{m.name}</td><td>{m.email}</td><td><Badge>{m.role}</Badge></td></tr>)}</tbody></table>
              </section>
            )}
          </div>
          {show && <NewAssignment courseId={id!} orgId={c.org_id} presets={config?.assistancePresets ?? []} onDone={() => { setShow(false); s.reload(); }} />}
        </>
      )}</Load>
    </div>
  );
}

function NewAssignment({ courseId, orgId, presets, onDone }: { courseId: string; orgId: string; presets: any[]; onDone: () => void }) {
  const rubrics = useLoad(() => api(`/orgs/${orgId}/rubrics`), [orgId]);
  const [f, setF] = useState<any>({ title: '', instructions: '', due_at: '', max_attempts: 3, assistance_preset: 'guided_learning', rubric_id: '', template_text: '', exclude_quotes: true, exclude_bibliography: true, min_match_words: 8, compare_within_class: true, include_repository: true, show_report_to_students: false, accepted: ['editor', 'txt', 'docx', 'pdf'] });
  const [rub, setRub] = useState('Argument|10\nUse of sources|10\nClarity and mechanics|5');
  const a = useAsync();
  const preset = presets.find((p) => p.key === f.assistance_preset);
  return (
    <form className="card" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); a.run(async () => {
      let rubric_id = f.rubric_id || null;
      if (!rubric_id && rub.trim()) {
        const r = await api(`/orgs/${orgId}/rubrics`, { body: { title: `${f.title} rubric`, criteria: rub.split('\n').filter(Boolean).map((l, i) => { const [title, pts] = l.split('|'); return { id: `c${i + 1}`, title: title.trim(), description: '', max_points: Number(pts) || 10 }; }) } });
        rubric_id = r.id;
      }
      await api(`/courses/${courseId}/assignments`, { body: {
        title: f.title, instructions: f.instructions, due_at: f.due_at ? new Date(f.due_at).toISOString() : null, max_attempts: Number(f.max_attempts), accepted_types: f.accepted,
        assistance_preset: f.assistance_preset, rubric_id, template_text: f.template_text || undefined,
        similarity_settings: { exclude_quotes: f.exclude_quotes, exclude_bibliography: f.exclude_bibliography, min_match_words: Number(f.min_match_words), compare_within_class: f.compare_within_class, include_repository: f.include_repository, include_own_drafts: false, show_report_to_students: f.show_report_to_students },
      } });
      onDone();
    }); }}>
      <h2>New assignment</h2>
      <div className="grid cols-2">
        <div>
          <Field label="Title"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Instructions"><textarea value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
          <Field label="Deadline" hint="Entered in your local time; stored as server time."><input type="datetime-local" value={f.due_at} onChange={(e) => setF({ ...f, due_at: e.target.value })} /></Field>
          <Field label="Maximum submissions (resubmission rule)"><input type="number" min={1} max={20} value={f.max_attempts} onChange={(e) => setF({ ...f, max_attempts: e.target.value })} /></Field>
          <fieldset><legend className="field-label">Accepted submission types</legend>{['editor', 'txt', 'docx', 'pdf'].map((t) => <label key={t} className="small" style={{ marginRight: 10 }}><input type="checkbox" checked={f.accepted.includes(t)} onChange={(e) => setF({ ...f, accepted: e.target.checked ? [...f.accepted, t] : f.accepted.filter((x: string) => x !== t) })} /> {t}</label>)}</fieldset>
          <Field label="Assignment template text (matches are shown but not counted)"><textarea rows={3} value={f.template_text} onChange={(e) => setF({ ...f, template_text: e.target.value })} /></Field>
        </div>
        <div>
          <Field label="Assistance policy"><select value={f.assistance_preset} onChange={(e) => setF({ ...f, assistance_preset: e.target.value })}>{presets.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></Field>
          {preset && <PolicyList policy={preset.policy} />}
          <h3>Similarity settings</h3>
          {(['exclude_quotes', 'exclude_bibliography', 'compare_within_class', 'include_repository', 'show_report_to_students'] as const).map((k) => <label key={k} className="small" style={{ display: 'block' }}><input type="checkbox" checked={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {k.replace(/_/g, ' ')}</label>)}
          <Field label="Minimum match length (words)"><input type="number" min={5} max={50} value={f.min_match_words} onChange={(e) => setF({ ...f, min_match_words: e.target.value })} /></Field>
          <h3>Rubric</h3>
          <Load state={rubrics}>{(r: any[]) => <Field label="Use existing rubric"><select value={f.rubric_id} onChange={(e) => setF({ ...f, rubric_id: e.target.value })}><option value="">Create new from lines below</option>{r.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></Field>}</Load>
          {!f.rubric_id && <Field label="Criteria" hint="One per line: Title|max points"><textarea rows={4} value={rub} onChange={(e) => setRub(e.target.value)} /></Field>}
        </div>
      </div>
      {a.error ? <ErrorBox error={a.error} /> : null}
      <button className="btn primary" disabled={a.busy}>Create assignment</button>
    </form>
  );
}

export function AssignmentInbox() {
  const { id } = useParams();
  const as = useLoad(() => api(`/assignments/${id}`), [id]);
  const s = useLoad(() => api(`/assignments/${id}/submissions`), [id]);
  const [filter, setFilter] = useState('all');
  const a = useAsync();
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const pending = (s.data?.submissions ?? []).some((x: any) => x.scan_status === 'queued' || x.scan_status === 'processing');
    if (!pending) return;
    const h = window.setInterval(s.reload, 3000);
    return () => window.clearInterval(h);
  }, [s.data]);
  return (
    <div className="page">
      <Load state={as}>{(x: any) => (
        <>
          <p className="muted">{x.course_code} · due {fmtDate(x.due_at, x.timezone)}</p>
          <h1>{x.title}: submissions</h1>
          <details className="card"><summary>Assignment settings</summary><PolicyList policy={x.policy} /><pre className="small">{JSON.stringify(x.similarity_settings, null, 2)}</pre></details>
        </>
      )}</Load>
      <div className="row" style={{ margin: '12px 0' }}>
        <label>Filter <select value={filter} onChange={(e) => setFilter(e.target.value)}><option value="all">All</option><option value="late">Late</option><option value="unmarked">Not marked</option><option value="approved">Approved, not released</option><option value="released">Released</option></select></label>
        <button className="btn" onClick={() => a.run(async () => { const r = await api(`/assignments/${id}/release-approved`, { method: 'POST' }); setMsg(`${r.released} approved grade(s) released.`); s.reload(); })}>Release all approved feedback</button>
        <button className="btn ghost" onClick={() => a.run(async () => { const r = await api(`/assignments/${id}/recheck`, { method: 'POST' }); setMsg(`${r.queued} scan(s) queued. ${r.note}`); s.reload(); })}>Re-run similarity for the whole class</button>
      </div>
      {msg && <Notice kind="success">{msg}</Notice>}
      {a.error ? <ErrorBox error={a.error} /> : null}
      <Load state={s}>{(d: any) => (
        <>
          {d.anonymous && <Notice>Anonymous marking is on: student names are hidden.</Notice>}
          <div className="card table-wrap"><table className="data">
            <thead><tr><th>Student</th><th>Attempt</th><th>Received</th><th>Similarity</th><th>Grade</th><th></th></tr></thead>
            <tbody>{d.submissions.filter((x: any) => filter === 'all' || (filter === 'late' && x.is_late) || (filter === 'unmarked' && (!x.grade_status || x.grade_status === 'draft')) || (filter === 'approved' && x.grade_status === 'approved') || (filter === 'released' && x.grade_status === 'released')).map((x: any) => (
              <tr key={x.id}>
                <td>{x.name}</td><td>#{x.attempt_no}</td><td>{fmtDate(x.received_at)} {x.is_late && <Badge kind="warn">Late</Badge>}</td>
                <td>{x.report_id ? (x.report_status === 'completed' ? <Link to={`/reports/${x.report_id}`}><Pct value={x.report_pct === null ? null : Number(x.report_pct)} /></Link> : <Badge kind="warn">{x.report_status}</Badge>) : <Badge kind={x.scan_status === 'failed' ? 'bad' : 'info'}>{x.scan_status ?? 'not run'}</Badge>}</td>
                <td>{x.grade_status ? <Badge kind={x.grade_status === 'released' ? 'ok' : 'neutral'}>{x.grade_status}</Badge> : <Badge>not marked</Badge>} {x.total !== null && x.total !== undefined ? `${x.total}/${x.max_total}` : ''}</td>
                <td><Link className="btn sm" to={`/review/${x.id}`}>Review</Link></td>
              </tr>
            ))}</tbody>
          </table></div>
          <p className="small muted">Not submitted: {Array.isArray(d.not_submitted) ? (d.not_submitted.join(', ') || 'none') : d.not_submitted}</p>
        </>
      )}</Load>
    </div>
  );
}

export function ReviewPage() {
  const { id } = useParams();
  const s = useLoad(() => api(`/submissions/${id}`), [id]);
  const [tab, setTab] = useState<'text' | 'similarity'>('text');
  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <Load state={s}>{(x: any) => x.role !== 'staff' ? <Notice>Open this submission from your assignments page.</Notice> : (
        <>
          <p className="muted">{x.receipt.assignment_title}</p>
          <h1>{x.student.name}: attempt {x.receipt.attempt_no} {x.receipt.is_late && <Badge kind="warn">Late</Badge>}</h1>
          <p className="small">Received {fmtDate(x.receipt.received_at, x.receipt.timezone)} · version {x.version.version_no} · {x.version.word_count} words · fingerprint <code>{x.receipt.content_hash.slice(0, 16)}</code> · policy v{x.receipt.policy_version}</p>
          <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(320px,1fr)' }}>
            <section>
              <div className="tabs" role="tablist">
                <button role="tab" aria-selected={tab === 'text'} onClick={() => setTab('text')}>Submitted text</button>
                <button role="tab" aria-selected={tab === 'similarity'} onClick={() => setTab('similarity')}>Source similarity</button>
              </div>
              {tab === 'text' ? <div className="doc-text" style={{ whiteSpace: 'normal' }} dangerouslySetInnerHTML={{ __html: x.version.content_html }} /> : <SimilarityForSubmission sub={x} />}
            </section>
            <aside className="stack">
              <GradePanel sub={x} onChange={s.reload} />
              <div className="card small">
                <h3>Authorship transparency</h3>
                <p className="muted">{x.activity_note}</p>
                {x.activity.length === 0 ? <p>No platform events recorded.</p> : <ul>{x.activity.map((a: any) => <li key={a.kind}>{a.kind.replace(/_/g, ' ')}: {a.n}</li>)}</ul>}
                <h4>Student disclosure</h4>
                <p>{x.disclosure || <em>None provided.</em>}</p>
                <h4>Attempts</h4>
                <ul>{x.attempts.map((t: any) => <li key={t.id}><Link to={`/review/${t.id}`}>#{t.attempt_no}</Link> {fmtDate(t.received_at)} {t.is_late && '(late)'}</li>)}</ul>
              </div>
              <Responses sub={x} onChange={s.reload} />
            </aside>
          </div>
        </>
      )}</Load>
    </div>
  );
}

function SimilarityForSubmission({ sub }: { sub: any }) {
  const rid = sub.reports.find((r: any) => r.kind === 'similarity')?.id;
  const r = useLoad(() => (rid ? api(`/reports/${rid}`) : Promise.resolve(null)), [rid]);
  if (!rid) return <Notice kind={sub.scan_status === 'failed' ? 'error' : 'info'}>{sub.scan_status === 'failed' ? 'The similarity scan failed. The submission itself is safely received. Use “Re-run similarity” on the assignment page.' : `Similarity analysis is ${sub.scan_status ?? 'pending'}. The submission is safely received.`}</Notice>;
  return <Load state={r}>{(rep: any) => rep && <ReportView rep={rep} canExclude onChange={r.reload} pdfPath={`/reports/${rid}/pdf`} />}</Load>;
}

function GradePanel({ sub, onChange }: { sub: any; onChange: () => void }) {
  const g = sub.grade;
  const [scores, setScores] = useState<Record<string, number>>(g?.rubric_scores ?? {});
  const [fb, setFb] = useState(g?.feedback ?? '');
  const [comment, setComment] = useState('');
  const snippets = useLoad(() => api(`/orgs/${sub.org_id}/snippets`), [sub.org_id]);
  const a = useAsync();
  const total = Object.values(scores).reduce((n, v) => n + (Number(v) || 0), 0);
  const released = g?.status === 'released' || g?.status === 'revision_requested';
  return (
    <div className="card">
      <h3><span className="kind-label kind-feedback">Feedback & grade</span></h3>
      <p>Status: <Badge kind={g?.status === 'released' ? 'ok' : g?.status === 'approved' ? 'info' : 'neutral'}>{g?.status ?? 'not started'}</Badge></p>
      {sub.rubric && (
        <table className="data small"><tbody>{sub.rubric.criteria.map((c: any) => (
          <tr key={c.id}><td>{c.title}<div className="muted">{c.description}</div></td>
            <td><input type="number" min={0} max={c.max_points} step={0.5} disabled={released} aria-label={`${c.title} score`} value={scores[c.id] ?? ''} onChange={(e) => setScores({ ...scores, [c.id]: Number(e.target.value) })} style={{ width: 70 }} /> / {c.max_points}</td></tr>
        ))}<tr><td><strong>Total</strong></td><td><strong>{total}</strong> / {sub.rubric.criteria.reduce((n: number, c: any) => n + c.max_points, 0)}</td></tr></tbody></table>
      )}
      <Field label="Feedback to student"><textarea rows={6} disabled={released} value={fb} onChange={(e) => setFb(e.target.value)} /></Field>
      {!released && <div className="row small">
        <Load state={snippets}>{(sn: any[]) => sn.length ? <select aria-label="Insert reusable feedback" value="" onChange={(e) => setFb(fb ? fb + '\n\n' + e.target.value : e.target.value)}><option value="">Insert reusable feedback…</option>{sn.map((x) => <option key={x.id} value={x.body}>{x.body.slice(0, 60)}</option>)}</select> : <span className="muted">No saved feedback snippets.</span>}</Load>
        <button type="button" className="btn sm ghost" disabled={!fb.trim()} onClick={() => a.run(async () => { await api(`/orgs/${sub.org_id}/snippets`, { body: { body: fb } }); snippets.reload(); })}>Save as reusable</button>
      </div>}
      {a.error ? <ErrorBox error={a.error} /> : null}
      {!released && <div className="row">
        <button className="btn" disabled={a.busy} onClick={() => a.run(async () => { await api(`/submissions/${sub.receipt.submission_id}/grade`, { method: 'PUT', body: { rubric_scores: scores, feedback: fb } }); onChange(); })}>Save draft</button>
        <button className="btn teal" disabled={a.busy || g?.status !== 'draft'} onClick={() => a.run(async () => { await api(`/submissions/${sub.receipt.submission_id}/grade/approve`, { method: 'POST' }); onChange(); })}>Approve</button>
        <button className="btn primary" disabled={a.busy || g?.status !== 'approved'} onClick={() => a.run(async () => { await api(`/submissions/${sub.receipt.submission_id}/grade/release`, { method: 'POST' }); onChange(); })}>Release to student</button>
        <button className="btn ghost" disabled={a.busy || g?.status !== 'approved'} onClick={() => a.run(async () => { await api(`/submissions/${sub.receipt.submission_id}/request-revision`, { method: 'POST' }); onChange(); })}>Release as revision request</button>
      </div>}
      <p className="small muted">Grades are released only after an instructor approves them. Saving changes returns a grade to draft.</p>
      <h4>Inline comments</h4>
      {sub.comments.map((c: any) => <div key={c.id} className="sugg small">{c.quote && <blockquote>“{c.quote}”</blockquote>}{c.body} <span className="muted">· {c.author}</span></div>)}
      <form onSubmit={(e) => { e.preventDefault(); a.run(async () => { const quote = window.getSelection()?.toString().slice(0, 1000) || undefined; await api(`/submissions/${sub.receipt.submission_id}/comments`, { body: { body: comment, quote } }); setComment(''); onChange(); }); }}>
        <Field label="Add comment" hint="Select text in the submission first to quote it."><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <button className="btn sm" disabled={!comment.trim()}>Add comment</button>
      </form>
    </div>
  );
}

function Responses({ sub, onChange }: { sub: any; onChange: () => void }) {
  const [d, setD] = useState<Record<string, string>>({});
  const a = useAsync();
  if (!sub.responses.length) return null;
  return (
    <div className="card small">
      <h3>Student responses & review requests</h3>
      {sub.responses.map((r: any) => (
        <div key={r.id} className="sugg">
          <Badge>{r.kind}</Badge> <Badge kind={r.status === 'open' ? 'warn' : 'ok'}>{r.status}</Badge>
          <p>{r.body}</p>
          {r.decision ? <p><strong>Decision:</strong> {r.decision}</p> : (
            <>
              <textarea rows={2} aria-label="Decision" value={d[r.id] ?? ''} onChange={(e) => setD({ ...d, [r.id]: e.target.value })} />
              <div className="row">{(['upheld', 'changed', 'closed'] as const).map((st) => <button key={st} className="btn sm" disabled={!d[r.id]} onClick={() => a.run(async () => { await api(`/responses/${r.id}/decide`, { body: { status: st, decision: d[r.id] } }); onChange(); })}>{st === 'changed' ? 'Change grade' : st === 'upheld' ? 'Uphold' : 'Close'}</button>)}</div>
            </>
          )}
        </div>
      ))}
      {a.error ? <ErrorBox error={a.error} /> : null}
    </div>
  );
}
