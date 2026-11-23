// FlowMate · ModelAdapter（PRD §18：流式文本、结构化计划、视觉能力检测、usage、超时与错误）
// 硬约束：密钥只在后端与 .env；真实调用失败不得用预制结果冒充成功。
import { config } from '../core/config';
import { AppError } from '../core/errors';
import { getDb, nowIso, uuid } from '../core/db';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}

export interface ModelUsage { input_tokens: number | null; output_tokens: number | null }

export interface ModelResult {
  text: string;
  model: string;
  provider: string;
  usage: ModelUsage;
  latency_ms: number;
  truncated: boolean;
}

export interface ModelStatus {
  configured: boolean;
  provider: string;
  base_url: string;
  model: string;
  vision_model: string;
  supports_vision: boolean | null;
  vision_checked_at: string | null;
  missing: string[];
  last_error: string | null;
}

let lastError: string | null = null;
let visionCache: { value: boolean | null; checked_at: string | null } = { value: null, checked_at: null };

/**
 * provider 标签：写「实际在用的是谁家模型」，不再一律记成一个笼统的协议名。
 * 传输线格式不变（见 endpoint()/headers()），这里更正的只是界面展示、
 * 启动横幅、discovery_imports.provider 与 usage_records.provider 这几个记账字段。
 * 取值优先按 MODEL_BASE_URL 的域名识别；识别不到时退回域名主段（去掉开头 api.），完全解析不了才记 custom-gateway。
 */
const PROVIDER_HOSTS: Array<[RegExp, string]> = [
  [/deepseek/, 'deepseek'],
  [/dashscope|aliyuncs\.com/, 'dashscope'],
  [/moonshot/, 'moonshot'],
  [/zhipu|bigmodel/, 'zhipu'],
  [/volces|ark\.cn/, 'volc-ark'],
  [/tencent|hunyuan/, 'tencent-hunyuan'],
  [/groq/, 'groq'],
  [/mistral/, 'mistral'],
];

