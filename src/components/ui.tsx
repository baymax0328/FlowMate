// FlowMate · UI 原语（PRD §04：8px 间距、8/12px 圆角、细边线、弱阴影、状态带文字、禁用必须有原因）
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';

/** 只把超长的名称做成滚动揭示，菜单和时间戳保持不动。 */
export function OverflowLabel({ text }: { text: string }) {
  const viewport = useRef<HTMLSpanElement>(null);
  const content = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);
  useEffect(() => {
    const outer = viewport.current, inner = content.current;
    if (!outer || !inner) return;
    const measure = () => setDistance(Math.max(0, inner.scrollWidth - outer.clientWidth));
    const observer = new ResizeObserver(measure);
    observer.observe(outer); observer.observe(inner); measure();
    return () => observer.disconnect();
  }, [text]);
  return <span ref={viewport} title={text} className={`truncate overflow-label${distance > 1 ? ' is-overflowing' : ''}`}
    style={{ '--label-distance': `${-distance}px`, '--label-duration': `${Math.max(4, distance / 28 + 2)}s` } as CSSProperties}>
    <span ref={content} className="overflow-label-text">{text}</span>
  </span>;
}

// ---------- 状态 pill（颜色 + 文字双通道，不只用颜色）----------
export type Tone = 'ok' | 'wait' | 'idle' | 'info' | 'bad' | 'count';
const TONE_WORDS: Record<string, Tone> = {
  // 文件抽取
  pending: 'idle', ready: 'ok', unavailable: 'bad', failed: 'bad',
  // Run
  queued: 'idle', planning: 'info', running: 'info', waiting_input: 'wait', waiting_approval: 'wait',
  blocked: 'wait', recovering: 'wait', succeeded: 'ok', cancelled: 'idle',
  // Proposal
  draft: 'idle', pending_approval: 'wait', suspended: 'wait', ready_to_commit: 'info',
  committing: 'info', committed: 'ok', superseded: 'idle', rejected: 'bad', stale: 'wait',
  // Task
  ready_to_assign: 'idle', pending_accept: 'wait', accepted: 'info', in_progress: 'info',
  pending_transfer: 'wait', pending_review: 'wait', completed: 'ok', overdue: 'bad',
  // Candidate
  needs_clarification: 'wait', confirmed: 'ok', ignored: 'idle', source_changed: 'wait',
  // 会话/成员
  active: 'ok', disabled: 'bad', open: 'wait', resolved: 'ok', dismissed: 'idle',
};
const WORD_CN: Record<string, string> = {
  pending: '抽取中', ready: '已可检索', unavailable: '正文不可检索', failed: '抽取失败',
  queued: '排队中', planning: '规划中', running: '执行中', waiting_input: '等你补充',
  waiting_approval: '待共同确认', blocked: '已受阻', recovering: '恢复中', succeeded: '已成功',
  cancelled: '已取消', draft: '草稿', pending_approval: '待确认', suspended: '已搁置',
  ready_to_commit: '待提交', committing: '提交中', committed: '已写入', superseded: '已失效',
  rejected: '已拒绝', stale: '基准已变', ready_to_assign: '待指派', pending_assignee_id: '待指派', not_started: '未开始',
  pending_accept: '待接收', accepted: '已接收', in_progress: '进行中', pending_transfer: '转派待接收',
  pending_review: '待验收', completed: '已完成', needs_clarification: '待澄清', confirmed: '已确认',
  ignored: '已忽略', source_changed: '原文已变更', active: '有效', disabled: '已停用',
  open: '待处理', resolved: '已解决', dismissed: '已忽略',
};

export function Pill({ status, tone, children, plain }: { status?: string | boolean | null; tone?: Tone; children?: ReactNode; plain?: boolean }) {
  const code = typeof status === 'string' ? status : undefined;
  const t = tone ?? (code ? TONE_WORDS[code] ?? 'idle' : 'idle');
  return <span className={`pill ${t}${plain ? ' plain' : ''}`}>{children ?? (code ? WORD_CN[code] ?? code : status === false ? '否' : status === true ? '是' : '—')}</span>;
}
export const wordOf = (status?: string) => (status ? WORD_CN[status] ?? status : '—');
export const toneOf = (status?: string): Tone => (status ? TONE_WORDS[status] ?? 'idle' : 'idle');

