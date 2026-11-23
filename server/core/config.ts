// FlowMate · 配置与启动期校验（PRD §21 环境与密钥）
import fs from 'node:fs';
import path from 'node:path';

/** 工程根：从 cwd 与 __dirname 向上找 package.json，兼容 dist/ 编译产物与源码两种运行位置 */
function findRoot(): string {
  const starts = [process.cwd(), __dirname];
  for (const start of starts) {
    let dir = path.resolve(start);
    for (let i = 0; i < 8; i++) {
      if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'db', 'migrations'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  return path.resolve(__dirname, '..', '..');
}
const ROOT = findRoot();

function loadEnvFile() {
  const f = path.join(ROOT, '.env');
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m && process.env[m[1]] === undefined) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    }
  }
}
loadEnvFile();

const int = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const bool = (k: string, d: boolean) => {
  const v = process.env[k];
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
};

/** §07 允许列表：扩展名 → 能力矩阵。上限全部可配置，默认值即规格表。 */
export type FileKind = 'markdown' | 'text' | 'html' | 'word' | 'pdf' | 'excel' | 'ppt' | 'image';
export interface TypeRule {
  kind: FileKind;
  exts: string[];
  mimes: string[];
  maxBytes: number;
  extract: boolean;
  preview: string;
  editable: boolean;
  agentReadable: boolean | 'when_text_layer';
  note?: string;
}

export const DOCUMENT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

export const config = {
  root: ROOT,
  host: process.env.FLOWMATE_HOST || '0.0.0.0',
  port: int('FLOWMATE_PORT', 8080),
  dataDir: path.resolve(ROOT, process.env.FLOWMATE_DATA_DIR || 'data'),
  storageDir: path.resolve(ROOT, process.env.FLOWMATE_STORAGE_DIR || 'storage'),
  clientDir: path.resolve(ROOT, 'dist/client'),
  publicOrigin: process.env.FLOWMATE_PUBLIC_ORIGIN || '',
  sessionTtlDays: int('SESSION_TTL_DAYS', 7),
  cookieSecure: bool('COOKIE_SECURE', false), // 局域网 HTTP → Secure=false（§21 / D6）
  lanBanner: bool('FLOWMATE_LAN_BANNER', true),
  loginMaxAttempts: int('LOGIN_MAX_ATTEMPTS', 8),
  loginWindowMinutes: int('LOGIN_WINDOW_MINUTES', 10),
  batchUploadMaxFiles: int('BATCH_UPLOAD_MAX_FILES', 20),
  approval: {
    firstReminderHours: int('APPROVAL_REMIND_FIRST_HOURS', 1),
    reminderIntervalHours: int('APPROVAL_REMIND_INTERVAL_HOURS', 24),
    suspendHours: int('APPROVAL_SUSPEND_HOURS', 72),
  },
  runSlotsPerSession: int('RUN_SLOTS_PER_SESSION', 2),
  runLeaseSeconds: int('RUN_LEASE_SECONDS', 60),
  model: {
    baseUrl: (process.env.MODEL_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.MODEL_API_KEY || '',
    model: process.env.MODEL_NAME || '',
    visionModel: process.env.MODEL_VISION_NAME || process.env.MODEL_NAME || '',
    timeoutMs: int('MODEL_TIMEOUT_MS', 120000),
    maxRetries: int('MODEL_MAX_RETRIES', 1), // §14.3 可有限重试一次
    temperature: Number(process.env.MODEL_TEMPERATURE ?? 0.2),
    jsonMode: ['1','true','yes'].includes((process.env.MODEL_JSON_MODE ?? '0').toLowerCase()),
    maxTokens: int('MODEL_MAX_TOKENS', 0),
    /** 透传给网关的厂商专有参数（如 {"thinking":{"type":"disabled"}}），解析失败则为空对象 */
    extraParams: (() => { try { return JSON.parse(process.env.MODEL_EXTRA_PARAMS || '{}') as Record<string, unknown>; } catch { return {}; } })(),   // 0 = 不下发 max_tokens，交给服务端默认（推理型模型会被截空 content）
  },
  extractionTimeoutMs: int('EXTRACTION_TIMEOUT_MS', 60000),
  types: [
    {
      kind: 'markdown', exts: ['.md', '.markdown'], mimes: ['text/markdown'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'rendered+source', editable: true, agentReadable: true,
    },
    {
      kind: 'text', exts: ['.txt'], mimes: ['text/plain'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'monospace', editable: true, agentReadable: true,
    },
    {
      kind: 'html', exts: ['.html', '.htm'], mimes: ['text/html'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'sandbox_iframe', editable: true, agentReadable: true,
      note: '永不作为可信内容在同源渲染执行（sandbox 禁脚本）',
    },
    {
      kind: 'word', exts: ['.docx'], mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'html_readonly', editable: false, agentReadable: true,
    },
    {
      kind: 'pdf', exts: ['.pdf'], mimes: ['application/pdf'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'browser_pdf', editable: false, agentReadable: 'when_text_layer',
      note: '无文本层不 OCR',
    },
    {
      kind: 'excel', exts: ['.xlsx', '.csv'], mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'table_readonly', editable: false, agentReadable: true,
    },
    {
      kind: 'ppt', exts: ['.pptx'], mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      maxBytes: DOCUMENT_UPLOAD_MAX_BYTES, extract: true, preview: 'slide_text_cards', editable: false, agentReadable: true,
    },
    {
      kind: 'image', exts: ['.png', '.jpg', '.jpeg', '.webp', '.gif'], mimes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxBytes: 10 * 1024 * 1024, extract: false, preview: 'inline', editable: false, agentReadable: 'vision_only',
    },
  ] as TypeRule[],
};

/** §07.1 允许列表之外的处理 */
export const rejected = {
  legacy: ['.doc', '.xls', '.ppt'],
  executable: ['.exe', '.bat', '.cmd', '.ps1', '.sh', '.jar', '.msi', '.com', '.scr', '.vbs', '.js', '.vbs', '.svg'],
  archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
};

export const csvMaxBytes = 5 * 1024 * 1024;

export function rulesFor(ext: string): TypeRule | undefined {
  const e = ext.toLowerCase();
  return config.types.find((t) => t.exts.includes(e));
}

export function missingEnv(): string[] {
  const miss: string[] = [];
  if (!config.model.baseUrl) miss.push('MODEL_BASE_URL');
  if (!config.model.apiKey) miss.push('MODEL_API_KEY');
  if (!config.model.model) miss.push('MODEL_NAME');
  return miss;
}

export function ensureDirs() {
  for (const d of [config.dataDir, config.storageDir]) fs.mkdirSync(d, { recursive: true });
}