export function providerLabel(): string {
  const raw = config.model.baseUrl;
  if (!raw) return 'unconfigured';
  let host = '';
  try { host = new URL(raw).hostname.toLowerCase(); }
  catch { host = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  if (!host) return 'custom-gateway';
  for (const [re, name] of PROVIDER_HOSTS) if (re.test(host)) return name;
  // 本机地址 / IP 直连（自建网关）认不出厂商，如实落回协议名，不瞎猜
  if (host === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) return 'custom-gateway';
  const main = host.replace(/^api\./, '').split('.')[0];
  return main || 'custom-gateway';
}

export function modelStatus(): ModelStatus {
  const missing: string[] = [];
  if (!config.model.baseUrl) missing.push('MODEL_BASE_URL');
  if (!config.model.apiKey) missing.push('MODEL_API_KEY');
  if (!config.model.model) missing.push('MODEL_NAME');
  return {
    configured: missing.length === 0,
    provider: missing.length === 0 ? providerLabel() : 'unconfigured',
    base_url: config.model.baseUrl || '(未配置)',
    model: config.model.model || '(未配置)',
    vision_model: config.model.visionModel || '(未配置)',
    supports_vision: visionCache.value,
    vision_checked_at: visionCache.checked_at,
    missing,
    last_error: lastError,
  };
}

function endpoint() {
  const raw = config.model.baseUrl;
  if (!raw) throw AppError.providerUnavailable('未配置 MODEL_BASE_URL，AI 能力不可用（FlowMate 不会伪造模型结果）');
  const base = raw.replace(/\/+$/, '');
  // 已经指到 completions 就用它本身
  if (/chat\/completions$|completions$/.test(base)) return base;
  // 裸域名（如 https://api.deepseek.com）必须补 /v1，否则会打到不存在的根路径
  let pathname = '/';
  try { pathname = new URL(base).pathname; } catch { /* 保留默认 */ }
  if (!pathname || pathname === '/') return `${base}/v1/chat/completions`;
  return `${base}/chat/completions`;
}

function headers() {
  if (!config.model.apiKey) throw AppError.providerUnavailable('未配置 MODEL_API_KEY，AI 能力不可用（FlowMate 不会伪造模型结果）');
  return { 'content-type': 'application/json', authorization: `Bearer ${config.model.apiKey}` };
}

/** 密钥永不进入日志与模型上下文 */
function redact(s: string) {
  return s.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').slice(0, 600);
}

export interface ChatOpts {
  user_id?: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  purpose?: string;
  session_id?: string | null;
  run_id?: string | null;
  step_id?: string | null;
  import_id?: string | null;
  model?: string;
  timeoutMs?: number;
}

export async function chat(opts: ChatOpts): Promise<ModelResult> {
  const url = endpoint();
  const h = headers();
  const body: Record<string, unknown> = {
    model: opts.model || config.model.model,
    messages: opts.messages,
    temperature: opts.temperature ?? config.model.temperature,
    stream: false,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.json && config.model.jsonMode) body.response_format = { type: 'json_object' };
  // 厂商专有参数透传（推理型网关常需要显式关闭思考或设 reasoning_effort）
  if (config.model.extraParams && Object.keys(config.model.extraParams).length) Object.assign(body, config.model.extraParams);
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? config.model.timeoutMs);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    const msg = (e as Error).name === 'AbortError' && !opts.signal?.aborted
      ? `模型请求超时（${(opts.timeoutMs ?? config.model.timeoutMs) / 1000}s）`
      : `模型请求失败：${redact((e as Error).message)}`;
    lastError = msg;
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable(msg);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const raw = await res.text();
  if (!res.ok) {
    const msg = `模型服务返回 ${res.status}：${redact(raw)}`;
    lastError = msg;
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable(msg);
  }
  let data: {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };
  try {
    data = JSON.parse(raw);
  } catch {
    lastError = '模型返回非 JSON 响应体';
    throw AppError.providerUnavailable('模型返回无法解析的响应体');
  }
  const msg = data.choices?.[0]?.message as { content?: string; reasoning_content?: string } | undefined;
  // 推理型网关会先吐 reasoning_content 再吐 content：只认 content，空则明确失败，绝不拿思考过程冒充答案
  const text = (msg?.content ?? '').trim();
  if (!text.trim() && msg?.reasoning_content && !msg.content) {
    lastError = '模型只产出了思考过程，未给出最终答案（可能是输出长度被截断）';
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable(lastError);
  }
  if (!text.trim()) {
    lastError = '模型返回空内容';
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable('模型返回空内容，未生成任何结果');
  }
  lastError = null;
  const usage: ModelUsage = {
    input_tokens: data.usage?.prompt_tokens ?? null,      // 未知用 null，不写 0
    output_tokens: data.usage?.completion_tokens ?? null,
  };
  recordUsage({ ...opts, model: data.model || opts.model }, usage, false, Date.now() - started);
  return {
    text,
    model: data.model || String(body.model),
    provider: providerLabel(),
    usage,
    latency_ms: Date.now() - started,
    truncated: data.choices?.[0]?.finish_reason === 'length',
  };
}

/** 流式：产出增量文本；最终结果仍是权威（PRD §19 分片非持久真相） */
export async function* chatStream(opts: ChatOpts): AsyncGenerator<{ delta: string; done?: ModelResult }> {
  const url = endpoint();
  const h = headers();
  const body = {
    model: opts.model || config.model.model,
    messages: opts.messages,
    temperature: opts.temperature ?? config.model.temperature,
    stream: true,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  };
  const started = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? config.model.timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body), signal: opts.signal ?? ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    lastError = `模型请求失败：${redact((e as Error).message)}`;
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable(lastError);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const raw = await res.text().catch(() => '');
    lastError = `模型服务返回 ${res.status}：${redact(raw)}`;
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable(lastError);
  }
  let full = '';
  let usage: ModelUsage = { input_tokens: null, output_tokens: null };
  let model = String(body.model);
  try {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            model?: string;
          };
          if (j.model) model = j.model;
          if (j.usage) usage = { input_tokens: j.usage.prompt_tokens ?? usage.input_tokens, output_tokens: j.usage.completion_tokens ?? usage.output_tokens };
          const d = j.choices?.[0]?.delta?.content;
          if (d) { full += d; yield { delta: d }; }
        } catch { /* 忽略心跳行 */ }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!full.trim()) {
    recordUsage(opts, null, true, Date.now() - started);
    throw AppError.providerUnavailable('模型流式响应为空，未生成任何结果');
  }
  recordUsage({ ...opts, model }, usage, false, Date.now() - started);
  yield { delta: '', done: { text: full, model, provider: providerLabel(), usage, latency_ms: Date.now() - started, truncated: false } };
}

