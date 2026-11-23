// FlowMate · 会话与组织上下文（PRD §03 全局：组织切换、未保存提示、切换后清空旧组织检索与订阅）
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, currentOrg, setCurrentOrg, useMe, type Json, type Me } from '../api/hooks';

export type MeView = Me & { orgs: { id: string; name: string; slug: string; role: string; teams: string[] }[]; org_id: string | null };

type SessionValue = {
  me: MeView | null;
  loading: boolean;
  orgId: string | null;
  orgs: { id: string; name: string; slug: string; role: string; teams: string[] }[];
  switchOrg: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
  dirty: { current: boolean };
};

const Ctx = createContext<SessionValue>(null as unknown as SessionValue);
export const useSession = () => useContext(Ctx);

/** 后端 /auth/me 的 organizations 与兼容字段统一成一种形态 */
function orgsOf(me: Me | null): Me['orgs'] {
  const list = (me?.organizations ?? me?.orgs ?? []) as Array<Record<string, unknown>>;
  return list.map((o) => {
    const teams = (o.teams ?? []) as Array<unknown>;
    return {
      id: String(o.id), name: String(o.name), slug: String(o.slug ?? ''), role: String(o.role ?? 'member'),
      teams: teams.map((t) => (typeof t === 'string' ? t : String((t as Record<string, unknown>).id))),
    };
  });
}
function orgIdOf(me: Me | null): string | null {
  const cur = me?.current_org as unknown;
  if (typeof cur === 'string') return cur || null;
  if (cur && typeof cur === 'object') return String((cur as Record<string, unknown>).id ?? '') || null;
  return me?.org_id ?? null;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const q = useMe();
  const raw = q.data ?? null;
  const me: MeView | null = raw ? ({ ...raw, orgs: orgsOf(raw), org_id: orgIdOf(raw) } as MeView) : null;
  const [orgId, setOrgId] = useState<string | null>(currentOrg());
  const dirty = useRef(false);

  useEffect(() => {
    if (!me) return;
    const stored = currentOrg();
    const valid = !!stored && me.orgs.some((o) => o.id === stored);
    const next = valid ? stored : me.org_id ?? me.orgs[0]?.id ?? null;
    if (next !== stored) setCurrentOrg(next);
    setOrgId(next);
  }, [me]);

  const switchOrg = useCallback((id: string) => {
    if (dirty.current && !window.confirm('当前页面有未保存内容，切换组织后将丢失。仍要切换？')) return;
    setCurrentOrg(id);
    setOrgId(id);
    // 切换前清空旧组织的检索结果与订阅缓存，不串数据
    qc.clear();
    dirty.current = false;
  }, [qc]);

  const login = useCallback(async (email: string, password: string) => {
    await api.post<Json>('/auth/login', { email, password });
    dirty.current = false;
    await q.refetch();
  }, [q]);

  const logout = useCallback(async () => {
    await api.post('/auth/logout');
    qc.clear();
    window.location.href = '/login';
  }, [qc]);

  const value = useMemo<SessionValue>(() => ({
    me, loading: q.isLoading, orgId, orgs: me?.orgs ?? [], switchOrg, login, logout,
    refresh: () => { void q.refetch(); }, dirty,
  }), [me, q.isLoading, orgId, switchOrg, login, logout, q]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** 页面里「有未保存内容」时调用 set(true)，供组织切换与离开确认使用 */
export function useDirtyFlag() {
  const { dirty } = useSession();
  return useCallback((v: boolean) => { dirty.current = v; }, [dirty]);
}