// ---------- 按钮 ----------
export function Btn({ children, variant = 'default', size, disabled, disabledReason, loading, type = 'button', onClick, title, className, ...rest }: {
  children: ReactNode; variant?: 'default' | 'primary' | 'ghost' | 'danger'; size?: 'sm' | 'lg';
  disabled?: boolean; disabledReason?: string; loading?: boolean; type?: 'button' | 'submit';
  onClick?: (e: React.MouseEvent) => void; title?: string; className?: string; style?: React.CSSProperties;
}) {
  const cls = ['btn', variant !== 'default' ? variant : '', size ?? '', disabled && disabledReason ? 'has-reason' : '', className ?? '']
    .filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} disabled={disabled || loading} title={disabled ? disabledReason ?? title : title} onClick={onClick} {...rest}>
      {loading ? <span className="btn-label">处理中…</span> : typeof children === 'string' || typeof children === 'number' ? <span className="btn-label">{children}</span> : children}
    </button>
  );
}

// ---------- 表单 ----------
export function Field({ label, hint, hintTone, error, required, children }: {
  label: ReactNode; hint?: string; hintTone?: 'warn' | 'bad'; error?: string; required?: boolean; children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}{required ? '（必填）' : ''}</span>
      {children}
      {error ? <em className={`hint bad not-italic`}>{error}</em>
        : hint ? <em className={`hint ${hintTone ?? ''}`}>{hint}</em> : null}
    </label>
  );
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange?: (v: boolean) => void; children: ReactNode; disabled?: boolean }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled || !onChange} onChange={(e) => onChange?.(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// ---------- 弹层（焦点约束 + Esc 关闭 + 焦点归还）----------
let overlaySequence=0;
const openOverlays=new Set<number>();
export const isTopOverlay=(layer:number)=>layer===Math.max(0,...openOverlays);
/** 所有弹窗与抽屉共用同一个叠加栈，Esc / Tab 只作用在最上层那一个。 */
export function useOverlayLayer(onClose:()=>void) {
  const [layer]=useState(()=>++overlaySequence);
  const close=useRef(onClose);close.current=onClose;
  useEffect(()=>{
    openOverlays.add(layer);
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&isTopOverlay(layer)){e.preventDefault();e.stopImmediatePropagation();close.current();}};
    document.addEventListener('keydown',key,true);
    return()=>{openOverlays.delete(layer);document.removeEventListener('keydown',key,true);};
  },[layer]);
  return layer;
}
export function Modal({ title, sub, onClose, children, footer, wide }: {
  title: string; sub?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layer=useOverlayLayer(onClose);
  const prev = useRef<HTMLElement | null>(null);
  useEffect(() => {
    prev.current = document.activeElement as HTMLElement;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? [])
      .filter((n) => !n.hasAttribute('disabled'));
    focusables()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (!isTopOverlay(layer)) return;
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev.current?.focus?.(); };
  }, [onClose]);
  return createPortal(
    <div className="modal-mask" style={{zIndex:60+layer*2}} onMouseDown={(e) => { if (e.target === e.currentTarget&&isTopOverlay(layer)) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <div className="grow">
            <div className="modal-title">{title}</div>
            {sub ? <div className="modal-sub">{sub}</div> : null}
          </div>
          <button type="button" className="close-x" onClick={onClose} aria-label="关闭">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        {children != null ? <div className="modal-body">{children}</div> : null}
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Confirm({ title, body, confirmText = '确认', danger, onConfirm, onClose }: {
  title: string; body: ReactNode; confirmText?: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirmText}</Btn>
    </>}>
      {body != null ? <div className="prose">{body}</div> : null}
    </Modal>
  );
}

// ---------- 提示条 / 空态 / 加载 ----------
export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn'; children: ReactNode }) {
  return <div className={`note${tone === 'warn' ? ' warn' : ''}`}>{children}</div>;
}
export function Err({ children, onRetry }: { children: ReactNode; onRetry?: () => void }) {
  return (
    <div className="err">
      <div className="grow">{children}</div>
      {onRetry ? <button className="btn sm" onClick={onRetry}>重试</button> : null}
    </div>
  );
}
export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div>
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {action}
      </div>
    </div>
  );
}
export function Skel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ width: `${72 + (i % 3) * 9}%` }} />)}
    </div>
  );
}

