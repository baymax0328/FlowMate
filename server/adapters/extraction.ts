// FlowMate · 正文抽取管道（PRD §07 能力矩阵 / §15 末注 / §18 文档解析）
// 抽取一次，同时服务正文检索与 Agent 的 doc.extract；解析在 Worker 中跑，带超时与大小上限。
import { extOf } from '../core/paths';
import { config, rulesFor, type TypeRule } from '../core/config';
import { pathToFileURL } from 'node:url';
import { tokensToIndex } from '../core/tokens';

export interface Block {
  block_id: string;
  seq: number;
  unit: number;                 // 页 / 工作表 / 幻灯片序号（从 1 开始，段落类为 0）
  kind: 'heading' | 'paragraph' | 'table' | 'page' | 'sheet' | 'slide' | 'note' | 'line';
  heading?: string;
  text: string;
  anchor: Record<string, number | string>;
  html?: string;                // docx 只读预览
  rows?: string[][];            // xlsx/csv 只读表格视图
  truncated?: boolean;
}

export interface ExtractResult {
  status: 'ready' | 'unavailable' | 'failed';
  reason?: string;
  raw_text: string;
  tokens: string;
  blocks: Block[];
  unit_count: number;
  provider: string;
  preview: { kind: 'rendered_markdown' | 'monospace' | 'sandbox_html' | 'html' | 'pdf' | 'table' | 'slide_cards' | 'image'; note?: string };
  previewHtml?: string;
}

const PROVIDER = 'flowmate-extraction/0.2 (mammoth 1.x, pdfjs 4.x, SheetJS 0.18, fast-xml-parser 4.x)';
const MAX_BLOCKS = 4000;
const MAX_ROWS = 200;

