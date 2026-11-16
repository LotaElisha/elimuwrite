import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';

export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden /> {label ?? t('common.loading')}</div>;
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  const e = error as ApiError;
  if (e?.status === 403 || e?.status === 404) return <Denied message={e.message} />;
  return (
    <div className="state error" role="alert">
      <strong>{e?.message ?? 'Something went wrong.'}</strong>
      {onRetry && <button className="btn" onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

export function Denied({ message }: { message?: string }) {
  const { t } = useI18n();
  return <div className="state denied" role="alert"><strong>🔒 {t('common.denied')}</strong>{message && <p className="muted">{message}</p>}</div>;
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="state empty">{children ?? t('common.empty')}</div>;
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'success' | 'error'; children: ReactNode }) {
  const icon = { info: 'ℹ️', warn: '⚠️', success: '✅', error: '⛔' }[kind];
  return <div className={`notice ${kind}`} role={kind === 'error' ? 'alert' : 'note'}><span aria-hidden>{icon}</span><div>{children}</div></div>;
}

export function Badge({ kind = 'neutral', children }: { kind?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; children: ReactNode }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

/** Generic data loader with loading / error / retry states. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then((d) => alive && setData(d)).catch((e) => alive && setError(e)).finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1), setData };
}

export function Load<T>({ state, children, empty }: { state: { data: T | null; error: unknown; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; empty?: (d: T) => boolean }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return <Loading />;
  if (empty?.(state.data)) return <Empty />;
  return <>{children(state.data)}</>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function Pct({ value }: { value: number | null | undefined }) {
  const { t } = useI18n();
  if (value === null || value === undefined) return <span>{t('sim.noText')}</span>;
  return <span>{value}%</span>;
}

export function PolicyList({ policy }: { policy: Record<string, boolean> }) {
  const labels: Record<string, string> = { grammar: 'Grammar and spelling checks', paraphrase: 'Paraphrasing', translation: 'Translation', summarization: 'Summaries', tutoring: 'Writing tutor', generative: 'Generative drafting', disclosure_required: 'AI-use disclosure required' };
  return (
    <ul className="policy">
      {Object.entries(labels).map(([k, l]) => (
        <li key={k}><span aria-hidden>{policy[k] ? '✅' : '🚫'}</span> {l}: <strong>{k === 'disclosure_required' ? (policy[k] ? 'yes' : 'no') : policy[k] ? 'allowed' : 'not allowed'}</strong></li>
      ))}
    </ul>
  );
}
