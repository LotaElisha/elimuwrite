export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
      credentials: 'include',
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'offline', 'You appear to be offline. Cloud analysis needs a connection.');
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok) {
    const j = ct.includes('json') ? await res.json().catch(() => ({})) : {};
    throw new ApiError(res.status, j.error ?? 'error', j.message ?? `Request failed (${res.status})`, j.detail);
  }
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export function download(path: string) {
  const a = document.createElement('a');
  a.href = '/api' + path;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function fmtDate(d: string | Date | null | undefined, tz?: string) {
  if (!d) return '—';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(d)) + (tz ? ` (${tz})` : '');
  } catch {
    return new Date(d).toLocaleString();
  }
}

export function uid() {
  return crypto.randomUUID();
}
