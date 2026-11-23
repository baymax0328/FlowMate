// FlowMate · 数据层：TanStack Query + WebSocket 增量失效
// 服务端状态交查询缓存；断线重连后按 last_seq 补拉（resync），重复 event_id 由服务端去重。
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, ApiError, currentOrg, setCurrentOrg, type Json } from './client';
import { mergeUrlState, urlStateToQuery } from './url-state';
import { useLocation } from 'react-router-dom';

export { api, ApiError, currentOrg, setCurrentOrg, jsonOf, arrOf, idem } from './client';
export { mergeUrlState, urlStateToQuery } from './url-state';
export type { Json };

export type Me = {
  user: { id: string; email: string; display_name: string; title: string | null };
  organizations?: { id: string; name: string; slug: string; role: string; teams?: string[] }[];
  current_org?: string | null;
  unread_notifications?: number;
  unread_messages?: number;
  demo_mode?: boolean;
  // 兼容旧字段名
  orgs?: { id: string; name: string; slug: string; role: string; teams: string[] }[];
  org_id?: string | null;
  unread?: number;
};

export function useMe(enabled = true) {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    enabled,
    retry: 0,
  });
}

/** 事件类型 → 需要失效的查询前缀（增量更新缓存，不整页刷新） */
const INVALIDATE: Record<string, string[]> = {
  'message.created': ['conversations', 'messages', 'messages-unread'],
  'message.updated': ['messages'],
  'message.retracted': ['messages'],
  'read.updated': ['conversations', 'messages-unread'],
  'conversation.preferences.updated': ['conversations', 'conversation-detail', 'messages', 'messages-unread', 'search'],
  'conversation.updated': ['conversations', 'conversation-detail'],
  'file.version.created': ['files', 'workspace'],
  'file.text.ready': ['files', 'workspace'],
  'file.text.unavailable': ['files', 'workspace'],
  'run.updated': ['runs', 'center', 'session'],
  'plan.updated': ['runs', 'session'],
  'output.delta': ['session'],
  'artifact.created': ['session', 'files'],
  'approval.updated': ['proposals', 'session', 'center'],
  'proposal.suspended': ['proposals', 'notifications', 'center'],
  'proposal.woken': ['proposals', 'center'],
  'proposal.stale': ['proposals', 'center'],
  'proposal.committed': ['proposals', 'files', 'center', 'session'],
  'proposal.created': ['proposals', 'notifications', 'session'],
  'conflict.updated': ['conflicts', 'center'],
  'task.transitioned': ['tasks', 'task'],
  'submission.created': ['task', 'tasks'],
  'review.created': ['task', 'tasks'],
  'import.updated': ['imports', 'discovery'],
  'candidate.created': ['candidates', 'discovery'],
  'candidate.confirmed': ['candidates', 'tasks'],
  'session.message.created': ['session', 'sessions'],
  'session.shared': ['session', 'sessions', 'shares'],
  'session.sharing.updated': ['session', 'sessions', 'shares', 'session-sharing'],
  'session.share.revoked': ['session', 'sessions', 'shares'],
  'notification.created': ['notifications'],
};