/** 结构化输出：schema 校验失败可有限重试一次（§14.3 失败策略） */
export async function chatJson<T>(opts: ChatOpts, validate: (raw: unknown) => T): Promise<{ value: T; result: ModelResult }> {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= Math.max(0, config.model.maxRetries)) {
    attempt++;
    const result = await chat({ ...opts, json: true });
    try {
      return { value: validate(parseJson(result.text)), result };
    } catch (e) {
      lastErr = e;
      if (attempt > config.model.maxRetries) break;
    }
  }
  throw AppError.modelInvalid(`模型输出结构校验失败（已重试 ${config.model.maxRetries} 次）：${(lastErr as Error)?.message ?? ''}`);
}

export function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/.exec(trimmed);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    const s = body.indexOf('{');
    const e = body.lastIndexOf('}');
    const a = body.indexOf('[');
    const b = body.lastIndexOf(']');
    const start = s >= 0 && (a < 0 || s < a) ? s : a;
    const end = e >= 0 && (b < 0 || e > b) ? e : b;
    if (start >= 0 && end > start) {
      try { return JSON.parse(body.slice(start, end + 1)); } catch { /* fallthrough */ }
    }
    throw new Error('响应中不含合法 JSON');
  }
}

/** 视觉能力检测：真实发一次极小探测请求，结果缓存（PRD §18 视觉能力检测） */
export async function detectVision(): Promise<boolean> {
  if (visionCache.value !== null) return visionCache.value;
  if (!config.model.baseUrl || !config.model.apiKey) {
    visionCache = { value: false, checked_at: null };
    return false;
  }
  const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  try {
    await chat({
      model: config.model.visionModel,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'reply with the single character: ok' }, { type: 'image_url', image_url: { url: px } }] }],
      maxTokens: 8,
      timeoutMs: 30000,
      purpose: 'vision_probe',
    });
    visionCache = { value: true, checked_at: nowIso() };
  } catch (e) {
    const msg = (e as Error).message || '';
    const unsupported = /400|unsupported|invalid|not support|image|modal/i.test(msg);
    visionCache = { value: unsupported ? false : null, checked_at: nowIso() };
    lastError = `视觉能力探测：${redact(msg)}`;
  }
  return visionCache.value === true;
}

export function resetVisionCache() {
  visionCache = { value: null, checked_at: null };
}

function recordUsage(opts: ChatOpts, usage: ModelUsage | null, failed: boolean, latency: number) {
  try {
    const d = getDb();
    const org=currentOrg(opts);
    const user=opts.user_id ?? (opts.run_id ? d.val<string>('SELECT q.creator_id FROM runs r JOIN requests q ON q.id=r.request_id WHERE r.id=? AND r.organization_id=?',opts.run_id,org):null) ?? (opts.import_id?d.val<string>('SELECT uploader_id FROM discovery_imports WHERE id=? AND organization_id=?',opts.import_id,org):null) ?? (opts.session_id?d.val<string>("SELECT owner_id FROM agent_sessions WHERE id=? AND organization_id=? AND mode='personal'",opts.session_id,org):null);
    d.run(`INSERT INTO usage_records(id,user_id,organization_id,session_id,run_id,step_id,import_id,provider,model,input_tokens,output_tokens,calls,failures,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      uuid(), user ?? null, org, opts.session_id ?? null, opts.run_id ?? null, opts.step_id ?? null, opts.import_id ?? null,
      providerLabel(), opts.model || config.model.model || null,
      usage?.input_tokens ?? null, usage?.output_tokens ?? null, failed ? 1 : 0, nowIso());
    void latency;
  } catch {
    /* 用量记录失败不得影响业务 */
  }
}

function currentOrg(opts: ChatOpts): string {
  if (opts.session_id) {
    return getDb().val<string>('SELECT organization_id FROM agent_sessions WHERE id=?', opts.session_id) ?? '';
  }
  if (opts.import_id) return getDb().val<string>('SELECT organization_id FROM discovery_imports WHERE id=?', opts.import_id) ?? '';
  return getDb().val<string>('SELECT id FROM organizations LIMIT 1') ?? '';
}
