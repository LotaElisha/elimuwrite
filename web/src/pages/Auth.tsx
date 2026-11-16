import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useSession } from '../lib/session';
import { ErrorBox, Field, Load, Notice, useAsync, useLoad } from '../components/ui';

export function Login() {
  const { t } = useI18n();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [f, setF] = useState({ email: '', password: '' });
  const a = useAsync();
  return (
    <div className="page narrow">
      <h1>{t('nav.signin')}</h1>
      <form className="card" onSubmit={async (e) => { e.preventDefault(); const ok = await a.run(() => api('/auth/login', { body: f })); if (ok) { await refresh(); nav(sp.get('next') || '/dashboard'); } }}>
        <Field label={t('auth.email')}><input type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('auth.password')}><input type="password" required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {a.error ? <ErrorBox error={a.error} /> : null}
        <button className="btn primary" disabled={a.busy}>{t('nav.signin')}</button>
        <p className="small muted">No account? <Link to={'/register' + (sp.get('next') ? `?next=${sp.get('next')}` : '')}>{t('nav.signup')}</Link></p>
      </form>
      <Notice>Demo accounts (fictional data): amina@demo.elimuwrite.test, lecturer@demo.elimuwrite.test, student1@demo.elimuwrite.test, registrar@demo.elimuwrite.test, admin@demo.elimuwrite.test. Password: Demo-Pass-2026 (only after running the seed script).</Notice>
    </div>
  );
}

export function Register() {
  const { t, lang } = useI18n();
  const { refresh } = useSession();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const [f, setF] = useState({ name: '', email: '', password: '', academic_level: '', goals: '', english_variant: 'en-US' });
  const a = useAsync();
  return (
    <div className="page narrow">
      <h1>{t('nav.signup')}</h1>
      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await a.run(() => api('/auth/register', { body: { name: f.name, email: f.email, password: f.password, locale: lang, english_variant: f.english_variant, academic_level: f.academic_level || undefined, writing_goals: f.goals ? f.goals.split(',').map((x) => x.trim()).filter(Boolean) : undefined, invitation_token: sp.get('invite') || undefined } }));
        if (ok) { await refresh(); nav(sp.get('next') || '/dashboard'); }
      }}>
        <Field label={t('auth.name')}><input required value={f.name} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('auth.email')}><input type="email" required autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('auth.password')} hint="At least 8 characters."><input type="password" minLength={8} required autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <details><summary>{t('auth.optional')}: writing goals, level, English variant</summary>
          <Field label={`${t('auth.level')} (${t('auth.optional')})`}><select value={f.academic_level} onChange={(e) => setF({ ...f, academic_level: e.target.value })}><option value="">—</option><option>Secondary</option><option>Undergraduate</option><option>Postgraduate</option><option>Researcher</option><option>Professional</option></select></Field>
          <Field label={`${t('auth.goals')} (${t('auth.optional')})`} hint="Comma-separated, e.g. thesis, clearer sentences"><input value={f.goals} onChange={(e) => setF({ ...f, goals: e.target.value })} /></Field>
          <Field label="English variant"><select value={f.english_variant} onChange={(e) => setF({ ...f, english_variant: e.target.value })}><option value="en-US">American English</option><option value="en-GB">British English</option></select></Field>
        </details>
        <p className="small muted">Your documents are private to you. Joining an institution never gives it access to your personal workspace.</p>
        {a.error ? <ErrorBox error={a.error} /> : null}
        <button className="btn primary" disabled={a.busy}>{t('nav.signup')}</button>
      </form>
    </div>
  );
}

export function AcceptInvite() {
  const { token } = useParams();
  const { me, refresh } = useSession();
  const nav = useNavigate();
  const s = useLoad(() => api(`/invitations/${token}`), [token]);
  const a = useAsync();
  return (
    <div className="page narrow">
      <h1>Invitation</h1>
      <Load state={s}>{(inv: any) => (
        <div className="card">
          <p>You have been invited to join <strong>{inv.org_name}</strong> as <strong>{inv.roles.join(', ')}</strong>.</p>
          <p className="small muted">Joining gives the institution access to work you do inside its courses only, never to your personal workspace.</p>
          {me ? <button className="btn primary" disabled={a.busy} onClick={async () => { if (await a.run(() => api(`/invitations/${token}/accept`, { method: 'POST' }))) { await refresh(); nav('/courses'); } }}>Accept invitation</button>
            : <Link className="btn primary" to={`/register?invite=${token}&next=/assignments`}>Create an account to accept</Link>}
          {a.error ? <ErrorBox error={a.error} /> : null}
        </div>
      )}</Load>
    </div>
  );
}