export function useLive(onConnected?: () => void) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const lastSeq = useRef(0);
  const subs = useRef(new Map<string, { entity_type: string; entity_id: string }>());
  const sockRef = useRef<WebSocket | null>(null);
  const retry = useRef(0);

  const connect = useCallback(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const org = currentOrg();
    const url = `${proto}://${location.host}/api/live${org ? `?org=${encodeURIComponent(org)}` : ''}`;
    const ws = new WebSocket(url);
    sockRef.current = ws;
    setStatus('connecting');
    ws.onopen = () => {
      retry.current = 0;
      setStatus('open');
      for (const s of subs.current.values()) {
        ws.send(JSON.stringify({ action: 'subscribe', entity_type: s.entity_type, entity_id: s.entity_id, last_seq: lastSeq.current }));
      }
      onConnected?.();
    };
    ws.onmessage = (ev) => {
      let msg: Json;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.type === 'event') {
        if (typeof msg.seq === 'number') lastSeq.current = Math.max(lastSeq.current, msg.seq);
        const prefixes = INVALIDATE[String(msg.event ?? '')] ?? [];
        if (msg.entity_type) prefixes.push(String(msg.entity_type));
        prefixes.push('live');
        if (/^(task|submission|review|run|session\.message|file|candidate)\./.test(String(msg.event ?? ''))) prefixes.push('dashboard','dashboard-insights','dashboard-team-insights','dashboard-personal-tasks','dashboard-personal-completed','dashboard-calendar');
        for (const p of new Set(prefixes)) qc.invalidateQueries({ queryKey: [p] });
        qc.setQueryData(['live', 'last'], msg);
      } else if (msg.type === 'connected') {
        setStatus('open');
      } else if (msg.type === 'session_revoked') {
        qc.invalidateQueries({ queryKey: ['me'] });
      }
    };
    ws.onclose = () => {
      setStatus('closed');
      const wait = Math.min(15000, 500 * 2 ** (retry.current++));
      window.setTimeout(connect, wait); // 指数退避重连
    };
    ws.onerror = () => ws.close();
  }, [qc, onConnected]);

  useEffect(() => { connect(); return () => sockRef.current?.close(); }, [connect]);

  const subscribe = useCallback((entity_type: string, entity_id: string | null | undefined) => {
    if (!entity_id) return () => undefined;
    const key = `${entity_type}:${entity_id}`;
    subs.current.set(key, { entity_type, entity_id });
    const ws = sockRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'subscribe', entity_type, entity_id, last_seq: lastSeq.current }));
    }
    return () => {
      subs.current.delete(key);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'unsubscribe', entity_type, entity_id }));
    };
  }, []);

  const resync = useCallback(() => {
    const ws = sockRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: 'resync', last_seq: lastSeq.current }));
  }, []);

  return { status, subscribe, resync, lastSeq };
}

/** 订阅某个实体的事件流（页面卸载自动取消） */
export function useSubscription(entity_type: string, entity_id: string | null | undefined) {
  const { subscribe } = useLiveCtx();
  useEffect(() => subscribe(entity_type, entity_id ?? null), [subscribe, entity_type, entity_id]);
}

// LiveContext 由 App 提供，避免每个页面各自建连接
import { createContext, useContext } from 'react';
export const LiveCtx = createContext<{ subscribe: (t: string, id?: string | null) => () => void; status: string; resync: () => void }>({
  subscribe: () => () => undefined, status: 'closed', resync: () => undefined,
});
export function useLiveCtx() { return useContext(LiveCtx); }

// ---------- 常用查询封装 ----------
export function useQ<T>(key: QueryKey, path: string, query?: Record<string, unknown>, opts?: { enabled?: boolean; refetchMs?: number; retry?: number | false }) {
  return useQuery({
    queryKey: key,
    queryFn: () => api.get<T>(path, query as Json),
    enabled: opts?.enabled !== false,
    refetchInterval: opts?.refetchMs,
    retry: opts?.retry,
  });
}