export function ruleFor(name: string, mime?: string): TypeRule | undefined {
  const r = rulesFor(extOf(name));
  if (r) return r;
  if (mime) return config.types.find((t) => t.mimes.includes(mime));
  return undefined;
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`EXTRACT_TIMEOUT: ${label} 超过 ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** 唯一的抽取入口：按类型分流 */
export async function extract(name: string, buf: Buffer, mime: string): Promise<ExtractResult> {
  const rule = ruleFor(name, mime);
  if (!rule) return fail('未知文件类型，未做抽取');
  switch (rule.kind) {
    case 'markdown': return fromMarkdown(buf);
    case 'text': return fromText(buf);
    case 'html': return fromHtml(buf);
    case 'word': return fromDocx(buf);
    case 'pdf': return fromPdf(buf);
    case 'excel': return fromXlsx(buf, extOf(name) === '.csv');
    case 'ppt': return fromPptx(buf);
    case 'image': return unavailable('图片不适用正文抽取；可作为 Agent 视觉输入（需模型具备视觉能力）', { kind: 'image' });
    default: return unavailable('该类型不支持正文抽取');
  }
}

function finish(blocks: Block[], preview: ExtractResult['preview'], extra?: { reason?: string }): ExtractResult {
  const kept = blocks.slice(0, MAX_BLOCKS);
  const raw = kept.map((b) => b.text).join('\n\n');
  return {
    status: raw.trim() ? 'ready' : 'unavailable',
    reason: raw.trim() ? extra?.reason : '未提取到可检索文本层',
    raw_text: raw,
    tokens: tokensToIndex(raw),
    blocks: kept,
    unit_count: Math.max(...kept.map((b) => b.unit), 0),
    provider: PROVIDER,
    preview,
  };
}
function fail(reason: string): ExtractResult {
  return { status: 'failed', reason, raw_text: '', tokens: '', blocks: [], unit_count: 0, provider: PROVIDER, preview: { kind: 'monospace' } };
}
function unavailable(reason: string, preview: ExtractResult['preview'] = { kind: 'monospace' }): ExtractResult {
  return { status: 'unavailable', reason, raw_text: '', tokens: '', blocks: [], unit_count: 0, provider: PROVIDER, preview };
}

let seqCounter = 0;
function blk(part: Partial<Block> & { text: string; kind: Block['kind'] }): Block {
  seqCounter += 1;
  return { block_id: part.block_id ?? `b${part.unit ?? 0}-${part.seq ?? seqCounter}`, seq: part.seq ?? seqCounter, unit: part.unit ?? 0, anchor: part.anchor ?? {}, ...part } as Block;
}

// ---------- markdown ----------
function fromMarkdown(buf: Buffer): ExtractResult {
  const src = buf.toString('utf8');
  const blocks: Block[] = [];
  let i = 0;
  let current: { heading?: string; lines: string[]; start: number } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) blocks.push(blk({ text, kind: current.heading ? 'heading' : 'paragraph', heading: current.heading, seq: ++i, anchor: { line_start: current.start, line_end: current.start + current.lines.length } }));
    current = null;
  };
  const lines = src.split(/\r?\n/);
  let inFence = false;
  lines.forEach((line, idx) => {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (h) {
      flush();
      current = { heading: h[2].trim(), lines: [line], start: idx + 1 };
      flush();
    } else {
      if (!current) current = { lines: [], start: idx + 1 };
      current.lines.push(line);
    }
  });
  flush();
  return finish(blocks, { kind: 'rendered_markdown' });
}

// ---------- 纯文本 ----------
function fromText(buf: Buffer): ExtractResult {
  const src = buf.toString('utf8');
  const lines = src.split(/\r?\n/);
  const blocks: Block[] = [];
  let buf2: string[] = [];
  let start = 1;
  let i = 0;
  const flush = () => {
    const text = buf2.join('\n').trim();
    if (text) blocks.push(blk({ text, kind: 'paragraph', seq: ++i, anchor: { line_start: start, line_end: start + buf2.length - 1 } }));
    buf2 = [];
  };
  lines.forEach((l, idx) => {
    if (!l.trim()) { flush(); start = idx + 2; return; }
    if (!buf2.length) start = idx + 1;
    buf2.push(l);
  });
  flush();
  if (!blocks.length && src.trim()) blocks.push(blk({ text: src.trim(), kind: 'paragraph', seq: 1, anchor: { line_start: 1, line_end: lines.length } }));
  return finish(blocks, { kind: 'monospace' });
}

// ---------- HTML：去标签取正文 ----------
async function fromHtml(buf: Buffer): Promise<ExtractResult> {
  const { parse } = await require_('node-html-parser') as typeof import('node-html-parser');
  const src = buf.toString('utf8');
  const root = parse(src, { blockTextElements: { script: false, noscript: false, style: false, pre: true } });
  root.querySelectorAll('script,style,meta,link,noscript').forEach((n) => n.remove());
  const blocks: Block[] = [];
  let i = 0;
  const walk = (node: import('node-html-parser').HTMLElement, heading?: string) => {
    for (const child of node.childNodes as import('node-html-parser').HTMLElement[]) {
      const tag = (child as unknown as { rawTagName?: string }).rawTagName?.toLowerCase?.();
      if (!child || typeof child.text !== 'string') continue;
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(String(tag))) {
        const t = child.text.trim();
        if (t) blocks.push(blk({ text: t, kind: 'heading', heading: t, seq: ++i, anchor: { selector: String(tag) } }));
        walk(child, t);
      } else if (tag === 'table') {
        const rows = (child.querySelectorAll('tr') || []).map((tr) => (tr.querySelectorAll('td,th') || []).map((td) => td.text.replace(/\s+/g, ' ').trim()));
        const text = rows.map((r) => r.join(' | ')).join('\n');
        if (text.trim()) blocks.push(blk({ text: `${heading ? heading + '\n' : ''}${text}`, kind: 'table', heading, rows, truncated: rows.length > MAX_ROWS, seq: ++i, anchor: {} }));
      } else if (['p', 'li', 'pre', 'blockquote', 'td'].includes(String(tag))) {
        const t = child.text.replace(/\s+/g, ' ').trim();
        if (t && t.length > 1) blocks.push(blk({ text: t, kind: 'paragraph', heading, seq: ++i, anchor: {} }));
      } else {
        walk(child, heading);
      }
    }
  };
  walk(root as unknown as import('node-html-parser').HTMLElement);
  const fallback = root.text.replace(/\s+/g, ' ').trim();
  const res = finish(blocks.length ? blocks : [blk({ text: fallback, kind: 'paragraph', seq: 1, anchor: {} })], { kind: 'sandbox_html', note: '沙箱 iframe（禁脚本）或转文本预览' });
  if (!res.raw_text.trim() && fallback) {
    res.raw_text = fallback; res.tokens = tokensToIndex(fallback); res.status = 'ready'; res.reason = undefined;
  }
  return res;
}

function require_(mod: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(mod) as unknown;
}

// ---------- Word（docx）：标题层级 + 段落 + 表格；另出 HTML 只读预览 ----------
async function fromDocx(buf: Buffer): Promise<ExtractResult> {
  const JSZip = (require_('jszip') as { default?: typeof import('jszip') }).default as typeof import('jszip') | undefined ?? (require_('jszip') as unknown as typeof import('jszip'));
  const { XMLParser } = require_('fast-xml-parser') as typeof import('fast-xml-parser');
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) return fail('docx 缺少 word/document.xml，可能是伪装扩展名');
  const xml = await entry.async('string');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, removeNSPrefix: true, trimValues: false });
  const doc = parser.parse(xml) as OrderedNode[];
  const body = findDescendant(doc as unknown as OrderedNode, 'body');
  const blocks: Block[] = [];
  let i = 0;
  let heading: string | undefined;
  for (const node of childrenOf(body)) {
    const tag = tagName(node);
    if (tag === 'p') {
      const text = collectText(node).trim();
      const style = attr(findPath(node, 'pPr', 'pStyle'), 'val');
      const isHeading = !!style && /heading|标题|^[1-6]$/i.test(style);
      if (!text) continue;
      if (isHeading) {
        heading = text;
        blocks.push(blk({ text, kind: 'heading', heading: text, seq: ++i, anchor: { paragraph: i, style: String(style) } }));
      } else {
        blocks.push(blk({ text, kind: 'paragraph', heading, seq: ++i, anchor: { paragraph: i, style: style ?? '' } }));
      }
    } else if (tag === 'tbl') {
      const rows = childEls(node, 'tr').map((tr) =>
        childEls(tr, 'tc').map((tc) => collectText(tc).replace(/\s+/g, ' ').trim()));
      const text = rows.map((r) => r.join(' | ')).join('\n');
      if (text.trim()) blocks.push(blk({ text: `${heading ? heading + '\n' : ''}${text}`, kind: 'table', heading, rows, truncated: rows.length > MAX_ROWS, seq: ++i, anchor: {} }));
    }
  }
  let html = '';
  try {
    const mammoth = require_('mammoth') as typeof import('mammoth');
    const out = await mammoth.convertToHtml({ buffer: buf } as never);
    html = (out as { value: string }).value;
  } catch (e) {
    html = '';
  }
  const res = finish(blocks, { kind: 'html', note: '转 HTML 只读预览（保留标题层级与表格），不在线编辑' });
  if (html) res.previewHtml = html;
  return res;
}

// ---------- PDF：有文本层逐页提取；无文本层不 OCR ----------
async function fromPdf(buf: Buffer): Promise<ExtractResult> {
  const mod = await importEsm('pdfjs-dist/legacy/build/pdf.mjs') as {
    getDocument: (src: { data: Uint8Array; useWorkerFetch?: boolean; isEvalSupported?: boolean; disableFontFace?: boolean }) => { promise: { promise: Promise<PdfDoc> } } | { promise: Promise<PdfDoc> };
    GlobalWorkerOptions?: { workerSrc: string };
    version?: string;
  };
  if (mod.GlobalWorkerOptions) {
    // Node 下必须给出真实 worker 文件（空字符串会让 v4 的 fake worker 加载失败）
    try {
      const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
      mod.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
    } catch {
      mod.GlobalWorkerOptions.workerSrc = '';
    }
  }
  const src = mod.getDocument({ data: new Uint8Array(buf), useWorkerFetch: false, isEvalSupported: false, disableFontFace: true });
  const doc = await ((src as { promise?: Promise<PdfDoc> }).promise ?? (src as unknown as Promise<PdfDoc>));
  const blocks: Block[] = [];
  let charTotal = 0;
  const pages = Math.min(doc.numPages, 400);
  for (let p = 1; p <= pages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const lines: string[] = [];
    let cur = '';
    let lastY: number | null = null;
    for (const it of tc.items as { str?: string; transform?: number[] }[]) {
      if (typeof it.str !== 'string') continue;
      const y = it.transform?.[5] ?? null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 3) { lines.push(cur.trim()); cur = ''; }
      cur += it.str;
      if (y !== null) lastY = y;
    }
    if (cur.trim()) lines.push(cur.trim());
    const text = lines.filter(Boolean).join('\n');
    charTotal += text.replace(/\s/g, '').length;
    if (text.trim()) blocks.push(blk({ text, kind: 'page', seq: p, unit: p, anchor: { page: p } }));
    page.cleanup?.();
  }
  await doc.destroy?.();
  if (!charTotal) {
    return unavailable(`未检测到文本层（${doc.numPages} 页，疑为扫描版）。本版不做 OCR，正文不可检索，可作为 Agent 视觉输入或下载原文件。`, { kind: 'pdf', note: '浏览器内置 PDF 查看器' });
  }
  const res = finish(blocks, { kind: 'pdf', note: '浏览器内置 PDF 查看器' });
  res.unit_count = doc.numPages;
  return res;
}

interface PdfDoc { numPages: number; getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; cleanup?: () => void }>; destroy?: () => Promise<void> }

function importEsm(spec: string): Promise<unknown> {
  // 保留真正的动态 import（tsc 的 commonjs 输出会把 import() 变成 require()）
  return (new Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(spec);
}

// ---------- Excel ----------
async function fromXlsx(buf: Buffer, csv: boolean): Promise<ExtractResult> {
  const XLSX = require_('xlsx') as typeof import('xlsx');
  const wb = csv ? XLSX.read(buf.toString('utf8'), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'buffer', cellDates: true, dense: false });
  const blocks: Block[] = [];
  wb.SheetNames.forEach((sheetName, si) => {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: false, defval: '' }) as unknown as (string | number)[][];
    if (!rows.length) return;
    const strRows = rows.slice(0, MAX_ROWS + 1).map((r) => r.map((c) => String(c ?? '')));
    const header = strRows[0] ?? [];
    const body = strRows.slice(1);
    const text = [`工作表：${sheetName}`, header.join(' | '), ...body.map((r) => r.join(' | '))].join('\n');
    blocks.push(blk({
      text, kind: 'sheet', heading: sheetName, unit: si + 1, seq: si + 1,
      rows: [header, ...body], truncated: rows.length - 1 > MAX_ROWS,
      anchor: { sheet: sheetName, sheet_index: si + 1, rows: rows.length - 1 },
    }));
  });
  const res = finish(blocks, { kind: 'table', note: '只读表格视图（工作表切换，行数以 200 截断并提示）' });
  if (res.status === 'ready') res.reason = '首版不做 xlsx 在线编辑：提取正文 + 只读预览 + 原文件下载';
  return res;
}

// ---------- PPT ----------
async function fromPptx(buf: Buffer): Promise<ExtractResult> {
  const JSZip2 = (require_('jszip') as { default?: typeof import('jszip') }).default as typeof import('jszip') | undefined ?? (require_('jszip') as unknown as typeof import('jszip'));const JSZip = JSZip2;
  const { XMLParser } = require_('fast-xml-parser') as typeof import('fast-xml-parser');
  const zip = await JSZip.loadAsync(buf);
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', preserveOrder: true, removeNSPrefix: true });
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  if (!slideNames.length) return fail('pptx 中未找到幻灯片，可能是伪装扩展名');
  const blocks: Block[] = [];
  for (let i = 0; i < slideNames.length; i++) {
    const xml = await zip.file(slideNames[i])!.async('string');
    const parsed = parser.parse(xml) as OrderedNode;
    const spTree = findPath(parsed, 'cSld', 'spTree');
    const texts: { text: string; isTitle: boolean }[] = [];
    for (const sp of findAllEls(childrenOf(spTree), 'sp') ?? []) {
      const phType = attr(findPath(sp, 'nvSpPr', 'ph'), 'type') ?? '';
      const t = collectText(sp).trim();
      if (t) texts.push({ text: t, isTitle: /title/i.test(phType) });
    }
    const title = texts.find((t) => t.isTitle)?.text ?? texts[0]?.text ?? `第 ${i + 1} 页`;
    const body = texts.filter((t) => t.text !== title).map((t) => t.text).join('\n');
    blocks.push(blk({ text: `${title}${body ? '\n' + body : ''}`, kind: 'slide', heading: title, unit: i + 1, seq: i + 1, anchor: { slide: i + 1 } }));
    const relsName = `ppt/slides/_rels/slide${i + 1}.xml.rels`;
    if (zip.file(relsName)) {
      const rels = parser.parse(await zip.file(relsName)!.async('string')) as OrderedNode;
      for (const r of findAllEls(childrenOf(rels), 'Relationship') ?? []) {
        if (/notesSlide/.test(attr(r, 'Type') ?? '')) {
          const noteFile = 'ppt/' + String(attr(r, 'Target') ?? '').replace(/^\.\.\//, '');
          const f = zip.file(noteFile);
          if (f) {
            const nt = collectText(parser.parse(await f.async('string')) as OrderedNode).trim();
            if (nt) blocks.push(blk({ text: `演讲备注：${nt}`, kind: 'note', heading: title, unit: i + 1, seq: i + 1 + 1000, anchor: { slide: i + 1, notes: 1 } }));
          }
        }
      }
    }
  }
  return finish(blocks, { kind: 'slide_cards', note: '逐页文本卡片视图（非版式还原）' });
}

// ---------- fast-xml-parser preserveOrder 工具 ----------
// 实测 v4 preserveOrder 的节点形状是 `{ 标签名: [子节点...] }`，属性挂在同名节点的 `:@` 上，
// 文本是 `{ '#text': '…' }`。之前按 `{tag:{attributes,children}}` 解析是错的：
// 会把属性对象当子节点再展开，字符串还会被逐字符递归，直接爆栈（docx/pptx 抽取失败的真实原因）。
type OrderedNode = Record<string, unknown>;
const TEXT_KEY = '#text';
const ATTR_KEY = ':@';

function tagName(n: OrderedNode | null | undefined): string | null {
  if (!n || typeof n !== 'object') return null;
  const k = Object.keys(n)[0];
  if (!k || k === TEXT_KEY || k === ATTR_KEY || k === '?xml' || k === 'comment') return null;
  return k;
}
function childrenOf(n: unknown): OrderedNode[] {
  if (!n) return [];
  if (Array.isArray(n)) return n.filter((x) => x && typeof x === 'object') as OrderedNode[];
  if (typeof n !== 'object') return [];
  const tag = tagName(n as OrderedNode);
  if (!tag) return [];
  const v = (n as Record<string, unknown>)[tag];
  return Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') as OrderedNode[] : [];
}
function attrsOf(n: unknown): Record<string, string> {
  if (!n || typeof n !== 'object') return {};
  const a = (n as Record<string, unknown>)[ATTR_KEY];
  if (!a || typeof a !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) out[k.replace(/^@_/, '')] = String(v);
  return out;
}
/** 取属性值（不带 @ 前缀） */
function attr(n: unknown, name: string): string | undefined {
  return attrsOf(n)[name];
}
function findEls(nodes: OrderedNode[], tag: string): OrderedNode[] {
  return nodes.filter((n) => tagName(n) === tag);
}
function findAllEls(nodes: OrderedNode[] | undefined, tag: string): OrderedNode[] | undefined {
  if (!nodes) return undefined;
  const out: OrderedNode[] = [];
  const walk = (arr: OrderedNode[]) => {
    for (const n of arr) {
      if (tagName(n) === tag) out.push(n);
      walk(childrenOf(n));
    }
  };
  walk(nodes);
  return out;
}
/** 第一个匹配的后代节点本身（不是它的子节点） */
function findDescendant(node: unknown, tag: string): OrderedNode | undefined {
  for (const c of childrenOf(node)) {
    if (tagName(c) === tag) return c;
    const deep = findDescendant(c, tag);
    if (deep) return deep;
  }
  return undefined;
}
/** 指定路径（逐层）查找，如 body > p > pPr > pStyle */
function findPath(node: unknown, ...tags: string[]): OrderedNode | undefined {
  let cur: OrderedNode | undefined;
  let scope: unknown = node;
  for (const t of tags) {
    const found = findDescendant(scope, t);
    if (!found) return undefined;
    cur = found;
    scope = found;
  }
  return cur;
}
function collectText(node: unknown): string {
  const parts: string[] = [];
  const walk = (n: unknown) => {
    if (n === null || n === undefined || typeof n !== 'object') return;
    if (Array.isArray(n)) { for (const x of n) walk(x); return; }
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (k === TEXT_KEY) { parts.push(String(v ?? '')); continue; }
      if (k === ATTR_KEY || k === '?xml' || k === 'comment') continue;
      if (k === 'br' || k === '软回车') parts.push('\n');
      walk(v);
    }
  };
  walk(node);
  return parts.join('').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n');
}
/** 同名直接子节点列表（保留顺序） */
function childEls(node: unknown, tag: string): OrderedNode[] {
  return childrenOf(node).filter((c) => tagName(c) === tag);
}

export function indexRowsFor(versionId: string, fileId: string, orgId: string, tokens: string) {
  return { versionId, fileId, orgId, tokens };
}
