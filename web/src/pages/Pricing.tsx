import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Load, useLoad } from '../components/ui';

export function price(p: any, cur: 'USD' | 'TZS', interval: 'monthly' | 'annual') {
  const v = p.prices?.[cur]?.[interval];
  if (v === null || v === undefined) return 'Price to be confirmed';
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: cur === 'TZS' ? 0 : 2 }).format(v) + (interval === 'monthly' ? ' / month' : ' / year');
}

const lim = (v: any, unit = '') => (v === null || v === undefined ? 'Unlimited' : `${Number(v).toLocaleString()}${unit}`);

export default function Pricing() {
  const s = useLoad(() => api('/plans'));
  const [cur, setCur] = useState<'USD' | 'TZS'>('TZS');
  const [interval, setInterval] = useState<'monthly' | 'annual'>('monthly');
  return (
    <div className="page">
      <h1>Plans</h1>
      <p className="muted">Commercial prices have not been approved yet, so they are shown as “to be confirmed”. Allowances are configurable by the platform administrator.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <label>Currency <select value={cur} onChange={(e) => setCur(e.target.value as any)}><option>TZS</option><option>USD</option></select></label>
        <label>Billing <select value={interval} onChange={(e) => setInterval(e.target.value as any)}><option value="monthly">Monthly</option><option value="annual">Annual</option></select></label>
      </div>
      <Load state={s}>{(plans: any[]) => (
        <div className="grid cols-3">
          {plans.map((p) => (
            <div className="card" key={p.code}>
              <h2>{p.name}</h2>
              <p className="muted">{p.audience}</p>
              <p><strong>{price(p, cur, interval)}</strong></p>
              <ul className="small">
                <li>Similarity checks: {lim(p.limits.similarity_checks_per_month)} / month</li>
                <li>Writing assistance: {lim(p.limits.words_per_month)} words / month</li>
                <li>Documents: {lim(p.limits.documents)}</li>
                <li>Storage: {lim(p.limits.storage_mb, ' MB')}</li>
                {p.limits.seats !== 1 && <li>Seats: {lim(p.limits.seats)}</li>}
                {Object.entries(p.features).map(([k, v]) => <li key={k}>{v ? '✓' : '✗'} {k.replace(/_/g, ' ')}</li>)}
              </ul>
              {p.code === 'institution' || p.code === 'enterprise' ? <Link className="btn" to="/institutions/new">Start an institution trial</Link> : <Link className="btn" to="/register">Get started</Link>}
            </div>
          ))}
        </div>
      )}</Load>
      <p className="muted small" style={{ marginTop: 20 }}>Usage policy: a similarity check is counted only when a scan completes. Failed, cancelled, retried and repeated requests for the same version are not charged. Payment by mobile money and card will be added after provider verification; institutions can pay by invoice and bank transfer.</p>
    </div>
  );
}