// ---------- Toast（仅用于即时反馈，成功状态一律以服务端真实数据为准）----------
type Toast = { id: number; text: string; bad?: boolean };
const ToastCtx = createContext<(text: string, bad?: boolean) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, bad?: boolean) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, bad }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), bad ? 6500 : 3800);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast${t.bad ? ' bad' : ''}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- 通用小组件 ----------
export function Avatar({ name, me, src }: { name: string; me?: boolean; src?: string }) {
  return <span className={`avatar${me ? ' me' : ''}${src ? ' has-img' : ''}`} aria-hidden="true">
    {src ? <img src={src} alt="" /> : (name || '?').slice(0, 1)}
  </span>;
}
export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}
const EXT_TONE: Record<string, string> = { md: 'MD', docx: 'DOC', pdf: 'PDF', xlsx: 'XLS', csv: 'CSV', pptx: 'PPT', html: 'HTM', txt: 'TXT', png: 'IMG', jpg: 'IMG', jpeg: 'IMG', webp: 'IMG', gif: 'GIF' };
export function FileBadge({ ext }: { ext?: string }) {
  const key = (ext ?? '').replace('.', '').toLowerCase();
  return <span className="file-icon" aria-hidden="true">{EXT_TONE[key] ?? (key.slice(0, 3).toUpperCase() || '·')}</span>;
}
export function Bar({ value }: { value: number }) {
  return <span className="bar" style={{ display: 'block' }}><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span>;
}
/**
 * 列宽拖拽把手：压在列的边界上，按住左右拖即可改这一列宽度，其余区域自适应。
 * edge="right" 给第二列（压在 .side 右边界）；edge="left" 给右侧详情栏（压在 .detail 左边界，往左拖是变宽）。
 * 同时是可聚焦的 role="separator"，方向键 ±16px 调整，键盘用户不必被鼠标锁死。
 */