export function useM<T, V = unknown>(mutate: (vars: V) => Promise<T>, invalidate: string[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: mutate,
    onSuccess: () => { for (const k of invalidate) qc.invalidateQueries({ queryKey: [k] }); },
  });
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return (e as Error)?.message ?? '未知错误';
}
export function errField(e: unknown, field: string): string | undefined {
  return e instanceof ApiError ? e.field_errors?.[field] : undefined;
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// ---------- 可拖拽列宽（页面第二列 与 右侧详情栏） ----------
/** 范围按需求定：上限都不超过屏宽的一半；第二列下限比原来的 280 略小 */
export const COL = { sideDef: 280, sideMin: 224, detailDef: 320, detailMin: 240 };
export const colMax = () => Math.floor((typeof window === 'undefined' ? 1600 : window.innerWidth) / 2);
export const clampCol = (v: number, min: number) => Math.min(colMax(), Math.max(min, Math.round(Number(v) || min)));

export type ColHandle = {
  width: number;
  style: CSSProperties;
  /** 压在列边界上的把手用：onPointerDown 直接绑 */
  onResizeStart: (e: { clientX: number; button: number; preventDefault: () => void; currentTarget: EventTarget | null }) => void;
  /** 键盘微调（方向键 ±16px） */
  nudge: (dx: number) => void;
};

/**
 * 单列的可拖宽度。
 * 关键取舍：拖动过程中只改容器上的 CSS 变量，不动 React state——
 * 否则每移动一个像素整页（消息列表 / 文件表 / 会话流）都要重画，手感发涩。松手才落 state + localStorage。
 * 把手用 closest('.paneled') 找宿主容器，所以调用方不必透传 ref；
 * invert=true 给右侧栏用（往左拖是变宽）。
 */
export function useColWidth(storageKey: string, o: { def: number; min: number; cssVar: string; invert?: boolean }): ColHandle {
  const { def, min, cssVar, invert } = o;
  const key = `fm.w.${storageKey}`;
  const [width, setWidth] = useState(() => {
    let raw = NaN;
    try { raw = Number(localStorage.getItem(key)); } catch { raw = NaN; }
    return Number.isFinite(raw) && raw > 0 ? clampCol(raw, min) : def;
  });

  const save = useCallback((v: number) => {
    setWidth(v);
    try { localStorage.setItem(key, String(v)); } catch { /* 隐私模式忽略 */ }
  }, [key]);

  // 窗口变小后原宽度可能超半屏，重新夹一次
  useEffect(() => {
    const onResize = () => setWidth((cur) => clampCol(cur, min));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [min]);

  const onResizeStart = useCallback((e: { clientX: number; button: number; preventDefault: () => void; currentTarget: EventTarget | null }) => {
    if (e.button) return;
    const col = (e.currentTarget as HTMLElement | null)?.closest('.paneled') as HTMLElement | null;
    if (!col) return;
    e.preventDefault();
    const startX = e.clientX;
    const inline = parseFloat(col.style.getPropertyValue(cssVar));
    const measured = cssVar === '--side-w' ? col.querySelector('.side') : col.querySelector('.detail');
    const startW = Number.isFinite(inline) && inline > 0 ? inline : (measured?.getBoundingClientRect().width ?? def);
    let next = startW;
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => {
      const delta = invert ? startX - ev.clientX : ev.clientX - startX;
      next = clampCol(startW + delta, min);
      col.style.setProperty(cssVar, `${next}px`);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.classList.remove('col-resizing');
      save(next);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, [cssVar, def, invert, min, save]);

  const nudge = useCallback((dx: number) => {
    setWidth((cur) => {
      const v = clampCol(cur + (invert ? -dx : dx), min);
      try { localStorage.setItem(key, String(v)); } catch { /* ignore */ }
      return v;
    });
  }, [invert, key, min]);

  const style = useMemo(() => ({ [cssVar]: `${width}px` } as unknown as CSSProperties), [cssVar, width]);
  return { width, style, onResizeStart, nudge };
}

/**
 * 一个页面同时管两列：左边第二列（会话 / 空间列表）与右侧详情栏，都可拖。
 * style 直接铺在 .paneled 容器上；side / detail 各自带把手回调。
 */
export function usePageCols(pageKey: string, opts?: { detailDef?: number; detailKey?: string }) {
  const side = useColWidth(`${pageKey}.side`, { def: COL.sideDef, min: COL.sideMin, cssVar: '--side-w' });
  const detail = useColWidth(opts?.detailKey ?? `${pageKey}.detail`, {
    def: opts?.detailDef ?? COL.detailDef, min: COL.detailMin, cssVar: '--detail-w', invert: true,
  });
  const style = useMemo(() => ({ ...side.style, ...detail.style }), [side.style, detail.style]);
  return { side, detail, style };
}

/** 兼容旧调用：只关心第二列的场合 */
export type PaneWidth = ColHandle;
export function usePaneWidth(key: string): ColHandle {
  return useColWidth(`${key}.side`, { def: COL.sideDef, min: COL.sideMin, cssVar: '--side-w' });
}

/**
 * 搜索/筛选状态进 URL（便于分享与后退）。
 * 关键约定：params 永远包含 defaults 里的每个键。清空某项时回落到默认值而不是删键——
 * 之前删键会让调用方的 params.q 变成 undefined，`searchQ.trim()` 直接抛错，
 * 表现为「Workspace 切换空间 / 搜索」整页崩溃。
 */
/**
 * 合并一次 URL 状态更新：纯逻辑在 ./url-state.ts（可单测），这里只负责读写 location。
 * 曾经这里写的是 `const next = { ...defaults }`：从默认值起步、只覆盖本次 patch 的键，
 * 于是 `update({ focus: 'x' })` 会把 `folder` 悄悄抹成 ''。
 * 在文档页的表现就是：点任意一个文件 → 当前目录丢了 → 列表回落到「我的文件」根，
 * 看起来像"点文档跳到了个人空间的 index.html"，也造成了"目录里明明有子文件夹却显示空"。
 */
export function usePersistentState<T>(name: string, initial: T) {
  const qc = useQueryClient();
  const user = qc.getQueryData<Me>(['me'])?.user.id ?? 'local';
  const key = `fm.ui.${user}.${currentOrg() ?? 'none'}.${name}`;
  const read = (): T => { try { const value = localStorage.getItem(key); return value === null ? initial : JSON.parse(value); } catch { return initial; } };
  const [saved, setSaved] = useState<{key:string;value:T}>(()=>({key,value:read()}));
  const value = saved.key === key ? saved.value : read();
  const setValue = (next: T | ((previous:T)=>T)) => setSaved(previous => {
    const current = previous.key === key ? previous.value : read();
    const resolved = typeof next === 'function' ? (next as (previous:T)=>T)(current) : next;
    try { localStorage.setItem(key, JSON.stringify(resolved)); } catch { /* 浏览器存储是可选能力，隐私模式下失败就忽略。 */ }
    return {key,value:resolved};
  });
  return [value,setValue] as const;
}

export function useUrlState(defaultsRaw: Record<string, string>) {
  const route = useLocation();
  const qc = useQueryClient();
  const namespace=`${qc.getQueryData<Me>(['me'])?.user.id??'local'}:${currentOrg()??'none'}:${route.pathname}`;
  const lastNamespace=useRef(namespace);
  const skipSave=useRef(false);
  const [remembered, remember] = usePersistentState<Record<string,string>>(`route.${route.pathname}`, {});
  const defaultsRef = useRef(defaultsRaw);
  const defaults = defaultsRef.current;
  const read = () => {
    const p = new URLSearchParams(location.search);
    const out: Record<string, string> = { ...defaults, ...remembered };
    for (const k of Object.keys(defaults)) { const v = p.get(k); if (v !== null) out[k] = v; }
    return out;
  };
  const [params, setParams] = useState<Record<string, string>>(read);
  useEffect(() => {if(lastNamespace.current!==namespace){skipSave.current=true;lastNamespace.current=namespace;} setParams(read()); }, [namespace, route.search]);
  useEffect(() => {if(skipSave.current){skipSave.current=false;return;} remember(Object.fromEntries(Object.entries(params).filter(([key])=>!['focus','history'].includes(key)))); }, [params,namespace]);
  const update = useCallback((patch: Record<string, string | null>) => {
    setParams((cur) => {
      const next = mergeUrlState(defaults, cur, patch);
      const q = urlStateToQuery(next, defaults);
      history.replaceState(null, '', `${location.pathname}${q ? `?${q}` : ''}${location.hash}`);
      return next;
    });
  }, []);
  return useMemo(() => ({ params, update }), [params, update]);
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('zh-CN') : '—');
export const fmtSize = (n?: number | null) => {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};
export function fmtRel(iso?: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return fmtDate(iso);
}

