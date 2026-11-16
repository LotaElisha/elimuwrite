import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, download, fmtDate } from '../lib/api';
import { Badge, ErrorBox, Load, Notice, useAsync, useLoad, Field } from '../components/ui';
import { Meter } from './Dashboard';

export default function Billing({ orgId }: { orgId?: string }) {
  const s = useLoad(() => api('/billing' + (orgId ? `?org=${orgId}` : '')), [orgId]);
  const [res, setRes] = useState<any>(null);
  const [seats, setSeats] = useState('');
  const a = useAsync();
  return (
    <div className={orgId ? '' : 'page'}>
      {!orgId && <h1>Plan & usage</h1>}
      <Load state={s}>{(b: any) => (
        <div className="grid cols-2">
          <section className="card stack">
            <h2>{b.plan_name}</h2>
            {b.subscription ? <p>Status: <Badge kind={b.subscription.status === 'active' ? 'ok' : 'warn'}>{b.subscription.status}</Badge> · renews/ends {fmtDate(b.subscription.current_period_end)} {b.subscription.cancel_at_period_end && <Badge kind="warn">cancels at period end</Badge>}</p> : <p className="muted">Free plan, no subscription.</p>}
            <Meter label="Similarity checks this month" used={(b.usage.similarity_check ?? 0) + (b.usage.pending_similarity ?? 0)} limit={b.limits.similarity_checks_per_month} />
            <Meter label="Words checked this month" used={b.usage.writing_check ?? 0} limit={b.limits.words_per_month} />
            {orgId && <Meter label="Seats" used={b.seats_used ?? 0} limit={b.subscription?.seats ?? null} />}
            <p className="small muted">{b.usage_policy}</p>
          </section>
          <section className="card stack">
            <h2>Payment</h2>
            {b.payment_provider === 'not_configured' && <Notice kind="warn">Online payment is <strong>not configured</strong>. Paid access is only ever activated by a verified payment notification, never by a browser redirect.</Notice>}
            {!orgId && <button className="btn" onClick={() => a.run(async () => setRes(await api('/billing/checkout', { body: { plan: 'personal_pro', interval: 'monthly', currency: 'TZS' } })))}>Upgrade to Personal Pro</button>}
            {orgId && <>
              <button className="btn" onClick={() => a.run(async () => setRes(await api(`/orgs/${orgId}/invoice-requests`, { method: 'POST' })))}>Request an invoice (bank payment)</button>
              <form className="row" onSubmit={(e) => { e.preventDefault(); a.run(async () => { await api(`/orgs/${orgId}/seats`, { method: 'PUT', body: { seats: Number(seats) } }); s.reload(); }); }}>
                <Field label="Change seats"><input type="number" min={1} value={seats} onChange={(e) => setSeats(e.target.value)} /></Field><button className="btn sm">Update</button>
              </form>
              <h3>Invoices</h3>
              {b.invoices.length === 0 ? <p className="small muted">No invoices.</p> : <table className="data small"><tbody>{b.invoices.map((i: any) => <tr key={i.id}><td>{i.number}</td><td>{Number(i.amount).toLocaleString()} {i.currency}</td><td><Badge kind={i.status === 'paid' ? 'ok' : 'warn'}>{i.status}</Badge></td><td>{fmtDate(i.paid_at ?? i.due_at)}</td></tr>)}</tbody></table>}
            </>}
            {b.subscription && !b.subscription.cancel_at_period_end && <button className="btn ghost danger" onClick={() => a.run(async () => { await api('/billing/cancel', { body: orgId ? { org: orgId } : {} }); s.reload(); })}>Cancel at end of period</button>}
            {res && <Notice>{res.message}</Notice>}
            {a.error ? <ErrorBox error={a.error} /> : null}
            {!orgId && <><Link to="/pricing" className="small">Compare plans</Link><button className="btn sm ghost" onClick={() => download('/me/export')}>Export my personal data (JSON)</button></>}
          </section>
        </div>
      )}</Load>
    </div>
  );
}
