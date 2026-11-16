import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export type Workspace = { kind: 'personal' | 'institution'; id: string; name: string; roles?: string[]; timezone?: string; is_demo?: boolean };
export type Me = { id: string; email: string; name: string; locale: string; english_variant: string; is_platform_admin: boolean; is_demo: boolean; workspaces: Workspace[] };

type S = { me: Me | null; loading: boolean; refresh: () => Promise<void>; workspace: Workspace | null; setWorkspace: (id: string) => void; config: any };
const Ctx = createContext<S>(null as any);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<any>(null);
  const [wsId, setWsId] = useState(() => localStorage.getItem('ew.ws') ?? 'personal');
  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/me'));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
    api('/config').then(setConfig).catch(() => {});
  }, [refresh]);
  const workspace = me?.workspaces.find((w) => w.id === wsId) ?? me?.workspaces[0] ?? null;
  const setWorkspace = (id: string) => {
    localStorage.setItem('ew.ws', id);
    setWsId(id);
  };
  return <Ctx.Provider value={{ me, loading, refresh, workspace, setWorkspace, config }}>{children}</Ctx.Provider>;
}

export const useSession = () => useContext(Ctx);
