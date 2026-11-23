// FlowMate · API 客户端：统一信封 {data,request_id} / {error:{code,message,field_errors}}
// 写请求自动带 X-FlowMate-Client（CSRF 第二层）与组织头；需要幂等的写入传 idemKey。
const BASE = '/api/v1';
const ORG_KEY = 'fm.org';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number, public field_errors?: Record<string, string>, public extra?: Record<string, unknown>) {
    super(message);
  }
  get isBusy() { return this.code === 'RESOURCE_BUSY'; }
  get isStale() { return this.code === 'PROPOSAL_STALE' || this.code === 'VERSION_CONFLICT'; }
  get isProvider() { return this.code === 'PROVIDER_UNAVAILABLE'; }
}

export function currentOrg(): string | null {
  try { return localStorage.getItem(ORG_KEY); } catch { return null; }
}
export function setCurrentOrg(id: string | null) {
  try {
    if (id) localStorage.setItem(ORG_KEY, id);
    else localStorage.removeItem(ORG_KEY);
  } catch { /* 隐私模式下忽略 */ }
}

export function idem(prefix = 'k'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Opts = { body?: unknown; query?: Record<string, string | number | boolean | null | undefined>; idemKey?: string; signal?: AbortSignal; form?: FormData };

async function request<T>(method: string, path: string, opts: Opts = {}): Promise<T> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = `${BASE}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const headers: Record<string, string> = { 'X-FlowMate-Client': 'web' };
  const org = currentOrg();
  if (org) headers['X-Organization-Id'] = org;
  if (opts.idemKey) headers['Idempotency-Key'] = opts.idemKey;
  let body: BodyInit | undefined;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, credentials: 'same-origin', signal: opts.signal });
  } catch (e) {
    throw new ApiError('NETWORK', `网络不可用：${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let parsed: { data?: T; error?: { code: string; message: string; field_errors?: Record<string, string> | null; [k: string]: unknown } } = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: { code: 'BAD_RESPONSE', message: text.slice(0, 200) } }; }
  if (!res.ok || parsed.error) {
    const err = parsed.error ?? { code: 'UNKNOWN', message: `请求失败（HTTP ${res.status}）` };
    const { code, message, field_errors, ...extra } = err;
    throw new ApiError(String(code ?? 'UNKNOWN'), String(message ?? '请求失败'), res.status,
      (field_errors as Record<string, string> | undefined) ?? undefined, extra);
  }
  return parsed.data as T;
}

export const api = {
  get: <T,>(path: string, query?: Opts['query'], signal?: AbortSignal) => request<T>('GET', path, { query, signal }),
  post: <T,>(path: string, body?: unknown, opts?: Opts) => request<T>('POST', path, { ...opts, body }),
  patch: <T,>(path: string, body?: unknown, opts?: Opts) => request<T>('PATCH', path, { ...opts, body }),
  put: <T,>(path: string, body?: unknown, opts?: Opts) => request<T>('PUT', path, { ...opts, body }),
  del: <T,>(path: string, opts?: Opts) => request<T>('DELETE', path, opts ?? {}),
  upload: <T,>(path: string, form: FormData, idemKey?: string) => request<T>('POST', path, { form, idemKey }),
};

/** 后端返回的 JSON 列可能仍是字符串 */
export function jsonOf<T>(v: unknown, fallback: T): T {
  if (v === null || v === undefined || v === '') return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

/**
 * 取列表：后端列表接口有两种形状——裸数组，或 `{ folders, files }` / `{ entries }` 这类包装对象。
 * 直接把包装对象当数组用会在渲染期抛 `j(...).slice is not a function`，整页崩溃
 * （Agent 会话右栏就踩过：/sessions/:id/files 返回对象，前端按数组 slice）。
 * 这里统一收口：取不到数组一律回落空数组，页面宁可显示「暂无」也不崩。
 */
export function arrOf<T = Json>(v: unknown, key?: string): T[] {
  const x = jsonOf<unknown>(v, null);
  if (Array.isArray(x)) return x as T[];
  if (x && typeof x === 'object') {
    const o = x as Json;
    if (key && Array.isArray(o[key])) return o[key] as T[];
    for (const k of ['entries', 'items', 'rows', 'list', 'results']) {
      if (Array.isArray(o[k])) return o[k] as T[];
    }
  }
  return [];
}

export type Json = Record<string, any>;