export function ColResizer({ onResizeStart, onNudge, edge = 'right', label = '拖动调整这一列的宽度' }: {
  onResizeStart: (e: ReactPointerEvent) => void; onNudge?: (dx: number) => void; edge?: 'left' | 'right'; label?: string;
}) {
  return (
    <span
      className={`col-resizer${edge === 'left' ? ' left' : ''}`} role="separator" aria-orientation="vertical" aria-label={label}
      title={`${label}（方向键微调）`} tabIndex={onNudge ? 0 : -1}
      onPointerDown={(e) => onResizeStart(e)}
      onKeyDown={(e) => {
        if (!onNudge) return;
        if (e.key === 'ArrowLeft') { e.preventDefault(); onNudge(-16); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); onNudge(16); }
      }}
    />
  );
}
export function Diff({ text }: { text: string }) {
  return (
    <div className="diff">
      {text.split('\n').map((line, i) => (
        <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : 'ctx'}>{line || ' '}</span>
      ))}
    </div>
  );
}
/** 命中片段渲染（正文/消息检索的高亮定位） */
export function Snippet({ text, hits }: { text: string; hits?: [number, number][] }) {
  if (!hits?.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach(([a, b], i) => {
    if (a > cursor) out.push(text.slice(cursor, a));
    out.push(<mark key={i}>{text.slice(a, Math.max(b, a + 1))}</mark>);
    cursor = Math.max(b, cursor);
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}
/**
 * 复制文本。局域网 HTTP 是「非安全上下文」，navigator.clipboard 直接不存在，
 * `navigator.clipboard?.writeText()` 会静默什么都不做 —— 之前"复制没反应"就是这个原因，
 * 而且还弹了「已复制」的假成功。这里带 execCommand 兜底，并把成败如实返回。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/**
 * 浏览器侧 HTML 净化（Markdown 与 Workspace 预览共用一份，避免两处各写一遍各踩一遍坑）。
 *
 * 这里钉一个很容易复发的坑：dompurify 的默认导出是**工厂函数本身**，
 * `DOMPurify(html, cfg)` 不是净化，而是「以 html 当 root 再造一个实例」，返回的是函数；
 * 再 String() 就是一串源码——压缩后形如 `r=>On(r)`，会被当成正文渲染到页面上。
 * 正确入口是 `.sanitize(html, cfg)`。所以下面既校验函数存在，也校验返回值像 HTML 而不像源码。
 */
export async function sanitizeHtml(html: string): Promise<string> {
  const mod = (await import('dompurify')) as unknown as Record<string, unknown>;
  const dp = (mod.default ?? mod) as { sanitize?: (input: string, config?: unknown) => unknown };
  if (typeof dp.sanitize !== 'function') throw new Error('当前环境没有可用的 DOMPurify（缺 window）');
  const out = dp.sanitize(html, { FORBID: ['script', 'style', 'iframe', 'object', 'embed', 'form'] });
  const text = typeof out === 'string' ? out : '';
  // 一旦拿回来的更像函数源码（`(root) => …` / `function` / `x => …`）而不是 HTML，判失败退回纯文本
  if (!text.trim() || /^\s*(\(|function\b|async\b|[\w$]+\s*=>)/.test(text)) throw new Error('净化结果不是 HTML，拒绝渲染');
  return text;
}

/**
 * Markdown 正文（Agent 回复 / 草稿预览共用），保证「模型输出的可读性」与 Workspace 预览一致。
 * 两点约定：
 * 1. marked + dompurify 懒加载——首屏不背这几十 KB，只有真出现 Markdown 时才拉；
 * 2. 模型输出与用户上传文档一样按不可信输入处理：净化掉脚本 / 样式 / iframe / object / 表单。
 * 解析未完成或失败时原样换行显示，绝不留下空白正文（宁可丑，不能看不见）。
 */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const [html, setHtml] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const src = String(text ?? '');
  useEffect(() => {
    let alive = true;
    if (!src.trim()) { setHtml(''); setState('ready'); return () => { alive = false; }; }
    setState('loading');
    (async () => {
      const m = (await import('marked')) as unknown as Record<string, unknown>;
      const marked = (m.marked ?? m.parse) as { parse?: (s: string) => string | Promise<string> } | ((s: string) => string | Promise<string>);
      const parse = typeof marked === 'function' ? marked : (marked.parse as (s: string) => string | Promise<string>);
      // marked 在 async:true 之类配置下会返回 Promise，统一 await，别把 [object Promise] 渲染出来
      const rendered = String(await Promise.resolve(parse(src)));
      return await sanitizeHtml(rendered);
    })().then((v) => { if (alive) { setHtml(v); setState('ready'); } }).catch(() => { if (alive) setState('failed'); });
    return () => { alive = false; };
  }, [src]);
  if (state !== 'ready') return <div className={`msg-body ${className}`}>{src}</div>;
  return <div className={`prose md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; n?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" className="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}{typeof t.n === 'number' ? <span className="n">{t.n}</span> : null}
        </button>
      ))}
    </div>
  );
}
export function ArchivedEntry({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="archived-entry-btn" aria-haspopup="dialog" onClick={onClick}>
      <span className="archived-entry-icon" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></span>
      <span>{label}</span>
    </button>
  );
}

export function SubTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; n?: number }[] }) {
  return (
    <div className="subtabs" role="tablist">
      {items.map((t) => (
        <button key={t.key} role="tab" className="subtab" aria-selected={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}{typeof t.n === 'number' ? <span className="n">{t.n}</span> : null}
        </button>
      ))}
    </div>
  );
}
/** 下拉浮层（通知、账户菜单、更多操作共用） */
export function Pop({ anchor, onClose, children, align = 'right', width = 320, className = '' }: {
  anchor: React.RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode; align?: 'left' | 'right'; width?: number; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, width, maxHeight: 400 });
  useEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect(); if (!r) return;
      const w = Math.min(width, window.innerWidth - 16);
      const top = Math.max(8, Math.min(r.bottom + 6, window.innerHeight - 88));
      const left = Math.max(8, Math.min(align === 'right' ? r.right - w : r.left, window.innerWidth - w - 8));
      setPos({ top, left, width: w, maxHeight: Math.max(64, window.innerHeight - top - 12) });
    };
    place(); window.addEventListener('resize', place); window.visualViewport?.addEventListener('resize', place);
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); window.removeEventListener('resize', place); window.visualViewport?.removeEventListener('resize', place); };
  }, [anchor, onClose, align, width]);
  return createPortal(
    <div className={`pop ${className}`} ref={ref} style={{ ...pos, overflowY: 'auto', position: 'fixed' }}>{children}</div>,
    document.body,
  );
}
export function PopItem({ children, onClick, current, danger }: { children: ReactNode; onClick: () => void; current?: boolean; danger?: boolean }) {
  return <button className={`pop-item${danger ? ' danger' : ''}`} onClick={onClick} aria-current={current ? 'true' : undefined}>{children}</button>;
}

/**
 * 行内「···」更多操作菜单。用在空间行与会话行上，
 * 目的是把重命名 / 删除 / 选择工作区这类动作从页面右上角收回到「这一行本身」——
 * 右上角那个按钮只对"当前选中项"生效，看的人要先猜"我现在选中的是谁"。
 *
 * 注意：触发器是 <button>，所以宿主行不能再是 <button>（嵌套按钮是非法 HTML，
 * 而且点击会冒泡成"既打开菜单又切换选中"）。调用方的行要用 div[role=button]。
 */
export function RowMenu({ items, label = '更多操作', showWhenDisabled = false }: {
  items: { key: string; label: string; danger?: boolean; disabled?: string | null; onSelect: () => void }[];
  label?: string;
  showWhenDisabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const usable = items.filter((i) => !i.disabled);
  if (!items.length || (!usable.length && !showWhenDisabled)) return null;
  return (
    <>
      <button ref={ref} className="row-menu" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open}
        title={label} onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen((v) => !v); }}>···</button>
      {open ? (
        <Pop anchor={ref} onClose={() => setOpen(false)} width={196} align="right">
          {usable.map((it) => (
            <PopItem key={it.key} danger={it.danger} onClick={() => { setOpen(false); it.onSelect(); }}>{it.label}</PopItem>
          ))}
          {items.filter((i) => i.disabled).map((it) => (
            <div className="pop-item pop-item-off" key={it.key} aria-disabled="true">{it.label}</div>
          ))}
        </Pop>
      ) : null}
    </>
  );
}

/** 单行输入弹窗：重命名一类动作用它，不用 window.prompt（原生弹窗没法带说明与校验，样式也跳戏） */
export function PromptDialog({ title, sub, label, initial, confirmText = '保存', error, requiredMark = false, onClose, onSubmit }: {
  title: string; sub?: string; label: string; initial: string; confirmText?: string; error?: string | null; requiredMark?: boolean;
  onClose: () => void; onSubmit: (value: string) => void | Promise<void>;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(error ?? null);
  const go = async () => {
    const t = v.trim();
    if (!t) { setErr('不能为空'); return; }
    setBusy(true); setErr(null);
    try { await onSubmit(t); } catch (e) { setErr(e instanceof Error ? e.message : '操作失败'); } finally { setBusy(false); }
  };
  return (
    <Modal title={title} sub={sub} onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant="primary" loading={busy} onClick={() => void go()}>{confirmText}</Btn>
    </>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <Field label={requiredMark ? <>{label} <span className="group-required" aria-hidden="true">*</span></> : label} required={!requiredMark}>
          <input type="text" required value={v} onChange={(e) => setV(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} />
        </Field>
        {requiredMark ? <div className="group-required-note"><span className="group-required">*</span>为必填项</div> : null}
      </div>
    </Modal>
  );
}

/** 两个标签都保持可见，整块控件作为一个开关响应点击。 */
export function SlideToggle({ left, right, checked, onChange, label, disabled = false }: {
  left: string; right: string; checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean;
}) {
  return (
    <button type="button" className="slide-toggle" role="switch" aria-checked={checked}
      aria-label={label} disabled={disabled} title={`当前：${checked ? right : left}；点击切换为${checked ? left : right}`}
      onClick={() => onChange(!checked)}>
      <span className="slide-toggle-thumb" aria-hidden="true" />
      <span className={`slide-toggle-label${!checked ? ' selected' : ''}`}>{left}</span>
      <span className={`slide-toggle-label${checked ? ' selected' : ''}`}>{right}</span>
    </button>
  );
}

export function MessageActionIcon({name}:{name:'reply'|'copy'|'save'|'task'|'edit'|'undo'|'quote'}) {
 if (name === 'quote') return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M7 8h4v4l-3 3H6l3-3H7V8Zm7 0h4v4l-3 3h-2l3-3h-2V8Z" fill="currentColor" stroke="none"/></svg>;
 const paths={reply:'M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-5 3v-3a4 4 0 0 1-3-4V8a4 4 0 0 1 4-4ZM8 11h8M8 14h5',copy:'M9 9h11v12H9zM5 15H3V3h11v2',save:'M4 3h13l3 3v15H4zM8 3v6h8V3M8 21v-8h8v8',task:'M8 4h12v17H4V8M3 4h6M6 1v6M8 12h8m-8 4h6',edit:'m4 16 12-12 4 4L8 20H4zM14 6l4 4',undo:'M4 10h10a6 6 0 0 1 0 12M4 10l6-6M4 10l6 6',quote:'M10 6c-4 0-6 3-6 7v4h6v-6H5M20 6c-4 0-6 3-6 7v4h6v-6h-5'};
 return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]}/></svg>;
}
