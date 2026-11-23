import { IllustratedEmpty } from '../../components/IllustratedEmpty';
import { activeMention, insertMention } from './mentions';
import officeWelcomeArt from '../../assets/office-welcome.svg';
import shareEmptyArt from '../../assets/empty-share.svg';
// FlowMate · Agent 会话共用界面（PRD §09 / §10 / §11 / §16）
// 三栏：会话导航 · 共同工作区（消息 + 请求卡 / 执行卡 / 共同确认卡）· 文件与执行（当前目录、本次读取、草稿与提案）
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, arrOf, errMsg, fmtRel, fmtSize, idem, jsonOf, useM, useQ, useSubscription, usePersistentState, type ColHandle, type Json, type PaneWidth } from '../../api/hooks';
import { ArchivedEntry, OverflowLabel, MessageActionIcon, copyText, SlideToggle, Avatar, Bar, Btn, Check, ColResizer, Diff, Empty, Err, Field, FileBadge, Markdown, Modal, Note, Pill, PromptDialog, RowMenu, Skel, SubTabs, useToast, wordOf } from '../../components/ui';
import { useSession } from '../../app/session';
import { avatarSource } from '../../app/avatar-options';

const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));

/**
 * 两种模式的边界（与后端 planner 对齐：界面说的必须就是系统做的）：
 * · 对话模式 answer —— 只问答：不列工作区文件、不读正文、不写任何文件
 *   （后端 answerOnlyPlan 刻意把 read_paths / search_queries 留空）。
 * · 工作模式 draft —— 读工作区文件并依据内容回答（回答会标注出自哪个文件），不改任何文件。
 *   改动能力保留给显式的执行类请求（如消息页「交给 Agent」），不由问答触发。
 * 默认按文本自动判：提到文件/文档、或要整理产出 → 工作模式；否则对话模式。
 */
export function resolvedKind(text: string, hasWorkspace: boolean): 'answer' | 'draft' {
  const t = String(text ?? '').trim();
  if (!hasWorkspace) return 'answer';   // 没有工作区就没有可读的东西，直接走轻量问答
  if (/(文件里|文件中的|文档里|文档中的|资料里|根据文件|按文件|这份文档|那个文档|工作区里|整理成|写成|生成一份|输出一版|草稿|总结这份|拟一版|列一版)/.test(t)) return 'draft';
  if (/[?？]\s*$/.test(t) || /(什么是|是什么|为什么|为何|怎么|怎样|如何|解释|对比|有哪些|能不能|可不可以|是不是|什么意思|区别)/.test(t)) return 'answer';
  return 'answer';
}

export type SessionDto = {
  id: string; mode: string; title: string; owner_id?: string; team_id?: string | null;
  my_role?: string; binding?: { folder_id: string | null; root_name: string | null; path?: string | null; include_children: boolean } | null;
  participants?: Json[]; capabilities?: Record<string, string>; active_work?: { runs: Json[]; proposals: Json[] } | null;
  last_active_at?: string; read_only?: boolean; expires_at?: string | null; share_id?: string | null;
  /** 共享状态：列表与详情都返回，头部「共享中」徽标与按钮文案靠它 */
  sharing?: boolean; shared_count?: number;
};

// ---------- 会话列表（左栏）----------
// 会话列表的一行：标题 + 状态徽标 + 相对时间 + 「···」行内菜单
// 注意宿主行是 div[role=button] 而不是 <button>：菜单触发器本身是按钮，
// 按钮套按钮是非法 HTML，而且点击会冒泡成「既打开菜单又切换选中」。
function SessionRow({ r, activeId, onSelect, onIntent, onRenamed, onDeleted, mode, onFork }: {
  r: Json; activeId: string; onSelect: (id: string) => void;
  onIntent: (kind: 'workspace' | 'branch', id: string) => void;
  onRenamed: () => void; onDeleted: (r: Json) => void; mode: 'personal' | 'team';
  onFork?: (id:string) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [forking, setForking] = useState(false);
  const id = S(r.id);
  const canManage = S(r.my_role) === 'coordinator';
  return (
    <>
      <div className="row-item session-nav-row" role="button" tabIndex={0} aria-current={id === activeId}
        onClick={() => onSelect(id)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } }}>
        <div className="row-title">
          <OverflowLabel text={S(r.title, '未命名会话')} />
          {r.read_only ? <Pill plain status>只读</Pill> : null}
          {!r.read_only && Number(r.shared_count ?? 0) > 0 ? <Pill tone="ok">共享中</Pill> : null}
          <span className="session-row-time">{fmtRel(S(r.last_active_at ?? r.created_at))}</span>
          <span className="session-row-menu" onClick={(e) => e.stopPropagation()}>
            <RowMenu label={`「${S(r.title, '未命名会话')}」的操作`} items={[
              { key: 'copy', label: '复制会话 ID', disabled: null, onSelect: () => { void (async () => { const done = await copyText(id); toast(done ? '会话 ID 已复制（它不是凭证）' : '当前环境不允许复制（请用浏览器菜单），未伪装成功', done ? undefined : true); })(); } },
              { key: 'rename', label: '重命名', disabled: canManage ? null : '只有协调者可改名', onSelect: () => setRenaming(true) },
              { key: 'ws', label: '选择工作区', disabled: canManage ? null : '只读身份不能改工作区', onSelect: () => onIntent('workspace', id) },
              { key: 'branch', label: '新建团队分支', disabled: mode === 'personal' && !r.read_only ? null : '仅个人会话可新建团队分支', onSelect: () => onIntent('branch', id) },
              ...(r.read_only && mode === 'personal' ? [{key:'personal-branch',label:forking?'正在创建分支…':'新建会话分支',disabled:forking?'正在创建':null,onSelect:async()=>{
                setForking(true);
                try { const branch=await api.post<SessionDto>(`/agent/sessions/${id}/personal-branch`,{},{idemKey:idem('personal-branch')}); onFork?.(branch.id); toast('已保存到个人会话「最近」'); }
                catch(e){toast(errMsg(e),true);} finally{setForking(false);}
              }}] : []),
              { key: 'del', label: '删除会话', danger: true, disabled: canManage ? null : '只有协调者可删除', onSelect: () => onDeleted(r) },
            ].sort((a, b) => Number(!!a.disabled) - Number(!!b.disabled))} />
          </span>
        </div>
      </div>
      {renaming ? (
        <PromptDialog title="重命名会话" label="会话标题" requiredMark initial={S(r.title, '未命名会话')} confirmText="保存"
          onClose={() => setRenaming(false)}
          onSubmit={async (v) => { await api.patch(`/agent/sessions/${id}`, { title: v }); setRenaming(false); qc.invalidateQueries({ queryKey: ['sessions'] }); qc.invalidateQueries({ queryKey: ['session', id] }); onRenamed(); }} />
      ) : null}
    </>
  );
}

/** 按工作区把会话分组：同一个工作区下的会话收在一起，点组标题展开/收起 */
function SessionGroups({ rows, activeId, onSelect, onIntent, onChanged, onDeleted, mode, recent=false, onFork }: {
  rows: Json[]; activeId: string; onSelect: (id: string) => void;
  onIntent: (kind: 'workspace' | 'branch', id: string) => void; onChanged: () => void;
  onDeleted: (r: Json) => void; mode: 'personal' | 'team';
  recent?: boolean; onFork?: (id:string)=>void;
}) {
  const [closed, setClosed] = usePersistentState<Record<string, boolean>>(`office.${mode}.closed-groups`, {});
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; items: Json[] }>();
    if (recent) byKey.set('__none__',{key:'__none__',label:'最近',items:[]});
    for (const r of rows) {
      const key = S(r.binding?.folder_id, '') || '__none__';
      if (!byKey.has(key)) byKey.set(key, { key, label: S(r.binding?.root_name, '未指定工作区'), items: [] });
      byKey.get(key)!.items.push(r);
    }
    // 未指定工作区的组排最后，正常按最近活跃排序
    return [...byKey.values()].sort((a, b) => (a.key === '__none__' ? 1 : b.key === '__none__' ? -1 : b.items.length - a.items.length));
  }, [rows,recent]);
  return (
    <>
      {groups.map((g) => (
        <div className="session-nav-group" key={g.key}>
          <button className={recent && g.key==='__none__' ? 'archived-entry-btn session-recent-heading' : 'row-item group'} aria-expanded={!closed[g.key]} onClick={() => setClosed((p) => ({ ...p, [g.key]: !p[g.key] }))}>
            <div className="row-title">
              {recent && g.key==='__none__' ? <span className="archived-entry-icon" aria-hidden="true"><svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></span> :
              <svg className="session-folder-icon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {closed[g.key] ? <path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7h18" /> : <><path d="M3 17V5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v3" /><path d="M3 20h16l3-10H6z" /></>}
              </svg>}
              <span className="session-group-name" title={g.label}>{g.label}</span>
            </div>
          </button>
          {!closed[g.key] ? g.items.map((r) => (
            <SessionRow key={S(r.id)} r={r} activeId={activeId} onSelect={onSelect} onIntent={onIntent}
              onRenamed={onChanged} onDeleted={onDeleted} mode={mode} onFork={onFork} />
          )) : null}
        </div>
      ))}
    </>
  );
}

