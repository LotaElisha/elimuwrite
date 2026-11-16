import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { I18nProvider, useI18n } from './lib/i18n';
import { SessionProvider, useSession } from './lib/session';
import { api } from './lib/api';
import { Loading, Badge } from './components/ui';
import Home from './pages/Home';
import Pricing from './pages/Pricing';
import { Login, Register, AcceptInvite } from './pages/Auth';
import Dashboard from './pages/Dashboard';
import Documents from './pages/Documents';
// The editor bundle is loaded only when the Writing Studio opens (low-bandwidth friendly).
const Studio = lazy(() => import('./pages/Studio'));
import ReportPage, { SharedReport } from './pages/Report';
import Library from './pages/Library';
import Reports from './pages/Reports';
import Billing from './pages/Billing';
import { MyAssignments, AssignmentPage, SubmissionPage } from './pages/Student';
import { Courses, CoursePage, AssignmentInbox, ReviewPage } from './pages/Teaching';
import { OrgOnboarding, OrgAdmin } from './pages/Institution';
import PlatformAdmin from './pages/Admin';
import Progress from './pages/Progress';

function Shell({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { me, workspace, setWorkspace, refresh, config } = useSession();
  const nav = useNavigate();
  const [theme, setTheme] = useState(() => localStorage.getItem('ew.theme') ?? 'light');
  const [size, setSize] = useState(() => Number(localStorage.getItem('ew.size') ?? 16));
  const [menu, setMenu] = useState(false);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('ew.theme', theme); }, [theme]);
  useEffect(() => { document.documentElement.style.fontSize = size + 'px'; localStorage.setItem('ew.size', String(size)); }, [size]);
  const roles = workspace?.roles ?? [];
  const isInst = workspace?.kind === 'institution';
  const brand = config?.brand?.name ?? 'ElimuWrite';
  return (
    <>
      <a href="#main" className="skip">{t('a11y.skip')}</a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label={`${brand} home`}><span className="logo" aria-hidden>✎</span> {brand}</Link>
        <button className="btn ghost menu-btn" aria-expanded={menu} aria-controls="mainnav" onClick={() => setMenu(!menu)}>☰</button>
        <nav id="mainnav" className={menu ? 'open' : ''} aria-label="Main" onClick={() => setMenu(false)}>
          {!me && <>
            <NavLink to="/" end>{t('nav.home')}</NavLink>
            <a href="/#tools">{t('nav.tools')}</a>
            <NavLink to="/pricing">{t('nav.pricing')}</NavLink>
          </>}
          {me && !isInst && <>
            <NavLink to="/dashboard">{t('nav.dashboard')}</NavLink>
            <NavLink to="/documents">{t('nav.documents')}</NavLink>
            <NavLink to="/library">{t('nav.library')}</NavLink>
            <NavLink to="/reports">{t('nav.reports')}</NavLink>
            <NavLink to="/progress">{t('nav.progress')}</NavLink>
            <NavLink to="/billing">{t('nav.billing')}</NavLink>
          </>}
          {me && isInst && <>
            {roles.includes('student') && <NavLink to="/assignments">{t('nav.assignments')}</NavLink>}
            {(roles.includes('instructor') || roles.includes('reviewer') || roles.includes('org_admin')) && <NavLink to="/courses">{t('nav.courses')}</NavLink>}
            {(roles.includes('org_admin') || roles.includes('billing_admin')) && <NavLink to={`/org/${workspace!.id}`}>{t('nav.institution')}</NavLink>}
          </>}
          {me?.is_platform_admin && <NavLink to="/admin">{t('nav.admin')}</NavLink>}
        </nav>
        <div className="toolbar">
          {me && (
            <label className="ws-switch">
              <span className="sr-only">{t('ws.switch')}</span>
              <select value={workspace?.id} onChange={(e) => { setWorkspace(e.target.value); const w = me.workspaces.find((x) => x.id === e.target.value); nav(w?.kind === 'institution' ? (w.roles?.includes('student') && w.roles.length === 1 ? '/assignments' : '/courses') : '/dashboard'); }}>
                {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.kind === 'personal' ? `👤 ${t('ws.personal')}` : `🏛 ${w.name}`}</option>)}
              </select>
            </label>
          )}
          <label><span className="sr-only">Language</span>
            <select value={lang} onChange={(e) => setLang(e.target.value as any)} aria-label="Language / Lugha">
              <option value="en">English</option><option value="sw">Kiswahili</option>
            </select>
          </label>
          <button className="btn ghost" aria-label={t('a11y.textSize') + ' −'} onClick={() => setSize(Math.max(13, size - 1))}>A−</button>
          <button className="btn ghost" aria-label={t('a11y.textSize') + ' +'} onClick={() => setSize(Math.min(22, size + 1))}>A+</button>
          <button className="btn ghost" aria-label={t('a11y.theme')} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>{theme === 'light' ? '🌙' : '☀️'}</button>
          {me ? <button className="btn ghost" onClick={async () => { await api('/auth/logout', { method: 'POST' }); await refresh(); nav('/'); }}>{t('nav.signout')}</button>
            : <><Link className="btn ghost" to="/login">{t('nav.signin')}</Link><Link className="btn primary" to="/register">{t('nav.signup')}</Link></>}
        </div>
      </header>
      {workspace?.is_demo && <div className="demo-banner" role="note">{t('common.demoData')}: {workspace.name} is fictional sample data, separate from real institutional records.</div>}
      <main id="main" tabIndex={-1}><Suspense fallback={<Loading />}>{children}</Suspense></main>
      <footer className="footer"><span>{brand} · {config?.brand?.tagline}</span><span className="muted">Phase 1 MVP</span></footer>
    </>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <I18nProvider>
      <SessionProvider>
        <BrowserRouter>
          <Shell>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/invite/:token" element={<AcceptInvite />} />
              <Route path="/shared/:token" element={<SharedReport />} />
              <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
              <Route path="/documents" element={<RequireAuth><Documents /></RequireAuth>} />
              <Route path="/studio/:id" element={<RequireAuth><Studio /></RequireAuth>} />
              <Route path="/reports" element={<RequireAuth><Reports /></RequireAuth>} />
              <Route path="/reports/:id" element={<RequireAuth><ReportPage /></RequireAuth>} />
              <Route path="/library" element={<RequireAuth><Library /></RequireAuth>} />
              <Route path="/progress" element={<RequireAuth><Progress /></RequireAuth>} />
              <Route path="/billing" element={<RequireAuth><Billing /></RequireAuth>} />
              <Route path="/assignments" element={<RequireAuth><MyAssignments /></RequireAuth>} />
              <Route path="/assignments/:id" element={<RequireAuth><AssignmentPage /></RequireAuth>} />
              <Route path="/submissions/:id" element={<RequireAuth><SubmissionPage /></RequireAuth>} />
              <Route path="/courses" element={<RequireAuth><Courses /></RequireAuth>} />
              <Route path="/courses/:id" element={<RequireAuth><CoursePage /></RequireAuth>} />
              <Route path="/teach/assignments/:id" element={<RequireAuth><AssignmentInbox /></RequireAuth>} />
              <Route path="/review/:id" element={<RequireAuth><ReviewPage /></RequireAuth>} />
              <Route path="/institutions/new" element={<RequireAuth><OrgOnboarding /></RequireAuth>} />
              <Route path="/org/:id" element={<RequireAuth><OrgAdmin /></RequireAuth>} />
              <Route path="/admin" element={<RequireAuth><PlatformAdmin /></RequireAuth>} />
              <Route path="*" element={<div className="page"><h1>Page not found</h1><Link to="/">Go home</Link></div>} />
            </Routes>
          </Shell>
        </BrowserRouter>
      </SessionProvider>
    </I18nProvider>
  );
}

export { Badge };