/** 已删除的会话：删除是归档，必须给回来的入口（与文档页回收站同一约定） */
function ArchivedDialog({ mode, onClose, onRestored }: { mode: 'personal' | 'team'; onClose: () => void; onRestored: () => void }) {
  const toast = useToast();
  const list = useQ<Json[]>(['sessions', 'archived', mode], '/agent/sessions/archived', { mode });
  const rows = arrOf<Json>(list.data);
  return (
    <Modal title="已删除的会话" onClose={onClose} wide
      footer={<Btn onClick={onClose}>关闭</Btn>}>
      <div className="stack">
        {list.isLoading ? <Skel rows={3} /> : null}
        {!list.isLoading && !rows.length ? <IllustratedEmpty kind="trash" title="暂无已删除的会话" /> : null}
        {rows.map((r) => (
          <div className="row-meta" key={S(r.id)}>
            <span className="grow truncate">{S(r.title, '未命名会话')}</span>
            <span className="muted small">{S(r.binding?.root_name, '未指定工作区')}</span>
            <span className="muted">{fmtRel(S(r.archived_at))}</span>
            <Btn size="sm" onClick={async () => {
              try {
                const res = await api.post<Json>(`/agent/sessions/${S(r.id)}/restore`, {});
                toast(S(res.note, '已恢复'));
                onRestored(); list.refetch();
              } catch (e) { toast(errMsg(e), true); }
            }}>恢复</Btn>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function SessionList({ mode, activeId, onSelect, pane, onIntent }: {
  mode: 'personal' | 'team'; activeId: string; onSelect: (id: string) => void; pane?: PaneWidth;
  onIntent: (kind: 'workspace' | 'branch', id: string) => void;
}) {
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [savedTab, setTab] = usePersistentState<'mine' | 'shared'>(`office.${mode}.list-tab`, 'mine');
  const tab = mode === 'team' ? 'mine' : savedTab;
  const [q, setQ] = useState('');
  const [byId, setById] = useState('');
  const [openingById,setOpeningById]=useState(false);
  const [openedById,setOpenedById]=useState<SessionDto|null>(null);
  const {orgId,me}=useSession();
  useEffect(()=>{setOpenedById(null);setById('');},[orgId,me?.user.id]);
  const [newOpen, setNewOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const list = useQ<Json[]>(['sessions', mode], '/agent/sessions', { mode }, { refetchMs: 20000 });
  const shared = useQ<Json[]>(['sessions', 'shared'], '/agent/sessions/shared-with-me', undefined, { enabled: mode === 'personal', refetchMs:15000 });
  const sharedRows=arrOf<Json>(shared.data);
  const visibleSharedRows=[...(openedById&&!sharedRows.some(r=>r.id===openedById.id)?[openedById]:[]),...sharedRows];
  const rows = tab === 'shared' ? visibleSharedRows : arrOf<Json>(list.data);
  const filtered = q ? rows.filter((r) => `${S(r.title)} ${S(r.binding?.root_name)}`.toLowerCase().includes(q.toLowerCase())) : rows;

  const openSharedById=async()=>{
    if(openingById||!byId.trim())return;
    setOpeningById(true);
    try {
      const id=byId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]??byId.trim();
      const r=await api.get<SessionDto>('/agent/sessions/open-by-id',{session_id:id});
      qc.setQueryData(['session','personal',r.id],r);
      await qc.invalidateQueries({queryKey:['session',r.id]});
      if(r.my_role==='share_viewer')setOpenedById(r);
      setQ('');onSelect(r.id);toast('会话已打开');
    } catch(e){toast(errMsg(e),true);}finally{setOpeningById(false);}
  };

  const askDelete = (r: Json) => {
    if (!window.confirm(`删除会话「${S(r.title, '未命名会话')}」？会话会进入「已删除的会话」，消息与执行记录都保留，可以恢复。`)) return;
    void api.del(`/agent/sessions/${S(r.id)}`).then(() => {
      toast('会话已删除（可在「已删除的会话」恢复）');
      qc.invalidateQueries({ queryKey: ['sessions'] });
      if (S(r.id) === activeId) onSelect('');
    }).catch((e) => toast(errMsg(e), true));
  };

  return (
    <aside className="side">
      {pane ? <ColResizer onResizeStart={pane.onResizeStart} onNudge={pane.nudge} label="拖动调整会话列表宽度" /> : null}
      <div className="side-head">
        <div className="searchbox grow"><input type="search" value={q} placeholder="搜索会话或工作区" aria-label="搜索会话" onChange={(e) => setQ(e.target.value)} /></div>
        <Btn size="sm" variant="primary" onClick={() => setNewOpen(true)}>新建</Btn>
      </div>
      {mode === 'personal' ? (
        <SubTabs value={tab} onChange={setTab} items={[{ key: 'mine', label: '个人会话', n: arrOf<Json>(list.data).length }, { key: 'shared', label: '共享会话', n: visibleSharedRows.length }]} />
      ) : (
        <SubTabs value={'mine' as 'mine' | 'shared'} onChange={() => undefined} items={[{ key: 'mine', label: '团队会话', n: arrOf<Json>(list.data).length }]} />
      )}
      <div className="side-body">
        {tab === 'shared' ? (
          <>
            {!filtered.length ? <div className="muted small" style={{ padding: 8 }}>暂无共享对话</div> : null}
            <div className="shared-session-flat-list">{filtered.map(r=><SessionRow key={S(r.id)} r={r} activeId={activeId} onSelect={onSelect} onIntent={onIntent}
              onRenamed={()=>{qc.invalidateQueries({queryKey:['sessions']});}} onDeleted={askDelete} mode={mode}
              onFork={id=>{setTab('mine');qc.invalidateQueries({queryKey:['sessions']});onSelect(id);}} />)}</div>
            {/* 「按 ID 打开」属于共享会话这一类：对方把会话 ID 发给你，你在这里取回内容 */}
            <div className="pop-title">按会话 ID 打开</div>
            <form className="stack" style={{ padding: '0 8px' }} onSubmit={e=>{e.preventDefault();void openSharedById();}}>
              <input type="text" value={byId} onChange={(e) => setById(e.target.value)} placeholder="粘贴对方给你的会话 ID" aria-label="会话 ID" />
              <Btn type="submit" size="sm" variant="primary" loading={openingById} disabled={!byId.trim()||openingById} disabledReason="先粘贴会话 ID">打开</Btn>
              
            </form>
          </>
        ) : (
          <>
            {list.isLoading && tab === 'mine' ? <Skel rows={4} /> : null}
            {!filtered.length && mode === 'personal' && !list.isLoading ? (
              <Empty title="还没有个人会话" body="选一个工作区后即可读写其中的文件；不选工作区只能问答。"
                action={<Btn variant="primary" onClick={() => setNewOpen(true)}>新建会话</Btn>} />
            ) : null}
            <SessionGroups rows={filtered} activeId={activeId} onSelect={onSelect} onIntent={onIntent}
              onChanged={() => { qc.invalidateQueries({ queryKey: ['sessions'] }); }} onDeleted={askDelete} mode={mode} recent={mode==='personal'} />
          </>
        )}
        <ArchivedEntry label="已删除的会话" onClick={() => setArchivedOpen(true)} />
      </div>
      {newOpen ? (
        <NewSessionDialog mode={mode} onClose={() => setNewOpen(false)} onCreated={(id) => {
          setNewOpen(false); qc.invalidateQueries({ queryKey: ['sessions'] }); onSelect(String(id)); nav(`/agent/${mode}?s=${id}`);
        }} />
      ) : null}
      {archivedOpen ? (
        <ArchivedDialog mode={mode} onClose={() => setArchivedOpen(false)}
          onRestored={() => { qc.invalidateQueries({ queryKey: ['sessions', mode] }); }} />
      ) : null}
    </aside>
  );
}

// ---------- 会话主体 ----------
/** 右栏的一个页签：Agent 会话的「文件与执行」与 Team 的「团队与提案」共用同一块右栏空间 */
export type DetailTab = { key: string; label: string; node: ReactNode };

export function SessionView({ session, onRefresh, detailOpen = false, onToggleDetail, detailResize, intent, onIntentDone, extraTabs = [] }: {
  session: SessionDto; onRefresh: () => void;
  /** 收起状态由页面持有：页面要用它决定栅格是不是三栏（收起后中间区横扩到右边缘） */
  detailOpen?: boolean; onToggleDetail?: (v: boolean) => void;
  /** 右栏左边界可拖宽（页面算宽度，把手渲染在这里） */
  detailResize?: ColHandle;
  /** 会话行「···」里点的「选择工作区 / 新建团队分支」：由页面转过来，弹窗仍在这里（它需要当前会话上下文） */
  intent?: '' | 'workspace' | 'branch'; onIntentDone?: () => void;
  extraTabs?: DetailTab[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useSession();
  const myAvatar = avatarSource(jsonOf<Json>((me?.user as unknown as Json)?.prefs ?? {}, {}).avatar);
  const [sp, setSp] = useSearchParams();
  const [seq, setSeq] = useState(0);
  const [draft, setDraft] = useState('');
  const [quote,setQuote]=useState<Json|null>(null);
  const [caret,setCaret]=useState(0);
  const [mentionIndex,setMentionIndex]=useState(0);
  const composeRef=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{setQuote(null);},[session.id]);
  /** 默认工作模式，支持问答及工作区文件读取。 */
  const [output, setOutput] = usePersistentState<'answer' | 'draft'>(`office.${session.mode}.output`,'draft');
  const [aux, setAux] = useState<{ id: string; name: string; url: string }[]>([]);
  const [busy, setBusy] = useState(false);
  /** 轻量问答在途时先把这句显出来，不等后端往返（后端落库后 refresh 会接上同一条） */
  const [pending, setPending] = useState<string | null>(null);
  const [clarify, setClarify] = useState<{ request_id: string; question: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [tab, setTab] = usePersistentState(`office.${session.mode}.detail-tab`,'work');
  const [diffView, setDiffView] = useState<{ title: string; patch: string; mode?: 'diff' | 'md' } | null>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const readOnly = !!session.read_only || session.my_role==='share_viewer' || session.my_role==='viewer';
  const canWrite = !readOnly && session.my_role !== 'viewer';
  const sharing = !!session.sharing || Number(session.shared_count ?? 0) > 0;
  useSubscription('session', session.id);

  // 行内菜单转过来的意图：打开对应弹窗，随即清掉，避免下次切会话又自动弹一次
  useEffect(() => {
    if (!intent) return;
    if (intent === 'workspace') setPickerOpen(true);
    if (intent === 'branch') setBranchOpen(true);
    onIntentDone?.();
  }, [intent, onIntentDone]);

  const msgs = useQ<Json[]>(['session', session.id, 'messages'], `/agent/sessions/${session.id}/messages`, undefined, { refetchMs: 12000 });
  const runs = useQ<Json[]>(['session', session.id, 'runs'], `/agent/sessions/${session.id}/runs`, undefined, { refetchMs: 5000 });
  const artifacts = useQ<Json[]>(['session', session.id, 'artifacts'], `/agent/sessions/${session.id}/artifacts`, undefined, { refetchMs: 10000 });
  const manifest = useQ<Json>(['session', session.id, 'read'], `/agent/sessions/${session.id}/read-manifest`, undefined, { refetchMs: 15000 });

  // 查询键必须是 ['session', id, …] 这种嵌套形状：WebSocket 事件按 ['session'] 前缀失效缓存，
  // 原来的 ['session-messages', …] 首元素就不等于 'session'，前缀匹配不上——
  // 表现是「发给 Agent 之后回复永远不出现」，只能刷新整页。
  const runList = arrOf<Json>(runs.data);
  const active = runList.some((r) => ['queued', 'planning', 'running', 'recovering', 'waiting_input'].includes(S(r.status)));
  const working = active || busy;

  const messages = arrOf<Json>(msgs.data);
  const lastCount = useRef(0);

  // 有进行中的执行时把消息流问到 2 秒一次（WS 断了也能看到回复），空闲后回到 12 秒
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { void qc.invalidateQueries({ queryKey: ['session', session.id] }); }, 2000);
    return () => clearInterval(t);
  }, [active, qc, session.id]);

  useEffect(() => {
    const n = messages.length;
    if (n > lastCount.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    lastCount.current = n;
  }, [messages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { lastCount.current = 0; setSeq(0); setTab('work'); }, [session.id]);

  const merged = useMemo(
    () => [...messages].sort((a, b) => Number(a.seq ?? 0) - Number(b.seq ?? 0)),
    [msgs.data], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const workspacePath = S(session.binding?.path || session.binding?.root_name, '未指定工作区').replaceAll('/', ' / ');
  /** /sessions/:id/read-manifest 返回 { session_id, file_count, entries }，正文在 entries 里 */
  const readEntries = arrOf<Json>(manifest.data, 'entries');

  // 右栏只有一个：Team 页把「团队与提案」作为额外页签插进来，不再并排第二个 aside
  const tabs = useMemo(() => [{ key: 'work', label: '文件与执行' }, ...extraTabs.map((t) => ({ key: t.key, label: t.label }))],
    [extraTabs]);

  async function refresh() { setSeq(0); qc.invalidateQueries({ queryKey: ['session'] }); onRefresh(); }

  const mentionPeople=(session.participants??[]).filter(p=>S(p.user_id??p.id)!==S(me?.user.id));
  const mentionRange=session.mode==='team'?activeMention(draft,caret):null;
  const mentionCandidates=!mentionRange?[]:mentionPeople.filter(p=>S(p.display_name??p.name).toLowerCase().includes(mentionRange.query.toLowerCase())).slice(0,6);
  const pickMention=(p:Json)=>{if(!mentionRange)return;const next=insertMention(draft,mentionRange.start,mentionRange.end,S(p.display_name??p.name));setDraft(next.text);setCaret(next.caret);setMentionIndex(0);requestAnimationFrame(()=>{composeRef.current?.focus();composeRef.current?.setSelectionRange(next.caret,next.caret);});};
  async function send() {
    const typed = draft.trim();
    if (!typed) return;
    const body=typed;
    const mentioned=session.mode==='team'?mentionPeople.filter(p=>{const token='@'+S(p.display_name??p.name);return typed.includes(token+' ')||typed.includes(token+'\n')||typed.endsWith(token);}):[];
    if(mentioned.length){
      if(aux.length){toast('发给成员的消息暂不支持图片，请移除图片后发送',true);return;}
      setBusy(true);
      try {await api.post(`/agent/sessions/${session.id}/messages`,{body,parent_id:quote?.id,mentions:mentioned.map(p=>S(p.user_id??p.id))},{idemKey:idem('member-message')});setDraft('');setQuote(null);refresh();}catch(e){toast(errMsg(e),true);}finally{setBusy(false);}return;
    }
    const kind: 'answer' | 'draft' = output;
    // 对话模式且没挂辅助图片 → 走轻量直连（不进队列、不产生 Run，一次调用就出回答）。
    // 挂了图片必须回落到 /requests：直连路不读附件，静默丢掉用户的图是不可接受的。
    if (kind === 'answer' && !aux.length) {
      setBusy(true); setPending(body); setDraft('');
      try {
        const r = await api.post<Json>(`/agent/sessions/${session.id}/chat`, { body,parent_id:quote?.id }, { idemKey: idem('chat') });
        // 注意别写 S(r.truncated)：String(false) === 'false' 是非空字符串，会把每条正常回答都误报成截断
        setQuote(null);
        if (r.truncated === true) toast('模型输出被长度上限截断了，可以再问得具体一点', true);
        refresh();
      } catch (e) { setDraft(typed); toast(errMsg(e), true); } finally { setBusy(false); setPending(null); }
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<Json>(`/agent/sessions/${session.id}/requests`, {
        goal: body, source_message_ids:quote?[S(quote.id)]:[], aux_ids: aux.map((a) => a.id), output_kind: kind,
        // 工作模式 = 对话外观 + 能读能干：不产出请求卡，结果按普通回答气泡回来
        chat_mode: kind === 'draft',
        idempotency_key: idem('req'),
      });
      setDraft(''); setAux([]); setQuote(null);
      const clar = S((r as Json).request?.clarification ?? (r as Json).clarification);
      if (clar) setClarify({ request_id: S((r as Json).request?.id ?? (r as Json).request_id), question: clar });
      toast(kind === 'answer' ? '已发送给 Agent，等待回答' : '工作模式：正在读取工作区并处理');
      refresh();
    } catch (e) { toast(errMsg(e), true); } finally { setBusy(false); }
  }

  async function uploadImg(files: FileList | null) {
    if (!files?.length) return;
    const form = new FormData();
    form.append('file', files[0]);
    try {
      const r = await api.upload<Json>(`/agent/sessions/${session.id}/auxiliary-uploads`, form, idem('aux'));
      setAux((p) => [...p, { id: S(r.id ?? r.aux_id), name: S(r.name, '图片'), url: S(r.url ?? r.download_url) }]);
    } catch (e) { toast(errMsg(e), true); }
  }

  return (
    <>
      <section className="work office-work">
        <div className="card-head" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', margin: 0, flexWrap: 'wrap' }}>
          <div className="grow cluster">
            <span className="card-title">{S(session.title, '未命名会话')}</span>
            {session.my_role ? <Pill plain status>{({ coordinator: '协调者', participant: '参与者', viewer: '仅查看', share_viewer: '共享只读' } as Record<string, string>)[session.my_role] ?? session.my_role}</Pill> : null}
            {readOnly ? <Pill tone="wait">只读受邀者：不能发送或触发执行</Pill> : null}
            <span className="muted small">工作区：{session.binding?.path
              ? `${session.binding.path}${session.binding.include_children ? '' : '（仅本层）'}`
              : session.binding?.root_name
                ? `${session.binding.root_name}${session.binding.include_children ? '' : '（仅本层）'}`
                : '未指定工作区（只能问答）'}</span>
            <span className="muted small office-session-id">会话 ID <span className="mono">{session.id.slice(0, 8)}</span>
              <button className="session-id-copy" title="复制完整会话 ID" aria-label="复制完整会话 ID" onClick={async () => {
                const done = await copyText(session.id);
                toast(done ? '会话 ID 已复制' : '当前环境不允许复制（请用浏览器菜单），未伪装成功', done ? undefined : true);
              }}><MessageActionIcon name="copy"/></button></span>
          </div>
          {/* 选择工作区 / 新建团队分支 / 重命名 / 复制 ID / 删除都收进了会话行的「···」里；
              头部只留「共享」——它是这个会话当前的对外状态，需要一直看得见。 */}
          {session.mode === 'personal' && !session.read_only
            ? <Btn size="sm" variant={sharing ? 'primary' : 'default'} className={sharing ? 'sharing-on' : ''}
                onClick={() => setShareOpen(true)}
                title={sharing ? '已有成员能看到这个会话的实时更新' : '把这个会话共享给同事'}>{sharing ? '共享中' : '共享'}</Btn>
            : null}
          {/* 以前这里只调 setSp({s: id})：等于把当前页 URL 的 s 又写了一遍，
              而对话中心也不读这个参数，所以按钮看着「按了没反应」。改成真跳并带会话过滤。 */}
          {session.mode === 'team'
            ? <Btn size="sm" onClick={() => { window.location.href = `/agent/center?session=${encodeURIComponent(session.id)}`; }}>进入对话中心</Btn>
            : null}
          <Btn size="sm" variant="ghost" onClick={() => onToggleDetail?.(!detailOpen)}>{detailOpen ? '收起右栏' : '展开右栏'}</Btn>
        </div>

        <div className="grow office-stream" ref={scrollRef}>
          {msgs.isLoading ? <Skel rows={4} /> : null}
          {msgs.isError ? <Err onRetry={() => msgs.refetch()}>{errMsg(msgs.error)}</Err> : null}
          {!merged.length && !pending && !working && !msgs.isLoading && !msgs.isError ? (
            <div className="office-welcome">
              <img className="office-welcome-art" src={officeWelcomeArt} alt="" />
              <h2>你好，我能帮你做点什么吗？</h2>
              <p><span><strong>对话模式</strong>支持问答，</span><span><strong>工作模式</strong>支持文档读写</span></p>
            </div>
          ) : null}
          <div className="stack">
            {merged.map((m) => <StreamItem key={S(m.id ?? m.seq)} m={m} meId={me?.user.id ?? ''} sessionId={session.id} readOnly={readOnly} team={session.mode === 'team'} onQuote={message=>{setQuote(message);composeRef.current?.focus();}} folderId={!readOnly ? S(session.binding?.folder_id) : ''}
              avatar={S(m.sender_user_id) === me?.user.id ? myAvatar : m.sender_user_id ? avatarSource(m.sender_avatar) : undefined}
              onResolved={refresh} onDiff={(t, p, mode) => setDiffView({ title: t, patch: p, mode })} />)}
            {pending ? (
              <div className="msg office-message from-me">
                <Avatar name={S(me?.user.display_name, '我')} me src={myAvatar} />
                <div className="grow">
                  <div className="msg-head"><b>{S(me?.user.display_name, '我')}</b><span>刚刚</span></div>
                  <div className="msg-body">{pending}</div>
                </div>
              </div>
            ) : null}
            {working ? (
              <div className="msg office-message">
                <Avatar name="A" />
                <div className="grow">
                  <div className="msg-head"><b>FlowMate Agent</b></div>
                  <div className="typing" style={{ marginTop: 4 }}><i /><i /><i />
                    <span>{runList.some((r) => S(r.status) === 'running' || S(r.status) === 'planning') ? '正在处理这条请求，右栏「运行与排队」可看进度' : '已排队，等待执行槽'}</span>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {clarify ? (
          <div style={{ padding: '0 16px 8px' }}>
            <Note tone="warn">Agent 需要先确认：{clarify.question}
              <div className="cluster" style={{ marginTop: 8 }}>
                <input type="text" id="clarify-answer" placeholder="补充说明后继续" style={{ flex: 1 }} />
                <Btn size="sm" variant="primary" onClick={async () => {
                  const el = document.getElementById('clarify-answer') as HTMLInputElement | null;
                  if (!el?.value.trim()) { toast('请填写补充说明', true); return; }
                  try { await api.post(`/requests/${clarify.request_id}/answer`, { answer: el.value.trim() }); setClarify(null); refresh(); }
                  catch (e) { toast(errMsg(e), true); }
                }}>提交补充</Btn>
              </div>
            </Note>
          </div>
        ) : null}

        <div className="composer">
          {aux.length ? (
            <div className="msg-refs" style={{ marginBottom: 6 }}>
              {aux.map((a) => <span key={a.id} className="ref-card"><span className="kind">辅助图片</span>{a.name}
                <button className="msg-tool" onClick={() => setAux((p) => p.filter((x) => x.id !== a.id))}>移除</button>
                <button className="msg-tool" onClick={async () => {
                  try { await api.post(`/agent/sessions/${session.id}/auxiliary-uploads/${a.id}/save-to-workspace`, { folder_id: S(session.binding?.folder_id) }); toast('已保存到工作区'); }
                  catch (e) { toast(errMsg(e), true); }
                }}>保存到工作区</button></span>)}
            </div>
          ) : null}
          {quote?<div className="msg-quote cluster office-reply-preview"><span className="grow truncate">引用 {S(quote.sender_name??quote.sender_label,'Agent')}：{S(quote.body)}</span><button className="msg-tool" onClick={()=>setQuote(null)}>取消引用</button></div>:null}<div className="office-compose-box">{mentionCandidates.length?<div className="office-mention-picker" role="listbox" aria-label="提及会话成员">{mentionCandidates.map((p,i)=><button role="option" aria-selected={i===mentionIndex%mentionCandidates.length} key={S(p.user_id??p.id)} onMouseDown={e=>e.preventDefault()} onClick={()=>pickMention(p)}><Avatar name={S(p.display_name??p.name)}/>{S(p.display_name??p.name)}</button>)}</div>:null}<textarea ref={composeRef} value={draft} disabled={readOnly} aria-label="给 Agent 的请求"
            onChange={e=>{setDraft(e.target.value);setCaret(e.target.selectionStart);setMentionIndex(0);}}
            onSelect={e=>setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if(e.nativeEvent.isComposing)return;
              if(mentionCandidates.length){if(e.key==='ArrowDown'){e.preventDefault();setMentionIndex(i=>(i+1)%mentionCandidates.length);return;}if(e.key==='ArrowUp'){e.preventDefault();setMentionIndex(i=>(i+mentionCandidates.length-1)%mentionCandidates.length);return;}if(e.key==='Escape'){e.preventDefault();setCaret(0);return;}if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();pickMention(mentionCandidates[mentionIndex%mentionCandidates.length]);return;}}
              if (e.key !== 'Enter' || !canWrite) return;
              if (e.shiftKey) return;                       // Shift+Enter = 换行
              e.preventDefault(); void send();              // Enter / Ctrl+Enter 都发送
            }} />
          <div className="cluster office-compose-tools">{session.mode==='team'?<button type="button" className="compose-mention" aria-label="提及成员" title="提及成员，发送后不会触发 Agent" disabled={readOnly} onClick={()=>{const pos=composeRef.current?.selectionStart??draft.length;setDraft(d=>d.slice(0,pos)+'@'+d.slice(pos));setCaret(pos+1);requestAnimationFrame(()=>{composeRef.current?.focus();composeRef.current?.setSelectionRange(pos+1,pos+1);});}}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="12" r="4"/><path d="M15 8v7c0 3 6 2 6-3a9 9 0 1 0-4 7"/></svg></button>:null}
            {/* 交互模式：对话 / 工作 两档滑块，默认对话 */}
            <button type="button" className="compose-add-image" disabled={readOnly} aria-label="添加图片" title="添加图片" onClick={() => imgRef.current?.click()}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg></button>
            <SlideToggle left="对话模式" right="工作模式" checked={output === 'draft'} onChange={(work) => setOutput(work ? 'draft' : 'answer')} label="交互模式" disabled={readOnly} />
            
            <input ref={imgRef} type="file" accept="image/*" hidden onChange={(e) => void uploadImg(e.target.files)} />
            <span className="right" />
            {working ? <Pill tone="info">Agent 处理中…</Pill> : null}
            {runList.some((r) => ['running', 'queued', 'planning', 'waiting_input'].includes(S(r.status))) ? (
              <Btn size="sm" variant="danger" onClick={async () => {
                const cur = runList.find((r) => ['running', 'queued', 'planning'].includes(S(r.status)));
                if (!cur) return;
                try { await api.post(`/runs/${S(cur.id)}/cancel`, { reason: '本人在会话内停止' }); toast('已请求停止'); refresh(); } catch (e) { toast(errMsg(e), true); }
              }}>停止</Btn>
            ) : null}
            <Btn variant="primary" loading={busy} disabled={!canWrite || (!draft.trim() && !aux.length)}
              disabledReason={readOnly ? '只读受邀者不能发起请求' : '先写下目标'} onClick={() => void send()}>{session.mode==='team'&&mentionPeople.some(p=>draft.includes('@'+S(p.display_name??p.name)))?'发送给成员':'交给 Agent'}</Btn>
          </div></div>
        </div>
      </section>

      {detailOpen ? (
        <aside className="detail">
          {detailResize ? <ColResizer edge="left" onResizeStart={detailResize.onResizeStart} onNudge={detailResize.nudge} label="拖动调整右栏宽度" /> : null}
          <div className="detail-head">
            {tabs.length > 1
              ? <SubTabs value={tab} onChange={setTab} items={tabs} />
              : <b className="grow">{tabs[0]?.label ?? '文件与执行'}</b>}
            <Btn size="sm" variant="ghost" onClick={() => onToggleDetail?.(false)}>收起</Btn>
          </div>
          {/* 「文件与执行」与「团队与提案」抢同一块右栏空间：合并成一个面板两个页签，
              收起后中间区横扩到右边缘（栅格由页面按 detailOpen 切 detail-closed） */}
          <div className={`detail-body${tab === 'work' ? ' stack office-file-execution' : ''}`}>
            {tab !== 'work' ? (extraTabs.find((t) => t.key === tab)?.node ?? null) : <>
            <div>
              <div className="side-title">当前工作区</div>
              <div className="muted small truncate" title={workspacePath}>{workspacePath}</div>
            </div>
            <div className="row-sep" />
            <div>
              <div className="side-title">读取文件</div>
              {readEntries.length ? readEntries.map((r) => (
                <div className="row-meta" key={S(r.version_id ?? r.file_version_id)}>
                  <span className="grow truncate">{S(r.name)}</span><Pill plain status>v{S(r.version_no)}</Pill>
                  <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/workspace?focus=${S(r.file_id)}`; }}>查看</Btn>
                </div>
              )) : <div className="muted small">暂无读取记录</div>}
            </div>
            <div className="row-sep" />
            <div>
              <div className="side-title">运行与排队</div>
              {runList.length ? runList.slice(0, 12).map((r) => (
                <div className="exec" key={S(r.id)} style={{ marginBottom: 6, padding: '8px 10px' }}
                  {...({ className: `exec ${['waiting_approval', 'blocked', 'waiting_input'].includes(S(r.status)) ? 'wait' : S(r.status) === 'failed' ? 'bad' : S(r.status) === 'succeeded' ? '' : 'idle'}` } as object)}>
                  <div className="exec-head"><Pill status={S(r.status)} />{r.planner === 'deterministic' ? <Pill plain tone="idle">本地规划器</Pill> : null}<span className="truncate">{S(r.subtask_name)}</span></div>
                  {r.queue_reason ? <div className="exec-meta">排队原因：{S(r.queue_reason)}</div> : null}
                  {S(r.status) === 'failed' || S(r.status) === 'cancelled' ? (
                    <div className="cluster" style={{ marginTop: 4 }}>
                      <Btn size="sm" onClick={async () => { try { await api.post(`/runs/${S(r.id)}/retry`); refresh(); } catch (e) { toast(errMsg(e), true); } }}>重试</Btn>
                      <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/agent/center?run=${S(r.id)}`; }}>明细</Btn>
                    </div>
                  ) : null}
                </div>
              )) : <div className="muted small">暂无运行中的任务</div>}
            </div>
            <div className="row-sep" />
            <div>
              <div className="side-title">产物</div>
              {arrOf<Json>(artifacts.data).length ? arrOf<Json>(artifacts.data).map((a) => (
                <div className="row-meta" key={S(a.id)}>
                  <FileBadge ext="md" /><span className="grow truncate">{S(a.name)}</span><Pill status={S(a.status)} />
                  <Btn size="sm" variant="ghost" onClick={async () => {
                    try { const r = await api.get<{ content: string }>(`/agent/artifacts/${S(a.id)}/content`); setDiffView({ title: S(a.name), patch: r.content, mode: 'md' }); }
                    catch (e) { toast(errMsg(e), true); }
                  }}>预览</Btn>
                </div>
              )) : <div className="muted small">暂无产物</div>}
            </div>
            </>}
          </div>
        </aside>
      ) : null}

      {pickerOpen ? <WorkspacePicker session={session} onClose={() => setPickerOpen(false)} onDone={() => { setPickerOpen(false); refresh(); }} /> : null}
      {/* 共享状态一变就重拉会话详情：头部那颗「共享中」得立刻跟上，不能等下一次 15 秒轮询 */}
      {shareOpen ? <ShareSession session={session} onClose={() => setShareOpen(false)} onChanged={() => { qc.invalidateQueries({ queryKey: ['session', session.id] }); qc.invalidateQueries({ queryKey: ['sessions'] }); }} /> : null}
      {branchOpen ? <CreateBranch session={session} onClose={() => setBranchOpen(false)} onDone={(id) => { setBranchOpen(false); toast('团队分支已创建'); nav2(id); }} /> : null}
      {diffView ? (
        <Modal title={diffView.title} onClose={() => setDiffView(null)} wide footer={<Btn onClick={() => setDiffView(null)}>关闭</Btn>}>
          {diffView.mode === 'md' ? <Markdown text={diffView.patch} /> : <Diff text={diffView.patch} />}
        </Modal>
      ) : null}
    </>
  );
}

function nav2(id: string) { window.location.href = `/agent/team?s=${id}`; }

// ---------- 会话流条目（请求卡 / 执行卡 / 共同确认卡 / 成果）----------
function StreamItem({ m, meId, sessionId, readOnly, onResolved, onDiff, team, onQuote, folderId, avatar }: {
  m: Json; meId: string; sessionId: string; readOnly: boolean; team?: boolean; onQuote: (message:Json)=>void; folderId?:string; avatar?: string; onResolved: () => void; onDiff: (title: string, patch: string, mode?: 'diff' | 'md') => void;
}) {
  const kind = S(m.kind, 'message');
  const mine = S(m.sender_user_id) === meId;
  if (kind === 'request_card') return <RequestCard m={m} mine={mine} />;
  if (kind === 'plan') return <PlanCard m={m} />;
  if (kind === 'execution_card') return <ExecCard m={m} />;
  if (kind === 'approval_card') return <ApprovalCard m={m} readOnly={readOnly} onResolved={onResolved} onDiff={onDiff} />;
  if (kind === 'artifact') return <ArtifactCard m={m} onDiff={onDiff} />;
  if (kind === 'clarification') return <div style={{ paddingLeft: 46 }}><Note tone="warn"><Markdown text={S(m.body)} className="md-inline" /></Note></div>;
  if (kind === 'share_notice' || kind === 'event') return <div className="center small muted">{S(m.body)}</div>;
  return (
    <div id={`session-msg-${S(m.id)}`} className={`msg office-message ${mine ? 'from-me' : 'from-agent'} ${m.role==='agent'?'agent-answer':''}`} >
      <Avatar name={S(m.sender_name ?? m.sender_label, 'A')} me={mine} src={avatar} />
      <div className="grow">
        <div className="msg-head"><b>{S(m.sender_name ?? m.sender_label, 'Agent')}</b><span>{fmtRel(S(m.created_at))}</span>{m.role === 'agent' ? <Pill plain tone="info">Agent</Pill> : null}{team && m.role === 'agent' && m.reply_to_user?.name ? <span className="agent-reply-recipient">回复 @{S(m.reply_to_user.name)}</span> : null}</div>
        {/* Agent 正文按 Markdown 渲染（与 Workspace 预览同一套 .prose 观感 + 同一份净化规则）；
            成员自己发的消息仍按纯文本，避免把「@ 某人」这类输入误当成语法 */}
        {m.parent ? <div className="msg-quote office-message-quote">{m.parent.parent_unavailable?<span>原消息不可用</span>:<><span>引用 {S(m.parent.sender_name,'Agent')}：{S(m.parent.body).slice(0,160)}</span><button className="msg-tool" onClick={()=>document.getElementById(`session-msg-${S(m.parent.id)}`)?.scrollIntoView({behavior:'smooth',block:'center'})}>跳到原消息</button></>}</div> : null}
        {m.role === 'agent'
          ? <Markdown text={S(m.body)} className="msg-body" />
          : <div className="msg-body">{S(m.body)}</div>}
        {m.role==='agent'?<AgentReplyActions body={S(m.body)} onQuote={()=>onQuote(m)} folderId={folderId}/>:null}
      </div>
    </div>
  );
}

function RequestCard({ m, mine }: { m: Json; mine: boolean }) {
  const aux = (m.aux ?? {}) as Json;
  return (
    <div className="exec idle">
      <div className="exec-head">
        <Pill plain status>请求卡</Pill>
        <span>{S(aux.creator_name, mine ? '我' : '成员')} 发起</span>
        {aux.planner === 'deterministic' ? <Pill plain tone="idle">本地规划器 · 未调用模型</Pill> : aux.planner === 'model' ? <Pill plain tone="info">模型规划</Pill> : null}
        <span className="right">{fmtRel(S(m.created_at))}</span>
      </div>
      <div className="exec-title">{S(aux.goal ?? m.body)}</div>
      <div className="exec-meta cluster">
        <span>拟输出：{({ draft: '独立草稿', formal_change: '正式文件变更（需确认）', answer: '对话回答' } as Record<string, string>)[S(aux.output_kind)] ?? S(aux.output_kind, '草稿')}</span>
        <span>写入范围：{arrOf<Json>(aux.write_scope).length ? arrOf<Json>(aux.write_scope).map((w) => S(w.file_id ? '正式文件' : w.path, '')).filter(Boolean).join('、') : '仅草稿'}</span>
        <Pill tone={aux.risk === 'high' ? 'bad' : aux.risk === 'medium' ? 'wait' : 'ok'}>{({ low: '低风险', medium: '中风险', high: '高风险' } as Record<string, string>)[S(aux.risk)] ?? '低风险'}</Pill>
        <Pill plain status>{S(aux.stage, '已规划')}</Pill>
      </div>
    </div>
  );
}

function PlanCard({ m }: { m: Json }) {
  const aux = (m.aux ?? {}) as Json;
  const subtasks = arrOf<Json>(aux.subtasks ?? aux.plan);
  return (
    <div className="exec">
      <div className="exec-head"><Pill plain status>执行计划</Pill><span>{subtasks.length} 个子任务 · {S(aux.planner) === 'deterministic' ? '本地规划器' : '模型'}</span></div>
      <ul className="exec-steps">
        {subtasks.map((s, i) => (
          <li key={i}><code>{S(s.exec ?? s.kind, 'step')}</code><span className="grow">{S(s.name)}</span>
            {arrOf<string>(s.depends_on).length ? <span className="muted">依赖 {arrOf<string>(s.depends_on).join('、')}</span> : null}
            {s.parallel_reason ? <span className="muted">{S(s.parallel_reason)}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExecCard({ m }: { m: Json }) {
  const aux = (m.aux ?? {}) as Json;
  return (
    <div className={`exec ${S(aux.status) === 'failed' ? 'bad' : ['waiting_approval', 'blocked'].includes(S(aux.status)) ? 'wait' : ''}`}>
      <div className="exec-head"><Pill status={S(aux.status, 'running')} />{S(aux.subtask_name ?? m.body)}<span className="right">第 {S(aux.attempt ?? 1)} 次尝试</span></div>
      {arrOf<Json>(aux.steps).length ? (
        <ul className="exec-steps">{arrOf<Json>(aux.steps).map((s, i) => (
          <li key={i}><code>{S(s.tool_name)}</code><span className="grow">{S(s.args_digest ? JSON.stringify(s.args_digest) : '')}</span>
            <Pill plain tone={S(s.status) === 'success' ? 'ok' : 'bad'}>{S(s.status) === 'success' ? '成功' : S(s.error_code ?? '失败')}</Pill></li>
        ))}</ul>
      ) : null}
      <div className="exec-meta">读取 {arrOf<string>(aux.read_version_ids).length} 个文件版本 · 产出 {S(aux.output_bytes, '0')} 字节</div>
    </div>
  );
}

function ArtifactCard({ m, onDiff }: { m: Json; onDiff: (t: string, p: string, mode?: 'diff' | 'md') => void }) {
  const aux = (m.aux ?? {}) as Json;
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const artifactId = S(aux.artifact_id ?? (m.ref_type === 'artifact' ? m.ref_id : ''));
  const preview = async () => {
    setLoading(true);
    try {
      const result = artifactId ? await api.get<{ content: string }>(`/agent/artifacts/${artifactId}/content`) : { content: S(aux.preview) };
      if (!result.content?.trim()) { toast('该成果暂无可预览内容', true); return; }
      onDiff(S(aux.name, '成果'), result.content, 'md');
    } catch (e) { toast(errMsg(e), true); }
    finally { setLoading(false); }
  };
  return (
    <div className="exec">
      <div className="exec-head"><Pill plain status>成果</Pill>{S(aux.name ?? m.body)}<Pill status={S(aux.status, 'draft')} /></div>
      <div className="exec-body small">{S(aux.summary, aux.status === 'committed' ? '成果已保存到工作区' : '成果已生成，点击预览查看内容')}</div>
      <div className="cluster" style={{ marginTop: 6 }}>
        <Btn size="sm" disabled={loading} onClick={preview}>{loading ? '加载中…' : '预览'}</Btn>
        {artifactId ? <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/agent/center?artifact=${artifactId}`; }}>在对话中心查看</Btn> : null}
      </div>
    </div>
  );
}

function ApprovalCard({ m, readOnly, onResolved, onDiff }: { m: Json; readOnly: boolean; onResolved: () => void; onDiff: (t: string, p: string) => void }) {
  const toast = useToast();
  const aux = (m.aux ?? {}) as Json;
  const id = S(aux.proposal_id ?? m.ref_id);
  const p = useQ<Json>(['proposal', id], `/proposals/${id}`, undefined, { refetchMs: 12000, enabled: !!id });
  const d = (p.data ?? aux) as Json;
  const count = Number(d.approval_count ?? 0);
  const need = Number(d.needed_count ?? arrOf<string>(d.required_approvers).length ?? 1);
  const status = S(d.status, 'pending_approval');
  const me = useSession().me?.user.id ?? '';
  const required = arrOf<string>(d.required_approvers);
  const outstanding = arrOf<string>(d.outstanding_user_ids).length ? arrOf<string>(d.outstanding_user_ids) : required.filter((r) => !arrOf<Json>(d.approvals).filter((a) => S(a.decision) === 'approve').some((a) => S(a.user_id) === r));
  const decide = async (decision: string, reason?: string) => {
    try {
      await api.post(`/proposals/${id}/${decision === 'approve' ? 'approve' : decision === 'reject' ? 'reject' : 'request-changes'}`, { reason, diff_hash: S(d.diff_hash) });
      toast(decision === 'approve' ? `已同意（${count + 1}/${need}）` : decision === 'reject' ? '已拒绝，旧确认全部失效' : '已请求修改，需重新生成差异');
      onResolved(); p.refetch();
    } catch (e) { toast(errMsg(e), true); p.refetch(); }
  };
  return (
    <div className="exec wait">
      <div className="exec-head">
        <Pill status={status} />
        <b>共同确认 · {S(d.target_name)}</b>
        <span className="right">确认 {count}/{need}</span>
      </div>
      <div className="exec-body small">{S(d.summary, '本次变更将写入正式文件，需所有相关指令人确认。')}</div>
      <div className="exec-meta">
        基准 v{S(d.base_version_no ?? '')} · 提案版本 r{S(d.revision, '1')} · 相关指令人 {required.length} 人
        {outstanding.length ? <div>待表态：{outstanding.map((u) => S((d.approver_names as Record<string, string>)?.[u] ?? u.slice(0, 6))).join('、')}</div> : null}
        {d.next_reminder_at ? <div>提醒节奏：下次 {fmtRel(S(d.next_reminder_at)).slice(0, 0) || '按 1 小时 / 每 24 小时'} · 超过 72 小时未集齐将自动搁置（不视为同意）</div> : null}
      </div>
      <ul className="exec-steps">
        {arrOf<Json>(d.approvals).map((a, i) => (
          <li key={i}><code>{({ approve: '同意', reject: '拒绝', request_changes: '请求修改' } as Record<string, string>)[S(a.decision)] ?? S(a.decision)}</code>
            <span className="grow">{S(a.user_name ?? S(a.user_id).slice(0, 6))}</span>
            <span className="muted">r{S(a.revision)} · {fmtRel(S(a.created_at))}</span>
            {a.active === 0 || a.active === false ? <Pill plain tone="bad">已失效</Pill> : null}</li>
        ))}
      </ul>
      <div className="cluster" style={{ marginTop: 8 }}>
        <Btn size="sm" onClick={() => void api.get<string>(`/proposals/${id}/diff`).then((t) => onDiff(`差异 · ${S(d.target_name)}`, typeof t === 'string' ? t : S((t as Json).patch)))}>查看差异</Btn>
        <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/agent/center?proposal=${id}`; }}>对话中心</Btn>
        <span className="right" />
        {status === 'suspended' ? <Btn size="sm" disabled={readOnly} onClick={() => void decide('approve')}>表态即唤醒</Btn> : null}
        <Btn size="sm" disabled={readOnly || !required.includes(me)} disabledReason={readOnly ? '只读受邀者不能表态' : '你不是本次变更的相关指令人'} variant="primary" onClick={() => void decide('approve')}>同意</Btn>
        <Btn size="sm" disabled={readOnly || !required.includes(me)} disabledReason={readOnly ? '只读受邀者不能表态' : '你不是本次变更的相关指令人'} onClick={() => { const reason = window.prompt('请写出要修改的地方（会让旧确认失效）') ?? ''; if (reason) void decide('request_changes', reason); }}>提出修改</Btn>
        <Btn size="sm" variant="danger" disabled={readOnly || !required.includes(me)} disabledReason="只有相关指令人能拒绝" onClick={() => { const reason = window.prompt('拒绝原因（必填）') ?? ''; if (reason) void decide('reject', reason); }}>拒绝</Btn>
      </div>
      <div className="hint">协调者不能代签，也没有强制通过入口；文件在你我全部同意前一个字节都不会变。</div>
    </div>
  );
}

/**
 * 工作区选择树：像本地文件浏览器一样，逐层展开子文件夹，点任意一层就把它设为工作区。
 * 之前只能选几个空间根、子层要靠「进入 / 选中」两个按钮来回跳，选不到自己新建的子文件夹。
 * 交互约定：点名字＝选中该层；点 ▸＝展开或收起；选中项右侧打勾，顶部实时显示完整路径。
 */
function FolderNode({ id, name, path, depth, value, onPick }: {
  id: string; name: string; path: string; depth: number; value: string | null; onPick: (id: string, path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);
  const kids = useQ<{ folders: Json[] }>(['folder-tree', id], `/folders/${id}/children`, undefined, { enabled: open });
  const rows = arrOf<Json>(kids.data?.folders);
  const selected = value === id;
  return (
    <div>
      <div className={`tree-row${selected ? ' on' : ''}`} style={{ paddingLeft: 6 + depth * 14 }}>
        <button className="tree-caret" aria-label={open ? '收起' : '展开'} aria-expanded={open}
          onClick={() => setOpen((v) => !v)}>{open ? '▾' : '▸'}</button>
        <button className="tree-name" onClick={() => onPick(id, path)} title={path}>{name}</button>

      </div>
      {open ? (
        <>
          {kids.isLoading ? <div className="tree-hint" style={{ paddingLeft: 24 + depth * 14 }}>读取中…</div> : null}
          {!kids.isLoading && !rows.length ? <div className="tree-hint" style={{ paddingLeft: 24 + depth * 14 }}>（没有子文件夹）</div> : null}
          {rows.map((f) => (
            <FolderNode key={S(f.id)} id={S(f.id)} name={S(f.name)} path={`${path}/${S(f.name)}`}
              depth={depth + 1} value={value} onPick={onPick} />
          ))}
        </>
      ) : null}
    </div>
  );
}

/** 树的外壳：顶部路径条 + 各空间根作为顶层节点 */
function FolderTree({ roots, value, onChange }: {
  roots: { id: string; name: string }[]; value: string | null; onChange: (id: string | null, path: string | null) => void;
}) {
  const [path, setPath] = useState<string | null>(null);
  const pick = (id: string, p: string) => { setPath(p); onChange(id, p); };
  return (
    <div className="tree">
      <div className="tree-path">
        <span className="muted small">工作区地址</span>
        <b className="grow truncate" title={path ?? undefined}>{path ?? '未选择'}</b>
        {value ? <Btn size="sm" variant="ghost" onClick={() => { setPath(null); onChange(null, null); }}>清除</Btn> : null}
      </div>
      <div className="tree-body">
        {!roots.length ? <div className="tree-hint">没有可选空间</div> : null}
        {roots.map((r) => <FolderNode key={r.id} id={r.id} name={r.name} path={r.name} depth={0} value={value} onPick={pick} />)}
      </div>
    </div>
  );
}

// ---------- 选择工作区 ----------
function WorkspacePicker({ session, onClose, onDone }: { session: SessionDto; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const spaces = useQ<Json[]>(['spaces'], '/spaces');
  const [folderId, setFolderId] = useState<string | null>(session.binding?.folder_id ?? null);
  const [include, setInclude] = useState(!!session.binding?.include_children);
  const kids = useQ<{ folders: Json[] }>(['folders', folderId ?? 'root'], folderId ? `/folders/${folderId}/children` : '/folders/children');
  const busy = useM(async () => {
    const active = arrOf<Json>(session.active_work?.runs).filter((r) => ['queued', 'running', 'planning', 'waiting_input', 'waiting_approval', 'blocked'].includes(S(r.status)));
    await api.put(`/agent/sessions/${session.id}/binding`, { folder_id: folderId, include_children: include, acknowledge_context_visibility: true });
    return active.length;
  }, ['sessions', 'session']);

  return (
    <Modal title="选择工作区" onClose={onClose}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" loading={busy.isPending} onClick={async () => {
          try {
            const n = await busy.mutateAsync();
            toast(n ? `已切换；${n} 个运行需先处理` : (folderId ? '已选择工作区' : '已取消工作区，会话变成只能问答'));
            onDone();
          } catch (e) { toast(errMsg(e), true); }
        }}>确认选择</Btn>
      </>}>
      <div className="stack">
        <Note>有运行中的任务时不能直接换工作区</Note>
        <FolderTree
          roots={arrOf<Json>(spaces.data)
            // 过滤掉「最近 / 回收站」视图项与本会话不该碰的团队 / 组织根
            .filter((s) => s.id && (session.mode === 'personal' ? s.space === 'personal' : s.space === 'team' || s.space === 'org'))
            .map((s) => ({ id: S(s.id), name: S(s.name) }))}
          value={folderId} onChange={(id) => setFolderId(id)} />
        <Check checked={include} onChange={setInclude}>包含子工作区</Check>
        <div className="hint">当前：{S(session.binding?.path ?? session.binding?.root_name, '未指定工作区')}</div>
      </div>
    </Modal>
  );
}

// ---------- 共享个人会话：ID 访问与定向邀请 ----------
function ShareSession({ session, onClose, onChanged }: { session: SessionDto; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const { me } = useSession();
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const shares = useQ<Json[]>(['shares', session.id], `/agent/sessions/${session.id}/shares`);
  const policy = useQ<Json>(['session-sharing',session.id],`/agent/sessions/${session.id}/link-sharing`);
  const [range,setRange] = useState<'all'|'from_now'>('all');
  const [exp,setExp] = useState('forever');
  const [search,setSearch] = useState('');
  const [busy,setBusy] = useState(false);
  const [over,setOver] = useState(false);
  const [dragging,setDragging] = useState('');
  const [removeOver,setRemoveOver]=useState(false);
  const [draggedShare,setDraggedShare]=useState('');
  const initialized=useRef(false);
  useEffect(()=>{
    if (!policy.data || initialized.current) return;
    initialized.current=true;
    if(policy.data.range_type)setRange(policy.data.range_type==='from_now'?'from_now':'all');
    if(policy.data.expires_at && S(policy.data.expires_at).slice(0,4)!=='9999'){
      const days=Math.max(1,Math.ceil((new Date(S(policy.data.expires_at)).getTime()-Date.now())/86400000));
      setExp(days<=1?'1':days<=7?'7':'30');
    }
  },[policy.data]);
  const enabled=!!policy.data?.enabled;
  const active=arrOf<Json>(shares.data).filter(s=>!s.revoked_at && new Date(S(s.expires_at)).getTime()>Date.now());
  const sharedIds=new Set(active.map(s=>S(s.grantee_user_id)));
  const people=arrOf<Json>(members.data).filter(m=>S(m.user_id??m.id)!==me?.user.id&&!m.disabled);
  const candidates=people.filter(m=>!sharedIds.has(S(m.user_id??m.id)) && `${S(m.display_name)} ${S(m.email)} ${teamName(m)}`.toLowerCase().includes(search.toLowerCase()));
  function teamName(m:Json){return arrOf<Json>(m.teams).map(t=>S(t.name??t.team_name)).filter(Boolean).join(' / ') || S(m.team_name,'组织成员');}
  function memberAvatar(m:Json){return avatarSource(m.avatar??jsonOf<Json>(m.prefs,{}).avatar);}
  const refresh=()=>{void shares.refetch();void policy.refetch();onChanged();};
  const savePolicy=async(next:boolean)=>{
    setBusy(true);
    try{await api.put(`/agent/sessions/${session.id}/link-sharing`,{enabled:next,range_type:range,forever:exp==='forever',days:exp==='forever'?undefined:Number(exp)});refresh();toast(next?'共享已开启':'共享已关闭');}
    catch(e){toast(errMsg(e),true);}finally{setBusy(false);}
  };
  const grant=async(id:string)=>{
    if(busy || !enabled || !people.some(m=>S(m.user_id??m.id)===id) || sharedIds.has(id))return;
    setBusy(true);setDragging('');setOver(false);
    try{await api.post(`/agent/sessions/${session.id}/shares`,{grantee_user_ids:[id],range_type:range,live:true,forever:exp==='forever',days:exp==='forever'?undefined:Number(exp)},{idemKey:idem('share-member')});refresh();toast('已共享给该成员');}
    catch(e){toast(errMsg(e),true);}finally{setBusy(false);}
  };
  const revoke=async(id:string)=>{
    if(busy)return;
    setBusy(true);setDraggedShare('');setRemoveOver(false);
    try{await api.post(`/agent/sessions/${session.id}/shares/${id}/revoke`,{});refresh();toast('已移除该成员');}
    catch(e){toast(errMsg(e),true);}finally{setBusy(false);}
  };
  return <Modal title="共享会话" onClose={onClose} wide footer={<Btn onClick={onClose}>完成</Btn>}>
    <div className="office-share-panel">
      <div className="office-share-controls">
        <Field label="历史范围"><select aria-label="历史范围" value={range} disabled={busy||enabled} onChange={e=>setRange(e.target.value as 'all'|'from_now')}><option value="all">全部历史记录</option><option value="from_now">最新记录开始</option></select></Field>
        <Field label="有效期"><select aria-label="共享有效期" value={exp} disabled={busy||enabled} onChange={e=>setExp(e.target.value)}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="forever">永久</option></select></Field>
        <Btn variant={enabled?'default':'primary'} disabled={busy||policy.isLoading||policy.isError} onClick={()=>void savePolicy(!enabled)}>{enabled?'关闭共享':'开启共享'}</Btn>
      </div>
      {policy.isError?<Err>{errMsg(policy.error)}</Err>:null}
      <div className="office-share-id"><span className={`office-share-status ${enabled?'enabled':''}`}>{enabled?'共享已开启':'共享未开启'}</span><span className="grow truncate">会话 ID：{session.id}</span><Btn size="sm" variant="ghost" onClick={async()=>{const ok=await copyText(session.id);toast(ok?'会话 ID 已复制':'复制失败，请手动复制',!ok);}}>复制 ID</Btn></div>
      <div className="office-share-columns">
        <section className={`office-share-people office-share-candidates ${removeOver?'remove-over':''}`}
          onDragOver={e=>{if(draggedShare&&!busy){e.preventDefault();e.dataTransfer.dropEffect='move';setRemoveOver(true);}}}
          onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setRemoveOver(false);}}
          onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData('application/x-flowmate-share');if(active.some(s=>S(s.id)===id))void revoke(id);}}><h3>选择共享对象 <span>{candidates.length}</span></h3>
          <div className="searchbox"><input type="search" aria-label="搜索共享对象" placeholder="搜索成员姓名或团队" value={search} onChange={e=>setSearch(e.target.value)}/></div>
          <div className="office-share-member-list">{members.isLoading?<Skel rows={3}/>:null}{members.isError?<Err>{errMsg(members.error)}</Err>:null}{!members.isLoading&&!candidates.length?<div className="office-share-empty">暂无匹配成员</div>:null}
          {candidates.map(m=>{const id=S(m.user_id??m.id);return <div key={id} className={`office-share-member ${dragging===id?'dragging':''}`} draggable={enabled&&!busy} onDragStart={e=>{e.dataTransfer.setData('application/x-flowmate-member',id);e.dataTransfer.effectAllowed='copy';setDragging(id);}} onDragEnd={()=>{setDragging('');setOver(false);}}>
            <Avatar name={S(m.display_name)} src={memberAvatar(m)}/><div className="office-share-person"><b>{S(m.display_name)}</b><span>{teamName(m)}</span></div><Btn size="sm" variant="primary" disabled={!enabled||busy} onClick={()=>void grant(id)}>共享</Btn>
          </div>;})}</div>
        </section>
        <section className={`office-share-people office-share-drop ${over?'drag-over':''}`} onDragOver={e=>{if(enabled&&dragging){e.preventDefault();e.dataTransfer.dropEffect='copy';setOver(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOver(false);}} onDrop={e=>{e.preventDefault();void grant(e.dataTransfer.getData('application/x-flowmate-member'));}}>
          <h3>已共享成员 <span>{active.length}</span></h3>
          <div className="office-share-member-list">{shares.isLoading?<Skel rows={3}/>:null}{shares.isError?<Err>{errMsg(shares.error)}</Err>:null}{!shares.isLoading&&!active.length?<div className="office-share-empty"><img className="office-share-empty-art" src={shareEmptyArt} alt="" aria-hidden="true"/><b>{enabled?'拖动成员到这里':'开启共享后添加成员'}</b><span>也可以点击成员右侧的「共享」</span></div>:null}
          {active.map(s=>{const m=people.find(p=>S(p.user_id??p.id)===S(s.grantee_user_id))??s;return <div className={`office-share-member ${draggedShare===S(s.id)?'dragging':''}`} key={S(s.id)} draggable={!busy}
            onDragStart={e=>{e.dataTransfer.setData('application/x-flowmate-share',S(s.id));e.dataTransfer.effectAllowed='move';setDragging('');setDraggedShare(S(s.id));}}
            onDragEnd={()=>{setDraggedShare('');setRemoveOver(false);}}><Avatar name={S(m.display_name??s.grantee_name)} src={memberAvatar(m)}/><div className="office-share-person"><b>{S(m.display_name??s.grantee_name)}</b><span>{teamName(m)}</span></div><Btn size="sm" variant="danger" disabled={busy} onClick={()=>void revoke(S(s.id))}>移除</Btn></div>;})}</div>
        </section>
      </div>
    </div>
  </Modal>;
}

// ---------- 创建 Team 分支（§10 三步）----------
function CreateBranch({ session, onClose, onDone }: { session: SessionDto; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const teams = useQ<Json[]>(['teams'], '/teams');
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const [step, setStep] = useState(1);
  const [teamId, setTeamId] = useState('');
  const [title, setTitle] = useState(S(session.title, '团队会话'));
  const [folderId, setFolderId] = useState('');
  const [scope, setScope] = useState<'all' | 'until' | 'selected' | 'summary'>('all');
  const [summary, setSummary] = useState('');
  const [picks, setPicks] = useState<string[]>([]);
  const [copyFiles, setCopyFiles] = useState(false);
  const [blocked, setBlocked] = useState<Json | null>(null);
  const spaces = useQ<Json[]>(['spaces'], '/spaces');
  const kids = useQ<{ folders: Json[]; files: Json[] }>(['folders', folderId || 'root'], folderId ? `/folders/${folderId}/children` : '/folders/children', undefined, { enabled: step >= 1 });
  const readiness = useQ<Json>(['readiness', session.id, teamId, folderId], `/agent/sessions/${session.id}/readiness`, { team_id: teamId, folder_id: folderId }, { enabled: !!teamId && !!folderId });

  return (
    <Modal title="新建团队分支" onClose={onClose} wide
      footer={<>
        {(step === 1 || step === 2) ? <span className="group-required-note" style={{ marginRight: 'auto' }}><span className="group-required">*</span>为必填项</span> : null}
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        {step > 1 ? <Btn onClick={() => setStep(step - 1)}>上一步</Btn> : null}
        {step < 3 ? <Btn variant="primary" disabled={!teamId || (step === 2 && !folderId)} disabledReason={step === 1 ? '先选团队' : '先选目标工作区'} onClick={() => setStep(step + 1)}>下一步</Btn>
          : <Btn variant="primary" onClick={async () => {
            try {
              const r = await api.post<Json>(`/agent/sessions/${session.id}/branch`, {
                team_id: teamId, folder_id: folderId, title, history_scope: scope,
                range_payload: { summary }, aux_image_ids: arrOf<string>((readiness.data as Json)?.aux_image_ids),
                participant_ids: picks, copy_source_files: copyFiles, idempotency_key: idem('br'),
              });
              if ((r as Json).blocked) { setBlocked(r as Json); toast('目标工作区或图片缺权，需显式复制或授权', true); return; }
              onDone(S((r as Json).id));
            } catch (e) { setBlocked({ message: errMsg(e) }); toast(errMsg(e), true); }
          }}>确认创建</Btn>}
      </>}>
      <div className="stack">
        <div className="cluster">{[1, 2, 3].map((i) => <Pill key={i} plain tone={step >= i ? 'ok' : 'idle'}>{i === 1 ? '1 选择团队' : i === 2 ? '2 预览上下文' : '3 确认创建'}</Pill>)}</div>
        {step === 1 ? <>
          <Field label={<>团队 <span className="group-required" aria-hidden="true">*</span></>}><select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">请选择</option>{arrOf<Json>(teams.data).map((t) => <option key={S(t.id)} value={S(t.id)}>{S(t.name)}</option>)}</select></Field>
          <Field label="Team 会话标题"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="参与人"><div className="stack" style={{ maxHeight: 180, overflow: 'auto' }}>
            {arrOf<Json>(members.data).map((m) => <Check key={S(m.user_id ?? m.id)} checked={picks.includes(S(m.user_id ?? m.id))}
              onChange={(v) => setPicks((p) => (v ? [...p, S(m.user_id ?? m.id)] : p.filter((x) => x !== S(m.user_id ?? m.id))))}>{S(m.display_name)} · {S(m.title)}</Check>)}
          </div></Field>
        </> : null}
        {step === 2 ? <>
          <Field label={<>目标工作区 <span className="group-required" aria-hidden="true">*</span></>}>
            <div className="cluster">{arrOf<Json>(spaces.data).filter((s) => s.id && ['team', 'org'].includes(S(s.space)) && !['recent', 'trash'].includes(S(s.kind))).map((s) => <Btn key={S(s.id)} size="sm" variant={folderId === S(s.id) ? 'primary' : 'default'} onClick={() => setFolderId(S(s.id))}>{S(s.name)}</Btn>)}</div>
          </Field>
          <div className="table-wrap" style={{ maxHeight: 200, border: 'none', borderRadius: 0 }}><table className="grid"><tbody>
            {arrOf<Json>(kids.data?.folders).map((f) => <tr key={S(f.id)}><td><button className="btn-link" onClick={() => setFolderId(S(f.id))}>{S(f.name)}</button></td></tr>)}
          </tbody></table></div>
          <Field label="历史范围">
            <div className="cluster">
              {(['all', 'until', 'selected', 'summary'] as const).map((k) => <Btn key={k} size="sm" variant={scope === k ? 'primary' : 'default'} onClick={() => setScope(k)}>{{ all: '全部', until: '截至某条', selected: '选定范围', summary: '摘要' }[k]}</Btn>)}
            </div>
          </Field>
          {scope === 'summary' ? <>
            <Field label="摘要内容（必须由你确认后才会带入分支）"><textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="写清已定结论与未决问题" /></Field>
            <Note tone="warn">摘要未预览确认前不会进入新分支。</Note>
          </> : null}
          {readiness.data ? <Note>
            预检：工作区权限 {S((readiness.data as Json).folder_ok ? '通过' : '不足')} · 成员权 {S((readiness.data as Json).member_ok ? '通过' : '待补')} ·
            图片 {(readiness.data as Json).aux_images ? arrOf<Json>((readiness.data as Json).aux_images).length : 0} 张 ·
            源工作区差异 {S((readiness.data as Json).source_diff_note, '无')}
          </Note> : null}
          <Check checked={copyFiles} onChange={setCopyFiles}>将会把对应工作区的文件复制到团队工作区</Check>
        </> : null}
        {step === 3 ? <>
          <div className="dl">
            <dt>团队</dt><dd>{S(arrOf<Json>(teams.data).find((t) => S(t.id) === teamId)?.name, '未选')}</dd>
            <dt>工作区</dt><dd>{S(folderId ? arrOf<Json>(kids.data?.folders).find((f) => S(f.id) === folderId)?.name ?? '已选工作区' : '未选')}</dd>
            <dt>历史</dt><dd>{{ all: '全部消息', until: '截至某条', selected: '选定范围', summary: '摘要（已确认）' }[scope]}</dd>
            <dt>参与人</dt><dd>{picks.length ? picks.map((p) => S(arrOf<Json>(members.data).find((m) => S(m.user_id ?? m.id) === p)?.display_name, p.slice(0, 6))).join('、') : '仅我自己'}</dd>
            <dt>原会话</dt><dd>保持私有，运行不迁移</dd>
          </div>
          {blocked ? <Err>{S(blocked.message, '存在阻塞项，请先解决授权或显式复制文件')}</Err> : null}
        </> : null}
      </div>
    </Modal>
  );
}

// ---------- 新建会话 ----------
function NewSessionDialog({ mode, onClose, onCreated }: { mode: 'personal' | 'team'; onClose: () => void; onCreated: (id: string) => void }) {
  const toast = useToast();
  const spaces = useQ<Json[]>(['spaces'], '/spaces');
  const teams = useQ<Json[]>(['teams'], '/teams');
  const [title, setTitle] = useState('');
  const [folderId, setFolderId] = useState('');
  const [teamId, setTeamId] = useState('');
  const include = true;
  // 可当工作区的只有「真实空间根」：/spaces 里还混着 最近 / 回收站 这类视图项（没有 id），
  // 以及团队与组织根（个人办公会话不该看到它们）。
  const pickable = useMemo(() => arrOf<Json>(spaces.data).filter((s) =>
    s.id && (mode === 'personal' ? s.space === 'personal' : s.space === 'team' || s.space === 'org')), [spaces.data, mode]);
  const browseRoot = String(pickable[0]?.id ?? '');
  const [browse, setBrowse] = useState(browseRoot);
  // 下钻以 browse 为准（与「选中」解耦）：点进子层不改变已选中的工作区
  const kids = useQ<{ folders: Json[]; path: Json[] }>(['folders', 'new-session', browse || 'root'],
    browse ? `/folders/${browse}/children` : '/folders/children');
  const workspaceLabel = folderId
    ? S(arrOf<Json>(spaces.data).find((s) => S(s.id) === folderId)?.name
      ?? arrOf<Json>(kids.data?.folders).find((f) => S(f.id) === folderId)?.name, '已选文件夹')
    : '未指定（只能问答）';
  const browsePath = S(arrOf<Json>(kids.data?.path).map((p) => S(p.name)).join(' / '), S(pickable.find((s) => S(s.id) === browse)?.name, '空间根'));
  return (
    <Modal title={mode === 'personal' ? '新建个人会话' : '新建团队会话'} onClose={onClose}
      footer={<>
        {mode === 'team' ? <span className="group-required-note" style={{marginRight:'auto'}}><span className="group-required">*</span>为必填项</span> : null}
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={mode === 'team' && (!teamId || !folderId)} disabledReason="团队会话需要团队与工作区" onClick={async () => {
          try {
            const r = mode === 'personal'
              ? await api.post<Json>('/agent/sessions', { title: title || '新的个人会话', folder_id: folderId || null, include_children: include })
              : await api.post<Json>('/agent/sessions/team', { title: title || '团队会话', team_id: teamId, folder_id: folderId });
            onCreated(S(r.id));
          } catch (e) { toast(errMsg(e), true); }
        }}>创建</Btn>
      </>}>
      <div className="stack">
        <Field label="标题"><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={mode === 'personal' ? '例如：市场研究' : '例如：客户门户改版'} /></Field>
        {mode === 'team' ? <Field label={<>团队 <span className="group-required">*</span></>}><select aria-required="true" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">请选择</option>{arrOf<Json>(teams.data).map((t) => <option key={S(t.id)} value={S(t.id)}>{S(t.name)}</option>)}</select></Field> : null}
        {/* 个人办公只列个人空间（我的文件 + 自建空间）；团队会话才列团队与组织空间。
            「最近」「回收站」是视图不是位置，不能当工作区。 */}
        <Field label={<>工作区{mode === 'team' ? <> <span className="group-required">*</span></> : null}</>}>
          <FolderTree
            roots={arrOf<Json>(spaces.data)
              .filter((s) => s.id && (mode === 'personal' ? s.space === 'personal' : s.space === 'team' || s.space === 'org'))
              .map((s) => ({ id: S(s.id), name: S(s.name) }))}
            value={folderId || null} onChange={(id) => setFolderId(id ?? '')} />
        </Field>
        
        
      </div>
    </Modal>
  );
}

void fmtSize; void Bar; void wordOf; void SubTabs;









function AgentReplyActions({body,onQuote,folderId}:{body:string;onQuote:(body:string)=>void;folderId?:string}) {
 const toast=useToast();const [saving,setSaving]=useState(false),[busy,setBusy]=useState(false),[name,setName]=useState('Agent 回复.md'),[folder,setFolder]=useState(folderId??'');
 const spaces=useQ<Json[]>(['spaces'],'/spaces',undefined,{enabled:saving});
 return <><div className="agent-reply-actions"><button title="引用" aria-label="引用" onClick={()=>onQuote(body)}><MessageActionIcon name="quote"/></button><button title="存为文件" aria-label="存为文件" onClick={()=>setSaving(true)}><MessageActionIcon name="save"/></button><button title="复制" aria-label="复制" onClick={async()=>{try{if(!await copyText(body))throw new Error('copy');toast('已复制');}catch{toast('复制失败，请手动选择正文复制',true);}}}><MessageActionIcon name="copy"/></button></div>{saving?<Modal title="存为文件" onClose={()=>setSaving(false)} footer={<><Btn onClick={()=>setSaving(false)}>取消</Btn><Btn variant="primary" loading={busy} disabled={!name.trim()} onClick={async()=>{setBusy(true);try{await api.post('/files',{folder_id:folder||null,name:name.trim().endsWith('.md')?name.trim():name.trim()+'.md',format:'markdown',content:body});toast('已保存到文档');setSaving(false);}catch(e){toast(errMsg(e),true);}finally{setBusy(false);}}}>保存</Btn></>}><div className="stack"><Field label="文件名称"><input type="text" value={name} maxLength={175} onChange={e=>setName(e.target.value)}/></Field><Field label="保存位置"><select value={folder} onChange={e=>setFolder(e.target.value)}><option value="">我的文件</option>{folderId&&!spaces.data?.some(s=>s.id===folderId)?<option value={folderId}>当前工作区</option>:null}{spaces.data?.filter(s=>s.id).map(s=><option key={S(s.id)} value={S(s.id)}>{S(s.name)}</option>)}</select></Field></div></Modal>:null}</>;
}



