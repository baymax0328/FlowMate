// FlowMate · Task（任务板块重设计：创建 / 接收 / 负责 / 验收 四段 + 经手人链）
// 经手人链：创建人 →(≥1 中间经手人，最多 7)→ 交付人(验收人)。指派落进第一个经手人的「接收」。
// 不再有「导入并分析 / AI 候选 / 导入历史 / 工作区导入」独立板块；AI 解析产生的草稿直接落进「创建」tab。
import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useScheduleDrag } from './useScheduleDrag';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg, fmtDate, fmtRel, jsonOf, usePageCols, useQ, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { SlideToggle, Avatar, Bar, Btn, Check, ColResizer, Empty, Err, Field, FileBadge, Modal, Note, Pill, Skel, useToast, useOverlayLayer } from '../../components/ui';
import { useSession } from '../../app/session';
import { avatarSource } from '../../app/avatar-options';
import { IllustratedEmpty } from '../../components/IllustratedEmpty';

const localDate=(d=new Date())=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const minutesToTime=(n:number)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));

// 四段流程带 = 四个 tab（key 与服务端 stage 对齐）
const TABS = [
  { key: 'create', no: '01', label: '创建', hint: '草稿 / 创建 / 指派' },
  { key: 'receive', no: '02', label: '接收', hint: '接收 / 调整 / 退回' },
  { key: 'work', no: '03', label: '负责', hint: '处理 / 进度 / 下游交接' },
  { key: 'review', no: '04', label: '验收', hint: '完成验收 / 重新指派' },
] as const;

// 优先级：界面 T0>T1>T2>T3，底层映射到既有四档编码（不改数据库 CHECK）
const PRIORITIES = [{ k: 't0', label: 'T0 · 最高' }, { k: 't1', label: 'T1 · 高' }, { k: 't2', label: 'T2 · 常规' }, { k: 't3', label: 'T3 · 低' }] as const;
const DB_TO_T: Record<string, string> = { urgent: 't0', high: 't1', normal: 't2', low: 't3' };
const MAX_HANDLERS = 5;

export default function TaskPage() {
  const toast = useToast();
  const qc=useQueryClient();
  const refreshDashboard=()=>{for(const key of ['dashboard','dashboard-personal-tasks','dashboard-personal-completed','dashboard-calendar','dashboard-insights'])void qc.invalidateQueries({queryKey:[key]});};
  const meId=useSession().me?.user.id??'';
  const nav = useNavigate();
  const { params, update } = useUrlState({ scope: 'mine', tab: 'create', focus: '', q: '', history: '', teamStatus: 'all' });
  const [dialog, setDialog] = useState<{ kind: string; task?: Json } | null>(null);
  const [historyOpen,setHistoryOpen]=useState(params.history === '1');
  const [scheduleOpen,setScheduleOpen]=useState(false);
  const [modalTaskId,setModalTaskId]=useState('');
  useEffect(()=>{if(!scheduleOpen&&!historyOpen)setModalTaskId('');},[scheduleOpen,historyOpen]);
  const [detailOpen, setDetailOpen] = useState(() => !!params.focus);
  useEffect(() => { if (params.focus) setDetailOpen(true); }, [params.focus]);
  useEffect(() => {
    if (!detailOpen) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && !target.closest('.overlay-details, .modal-mask, .pop')) setDetailOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [detailOpen]);
  const cols = usePageCols('task', { detailDef: 760, detailKey: 'task.drawer-wide.detail' });

  const list = useQ<{ items: Json[]; stage_counts: Record<string, number>; snapshot_id: string }>(
    ['tasks', params.scope, params.tab, params.q], '/tasks',
    { scope: params.scope, tab: params.scope === 'team' ? undefined : params.tab, q: params.q || undefined, limit: 500 }, { refetchMs: 15000 });
  const focusId = params.focus;
  const detail = useQ<Json>(['task', focusId], `/tasks/${focusId || 'none'}`, undefined, { enabled: !!focusId });
  // 负责 tab 的本周网格要连已完成一起显示（灰色）→ 额外拉一份 done
  const doneList = useQ<{ items: Json[] }>(['tasks', 'done', 'mine'], '/tasks', { scope: 'mine', tab: 'done' }, { enabled: scheduleOpen, refetchMs: 30000 });
  const workList=useQ<{items:Json[]}>(['tasks','schedule-work'],'/tasks',{scope:'mine',tab:'work',limit:500},{enabled:scheduleOpen,refetchMs:15000});
  // 成员名映射：看板卡片要显示「下游经手人」的名字，但列表项里 handlers 只有 ID
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const avatarOf = (id: string) => { const member = (members.data ?? []).find(m => S(m.user_id ?? m.id) === id); return member ? avatarSource(member.avatar) : undefined; };
  const nameOf = (id: string) => (members.data ?? []).find((m) => S(m.user_id ?? m.id) === id)?.display_name ?? '';

  const [view, setView] = usePersistentState<'board' | 'list'>('task.view','board');
  const setViewPersist = setView;

  // 负责 tab 右侧：本周排期网格（周一~周日），可左右切周
  const [schedDay, setSchedDay] = useState(localDate);
  const shiftDay = (days: number) => { const dt = new Date(schedDay + 'T00:00:00'); dt.setDate(dt.getDate() + days); setSchedDay(localDate(dt)); };
  const weekOf = (date: string) => { const d0 = new Date(date + 'T00:00:00'); const dow = (d0.getDay() + 6) % 7; d0.setDate(d0.getDate() - dow); return Array.from({ length: 7 }, (_, i) => { const dd = new Date(d0); dd.setDate(d0.getDate() + i); return localDate(dd); }); };
  const weekDays = weekOf(schedDay);

  async function runAutoSchedule(date: string) {
    try {
      const r = await api.post<Json>('/tasks/auto-schedule', { date });
      const n = Number(r.scheduled ?? 0);
      toast(n ? `已为 ${n} 个任务安排本周时段${Number(r.unscheduled ?? 0) ? `，另有 ${r.unscheduled} 个任务可切换下一周继续安排` : ''}` : Number(r.unscheduled??0)?'本周可用时段不足，可切换下一周继续安排':'「负责」里暂无可排任务');
      list.refetch(); workList.refetch(); doneList.refetch();
      refreshDashboard();
    } catch (e) { toast(errMsg(e), true); }
  }

  const teamStatus = TEAM_GROUPS.some((group) => group.key === params.teamStatus) ? params.teamStatus : 'all';
  const setTeamStatus = (value: string) => update({ teamStatus: value });
  const [statusFilter, setStatusFilter] = usePersistentState('task.status-filter','');
  const [typeFilter, setTypeFilter] = usePersistentState('task.type-filter','');
  const [priorityFilter, setPriorityFilter] = usePersistentState('task.priority-filter','');
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => { setSelected([]); }, [params.scope, params.tab, params.q]);
  const rawItems = list.data?.items ?? [];
  const items = rawItems.filter(t => (params.scope !== 'team' || matchesTaskGroup(t, teamStatus)) && (!statusFilter || (statusFilter === 'overdue' ? !!t.is_overdue : S(t.status) === statusFilter)) && (!typeFilter || taskType(t) === typeFilter) && (!priorityFilter || S(t.priority_label) === priorityFilter));
  const toggleSelected = (id: string) => setSelected(ids => ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);
  const exportTasks = async () => {
    try {
      const XLSX = await import('xlsx');
      const exportRows = selected.length ? items.filter(t => selected.includes(S(t.id))) : items;
      const sheet = XLSX.utils.json_to_sheet(exportRows.map(t => ({ '任务标题': S(t.title), '状态': taskStatus(t), '类型': taskType(t), '协作交接': `${flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).up} → ${flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).down}`, '截止日期': S(t.due_at).slice(0,10), '优先级': S(t.priority_label), '任务进度': `${Number(t.progress ?? 0)}%`, '创建人': S(t.creator_name), '创建时间': S(t.created_at).slice(0,10) })));
      sheet['!cols'] = [36,14,16,16,18,12,12,26,16].map(wch => ({ wch }));
      const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, '任务清单');
      XLSX.writeFile(book, `FlowMate-${params.scope === 'team' ? '团队' : '个人'}任务.xlsx`);
    } catch (e) { toast(errMsg(e), true); }
  };
  const counts = list.data?.stage_counts ?? {};
  const d = (detail.data ?? {}) as Json;

  const select = (id: string) => { update({ focus: id }); setDetailOpen(true); };

  async function act(id: string, action: string, payload?: Json, method: 'post' | 'patch' = 'post') {
    try {
      if (method === 'patch') await api.patch(`/tasks/${id}`, payload ?? {});
      else await api.post(`/tasks/${id}/${action}`, payload ?? {});
      toast('已完成'); detail.refetch(); list.refetch();
    } catch (e) { toast(errMsg(e), true); }
  }

  async function openAgent(id: string) {
    try { const r = await api.post<Json>(`/tasks/${id}/agent-session`, {}); if (S(r.session_id)) nav(`/agent/personal?s=${S(r.session_id)}`); }
    catch (e) { toast(errMsg(e), true); }
  }

  const onQuick = (kind: string, task: Json) => {
    const id = S(task.id);
    if (kind === 'complete') act(id, 'review', { decision: 'approve' });
    else if (kind === 'agent') openAgent(id);
    else setDialog({ kind, task });
  };
  const taskIsEmpty = !items.length && !list.isLoading && !list.isError;
  const filteredEmpty = !!(params.q.trim() || statusFilter || typeFilter || priorityFilter);
  const emptyTaskView = <IllustratedEmpty kind="tasks" title={taskEmptyTitle(params.scope, params.tab, teamStatus, filteredEmpty)}
    action={params.scope === 'mine' && params.tab === 'create' && !filteredEmpty ? <Btn variant="primary" size="sm" onClick={() => setDialog({ kind: 'choice' })}>新建任务</Btn> : undefined} />;
  const taskCards = items.map(t => <TaskCard key={S(t.id)} t={t} tab={params.scope === 'team' ? 'team' : params.tab} active={S(t.id) === focusId} nameOf={nameOf} avatarOf={avatarOf} list={false} onSelect={() => select(S(t.id))} onQuick={onQuick} />);
  const taskTable = <div className={`task-data-panel${taskIsEmpty ? ' task-data-empty' : ''}`}><div className="task-data-wrap"><table className="task-data-table"><thead><tr>
    <th className="team-selection"><input type="checkbox" aria-label="全选当前筛选任务" checked={items.length > 0 && items.every(t => selected.includes(S(t.id)))} onChange={e => setSelected(e.target.checked ? items.map(t => S(t.id)) : [])} /></th>
    {['任务标题','状态','类型','协作交接','截止日期','优先级','任务进度','创建人','创建时间', ...(params.scope === 'mine' ? ['操作'] : [])].map(label => <th key={label}>{label}</th>)}
  </tr></thead><tbody>{items.map(t => <tr key={S(t.id)} className={selected.includes(S(t.id)) ? 'selected' : ''}>
    <td className="team-selection"><input type="checkbox" aria-label={`选择${S(t.title)}`} checked={selected.includes(S(t.id))} onChange={() => toggleSelected(S(t.id))} /></td>
    <td><button className="task-title-link" aria-current={S(t.id) === focusId ? true : undefined} onClick={() => select(S(t.id))}>{S(t.title)}</button></td>
    <td><Pill status={t.is_overdue ? 'overdue' : S(t.status)}>{taskStatus(t)}</Pill></td>
    <td>{taskType(t)}</td><td><span className="task-handoff"><Avatar name={S(t.assignee_name,'未指派')} src={avatarOf(S(t.assignee_id))}/>{flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).up}<span aria-hidden="true"> → </span><Avatar name={flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).down} src={avatarOf(flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).downId)}/>{flowOf(t, params.scope === 'mine' ? params.tab : S(t.stage), nameOf).down}</span></td>
    <td className={t.is_overdue ? 'task-overdue' : ''}>{S(t.due_at).slice(0,10) || '—'}</td><td><span className={`task-priority priority-${S(t.priority_label)}`}>{S(t.priority_label, 'T2')}</span></td>
    <td><span className="task-progress"><Bar value={Number(t.progress ?? 0)} /><span>{Number(t.progress ?? 0)}%</span></span></td>
    <td>{S(t.creator_name, '—')}</td><td>{S(t.created_at).slice(0,10)}</td>
    {params.scope === 'mine' ? <td><CardActions tab={params.tab} t={t} onQuick={onQuick} list /></td> : null}
  </tr>)}</tbody></table></div>{taskIsEmpty ? emptyTaskView : null}</div>;

  // 本周已排期的负责任务（给右侧网格；跨天，按 schedule_date 落到对应列）+ 已完成（灰色）
  const weekSet = new Set(weekDays);
  const toBlock = (t: Json, done: boolean) => ({ id: S(t.id), date: S(t.schedule_date), title: S(t.title), priority: S(t.priority_label, 'T2'), start: S(t.schedule_start), end: S(t.schedule_end), note: S(t.schedule_note), done });
  const isScheduledInWeek = (t: Json) => (t.scheduled === true || (S(t.schedule_date) && S(t.schedule_start))) && weekSet.has(S(t.schedule_date));
  const weekBlocks = [
    ...(workList.data?.items??[]).filter(isScheduledInWeek).map((t) => toBlock(t, S(t.status) === 'completed')),
    ...(doneList.data?.items ?? []).filter(t=>S(t.assignee_id)===meId && isScheduledInWeek(t)).map((t) => toBlock(t, true)),
  ];

  return (
    <div className={`paneled detail-only detail-wide overlay-details task-page ${params.scope === 'mine' ? 'personal-tasks' : 'team-tasks'}${detailOpen ? '' : ' detail-closed'}`} style={{ height: '100%', ...cols.style }}>
      {detailOpen ? <button type="button" className="detail-dismiss-layer" aria-label="关闭详情" onClick={() => setDetailOpen(false)} /> : null}
      <section className="work task-work">

        <div className="card-head task-page-toolbar" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', margin: 0, flexWrap: 'wrap' }}>
          <div className="grow">
            <div className="card-title task-page-title">任务
              <span className="pill plain count" style={{ marginLeft: 10, color: params.scope === 'team' ? 'var(--info)' : 'var(--grow-dark)' }}>
                {params.scope === 'team' ? '团队视图' : '个人视图'}
              </span>
            </div>
            
          </div>

          {/* 视图切换：个人 / 团队两种，颜色区分（个人=绿、团队=蓝），切换后左上角标题旁同步标注当前视图 */}
          <SlideToggle left="个人任务视图" right="团队任务视图" checked={params.scope === 'team'} onChange={(team) => update({ scope: team ? 'team' : 'mine', focus: '' })} label="任务视图" />
          <SlideToggle left="看板" right="清单" checked={view === 'list'} onChange={(list) => setViewPersist(list ? 'list' : 'board')} label="任务呈现方式" />
          <Btn size="sm" onClick={()=>setScheduleOpen(true)}>本周排期</Btn>
          <Btn size="sm" onClick={() => { setHistoryOpen(true); update({ history: '1' }); }}>历史任务</Btn>
          <Btn size="sm" variant="primary" onClick={() => setDialog({ kind: 'choice' })}>新建任务</Btn>
          {!detailOpen ? <Btn size="sm" onClick={() => setDetailOpen(true)}>任务详情</Btn> : null}
        </div>

        {/* 四步流程带即四个 tab：每段显示数量，点一下切换 */}
        {params.scope === 'team' ? <div className="team-task-overview"><div className="team-task-metrics">{TEAM_GROUPS.map(g => <button className={`team-metric metric-${g.key}`} key={g.key} aria-pressed={teamStatus === g.key} onClick={() => { setTeamStatus(g.key); setSelected([]); }}><TaskStageIcon index={g.icon} /><span className="team-metric-text"><span>{g.label}</span><strong>{rawItems.filter(t => matchesTaskGroup(t,g.key)).length}</strong></span></button>)}</div><TeamTaskDistribution tasks={rawItems}/></div> : <div className="flow personal-task-flow" role="group" aria-label="任务流转阶段">
          {TABS.map((s) => (
            <button key={s.key} className="stage" aria-pressed={params.tab === s.key} onClick={() => update({ tab: s.key, focus: '' })}>
              <span className="task-stage-symbol"><TaskStageIcon index={Number(s.no)-1} /></span>
              <span className="task-stage-caption"><span className="task-stage-order">{s.no}</span><span className="task-stage-title">{s.label}</span></span>
              <span className="stage-n"><span className="task-stage-count">{counts[s.key] ?? 0}</span><span className="task-stage-unit">项</span></span>
            </button>
          ))}
        </div>}
        <div className="task-filter-toolbar">
          <div className="searchbox task-filter-search"><input type="search" aria-label="搜索任务" placeholder="搜索任务标题 / 描述" value={params.q} onChange={e=>update({q:e.target.value})}/></div>
          <select aria-label="筛选状态" value={statusFilter} onChange={e => { setStatusFilter(e.target.value); setSelected([]); }}><option value="">全部状态</option><option value="overdue">已逾期</option>{Array.from(new Set(rawItems.map(t => S(t.status)))).map(status => <option key={status} value={status}>{STATUS_LABELS[status] ?? status}</option>)}</select>
          <select aria-label="筛选类型" value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setSelected([]); }}><option value="">全部类型</option>{Array.from(new Set(rawItems.map(taskType))).map(type => <option key={type}>{type}</option>)}</select>
          <select aria-label="筛选优先级" value={priorityFilter} onChange={e => { setPriorityFilter(e.target.value); setSelected([]); }}><option value="">全部优先级</option>{PRIORITIES.map(p => <option key={p.k} value={p.k.toUpperCase()}>{p.label}</option>)}</select>
          <button className="btn ghost sm" onClick={() => { setStatusFilter(''); setTypeFilter(''); setPriorityFilter(''); setSelected([]); update({q:''}); }}>清空筛选</button>
          <span className="grow task-filter-count">{items.length} 项任务{selected.length ? ` · 已选 ${selected.length} 项` : ''}</span>
          <button type="button" className="btn export-icon" disabled={!items.length} title="导出 Excel" aria-label="导出 Excel" onClick={() => void exportTasks()}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg><span>导出 Excel</span></button>
        </div>
        {rawItems.length >= 500 ? <div className="note">当前加载前 500 项任务，请使用搜索缩小范围后导出。</div> : null}
        <div className="grow task-content" style={{ overflow: 'auto', padding: 16 }}>
          {list.isLoading ? <Skel rows={5} /> : null}
          {list.isError ? <Err>{errMsg(list.error)}</Err> : null}
          {view === 'list' ? taskTable : taskIsEmpty ? emptyTaskView : (
            <div className="task-board">
              {taskCards}
            </div>
          )}
        </div>
        <input type="file" hidden />
      </section>

      {detailOpen ? (
        <aside className="detail floating-detail" aria-label="详情面板" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setDetailOpen(false); } }}>
          <ColResizer edge="left" onResizeStart={cols.detail.onResizeStart} onNudge={cols.detail.nudge} label="拖动调整任务详情宽度" />
          <div className="detail-head"><b className="grow truncate">{focusId ? S(d.title, '任务详情') : '任务详情'}</b>
            <Btn size="sm" variant="primary" className="drawer-close" onClick={() => setDetailOpen(false)}>收起</Btn></div>
          <div className="detail-body">
            {!focusId ? <div className="muted small">选中任一任务查看详情。</div> : null}
            {focusId && detail.isLoading ? <Skel rows={6} /> : null}
            {focusId && detail.isError ? <Err>{errMsg(detail.error)}</Err> : null}
            {focusId && detail.data ? (
              <TaskDetail d={d} onAct={act} onDialog={(kind, task) => setDialog({ kind, task })} onAgent={async () => {
                try { const r = await api.post<Json>(`/tasks/${focusId}/agent-session`, {}); if (S(r.session_id)) nav(`/agent/personal?s=${S(r.session_id)}`); }
                catch (e) { toast(errMsg(e), true); }
              }} />
            ) : null}
          </div>
        </aside>
      ) : null}

      {scheduleOpen ? <Modal title="本周排期" wide onClose={()=>setScheduleOpen(false)} footer={<Btn onClick={()=>setScheduleOpen(false)}>关闭</Btn>}>
        {workList.isLoading?<Skel rows={5}/>:workList.isError?<Err>{errMsg(workList.error)}</Err>:<ScheduleWeekCalendar weekDays={weekDays} onPrev={()=>shiftDay(-7)} onNext={()=>shiftDay(7)} onToday={()=>setSchedDay(localDate())} onAuto={()=>runAutoSchedule(schedDay)} blocks={weekBlocks} total={workList.data?.items.length??0} tasks={workList.data?.items??[]} onPick={setModalTaskId} onMove={async(id,date,start,end)=>{try{await api.patch(`/tasks/${id}`,{schedule_date:date,schedule_start:start,schedule_end:end,schedule_note:'手动拖动排期'});await workList.refetch();void list.refetch();refreshDashboard();toast('排期已更新');}catch(e){toast(errMsg(e),true);}}}/>}
      </Modal> : null}
      {historyOpen ? <TaskHistory scope={params.scope} onClose={()=>{setHistoryOpen(false);update({history:''});}} onSelect={setModalTaskId}/> : null}
      {modalTaskId&&(scheduleOpen||historyOpen)?<TaskDrawer taskId={modalTaskId} onClose={()=>setModalTaskId('')} onChanged={()=>{void list.refetch();void workList.refetch();void doneList.refetch();refreshDashboard();}}/>:null}
      {dialog ? renderDialog(dialog, {
        onClose: () => setDialog(null),
        onDone: (id?: string) => { setDialog(null); if (id) select(id); list.refetch(); refreshDashboard(); },
        refresh: () => { setDialog(null); list.refetch(); detail.refetch(); refreshDashboard(); },
      }) : null}
    </div>
  );
}

export function TaskDrawer({taskId,onClose,onChanged}:{taskId:string;onClose:()=>void;onChanged?:()=>void}) {
  const toast=useToast(), nav=useNavigate();
  const qc=useQueryClient();
  const detail=useQ<Json>(['task',taskId],`/tasks/${taskId}`,undefined,{enabled:!!taskId});
  const [dialog,setDialog]=useState<{kind:string;task?:Json}|null>(null);
  const layer=useOverlayLayer(onClose);

  const refresh=()=>{setDialog(null);void detail.refetch();for(const key of ['tasks','dashboard','dashboard-calendar','dashboard-insights','dashboard-personal-tasks','dashboard-personal-completed'])void qc.invalidateQueries({queryKey:[key]});onChanged?.();};
  return createPortal(<><div className="task-drawer-shade" style={{zIndex:60+layer*2}} onClick={onClose}/><aside style={{zIndex:61+layer*2}} className="dashboard-task-drawer" role="dialog" aria-modal="true" aria-label="任务详情"><header><b>{S(detail.data?.title,'任务详情')}</b><Btn size="sm" onClick={onClose}>收起</Btn></header><div className="detail-body">
    {detail.isLoading?<Skel rows={7}/>:detail.isError?<Err>{errMsg(detail.error)}</Err>:detail.data?<TaskDetail d={detail.data} onAct={async(id,action,payload,method)=>{try{if(method==='patch')await api.patch(`/tasks/${id}`,payload??{});else await api.post(`/tasks/${id}/${action}`,payload??{});refresh();}catch(e){toast(errMsg(e),true);}}} onDialog={(kind,task)=>setDialog({kind,task})} onAgent={async()=>{try{const r=await api.post<Json>(`/tasks/${taskId}/agent-session`,{});nav(`/agent/personal?s=${S(r.session_id)}`);}catch(e){toast(errMsg(e),true);}}}/>:null}
  </div></aside>{dialog?renderDialog(dialog,{onClose:()=>setDialog(null),onDone:refresh,refresh}):null}</>,document.body);
}

const STATUS_LABELS: Record<string,string> = { draft:'草稿', ready_to_assign:'待指派', pending_accept:'待接收', accepted:'已接收', in_progress:'进行中', pending_review:'待验收', completed:'已完成', cancelled:'已取消' };
const taskType = (t: Json) => S(t.task_type ?? t.type_label, '未分类');
const taskStatus = (t: Json) => t.is_overdue ? '已逾期' : STATUS_LABELS[S(t.status)] ?? S(t.status);
const TEAM_GROUPS = [{key:'all',label:'全部任务',icon:0},{key:'receive',label:'待接收',icon:1},{key:'work',label:'进行中',icon:2},{key:'done',label:'已完成',icon:3},{key:'overdue',label:'已逾期',icon:4}];
function matchesTaskGroup(t: Json, group: string) {
  if (group === 'all') return true;
  if (group === 'receive') return S(t.status) === 'pending_accept';
  if (group === 'work') return ['accepted','in_progress','pending_review'].includes(S(t.status));
  if (group === 'done') return S(t.status) === 'completed';
  return !!t.is_overdue;
}
function TeamTaskDistribution({tasks}: {tasks:Json[]}) {
  const groups=[{key:'work',label:'进行中',color:'#2c805c',n:0},{key:'done',label:'已完成',color:'#84b898',n:0},{key:'pending',label:'待开始',color:'#d3e4d8',n:0},{key:'overdue',label:'已逾期',color:'#426f5a',n:0},{key:'cancelled',label:'已取消',color:'#e1e6e1',n:0}];
  for(const task of tasks){const status=S(task.status);const key=status==='cancelled'?'cancelled':status==='completed'?'done':task.is_overdue?'overdue':['accepted','in_progress','pending_review'].includes(status)?'work':'pending';groups.find(g=>g.key===key)!.n++;}
  const total=tasks.length; const circumference=2*Math.PI*35;let offset=0;
  return <section className="team-task-distribution"><h3>任务状态分布</h3><div className="team-status-body">
    <svg className="team-status-donut" viewBox="0 0 100 100" role="img" aria-label={`共 ${total} 项任务，${groups.filter(g=>g.n).map(g=>`${g.label} ${g.n} 项`).join('，')}`}>
      <circle cx="50" cy="50" r="35" fill="none" stroke="#edf2ed" strokeWidth="12"/>
      {groups.filter(g=>g.n).map(g=>{const length=g.n/total*circumference;const start=offset;offset+=length;return <circle key={g.key} cx="50" cy="50" r="35" fill="none" stroke={g.color} strokeWidth="12" strokeDasharray={`${Math.max(0,length-2.5)} ${circumference}`} strokeDashoffset={-start} transform="rotate(-90 50 50)"><title>{g.label} {g.n} 项 · {Math.round(g.n/total*100)}%</title></circle>;})}
      <text x="50" y="48" textAnchor="middle" className="team-status-total">{total}</text><text x="50" y="63" textAnchor="middle" className="team-status-caption">总任务</text>
    </svg>
    <div className="team-status-legend">{groups.filter(g=>g.key!=='cancelled'||g.n>0).map(g=><div key={g.key}><i style={{background:g.color}}/><span>{g.label}</span><b>{g.n}</b><small>{total?Math.round(g.n/total*100):0}%</small></div>)}</div>
  </div></section>;
}

function TaskStageIcon({index}: {index:number}) {
  if (index === 2) return <svg className="task-stage-icon task-work-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 17V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12M2 20h20"/><path d="m10 8 7 3-3 1-1 3z" fill="currentColor" strokeWidth=".8"/></svg>;

  const paths=['M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6','M3 8l3-5h12l3 5v12H3zM3 12h5l2 3h4l2-3h5','M20 8a8 8 0 1 0 0 8M20 3v5h-5','M8 12l3 3 6-7M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0','M12 7v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'];
  return <svg className="task-stage-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[index] ?? paths[0]} /></svg>;
}

function taskEmptyTitle(scope: string, tab: string, teamStatus: string, filtered: boolean) {
  if (filtered) return '暂未找到匹配的任务';
  if (scope === 'team') return ({ all: '当前暂无团队任务', receive: '当前暂无待接收的任务', work: '当前暂无进行中的任务', done: '当前暂无已完成的任务', overdue: '当前暂无逾期任务' } as Record<string,string>)[teamStatus] ?? '当前暂无团队任务';
  return ({ create: '当前暂无创建中的任务', receive: '当前暂无待接收的任务', work: '当前暂无进行中的任务', review: '当前暂无待验收的任务' } as Record<string,string>)[tab] ?? '当前暂无任务';
}

/** 流转链：上游=当前环节处理人，下游=下一环节接手人（环节内多人时并入「等 N 人」） */
function flowOf(t: Json, tab: string, nameOf: (id: string) => string) {
  const stages = jsonOf<string[][]>(t.stage_users, []);
  const idx = Number(t.handler_index ?? 0);
  const reviewer = S(t.reviewer_name, '交付人');
  const reviewerId = S(t.reviewer_id);
  const currentStage = stages[idx] ?? [];
  const nextStage = stages[idx + 1] ?? [];
  const withCount = (name: string, ids: string[]) => (!ids.length || ids.length <= 1 ? name : `${name} 等 ${ids.length} 人`);
  const upId = S(t.assignee_id) || currentStage[0] || '';
  const up = S(t.assignee_name) || (tab === 'create' ? '待指派' : currentStage.length ? nameOf(currentStage[0]) : '—');
  let down: string, downId: string;
  if (tab === 'create') { const first = stages[0] ?? []; down = first.length ? withCount(nameOf(first[0]) || '待指派', first) : '待指派'; downId = first[0] || ''; }
  else if (tab === 'review') { down = '完成'; downId = ''; }
  else if (nextStage.length) { down = withCount(nameOf(nextStage[0]) || '经手人', nextStage); downId = nextStage[0]; }
  else { down = reviewer; downId = reviewerId; }
  return { up, down, upId, downId };
}

function TaskCard({ t, tab, active, nameOf, avatarOf, list, onSelect, onQuick }: {
  t: Json; tab: string; active: boolean; nameOf: (id: string) => string; avatarOf: (id: string) => string | undefined; list?: boolean; onSelect: () => void;
  onQuick: (kind: string, task: Json) => void;
}) {
  const returned = t.returned === true || Number(t.returned ?? 0) === 1;
  const cls = `exec${tab === 'create' && returned ? ' bad' : ''}${['pending_review', 'pending_accept'].includes(S(t.status)) ? ' wait' : ''}`;
  const priority = S(t.priority_label, 'T2');
  const flow = flowOf(t, tab === 'team' ? S(t.stage) : tab, nameOf);
  const common = { role: 'button' as const, tabIndex: 0, 'aria-current': active, onClick: onSelect, onKeyDown: (e: RKeyboardEvent) => { if (e.key === 'Enter') onSelect(); } };

  // 最前端：已排期显示具体时间块（T0 橙、其余绿，参考图）；未排期沿用状态 pill（已接收 / 进行中…）
  // 验收 tab 里「我创建、仍在他人经手中」的任务（非待验收）统一显示为「进行中」
  const inHandReview = tab === 'review' && S(t.status) !== 'pending_review';
  const scheduled = t.scheduled === true || (S(t.schedule_date) && S(t.schedule_start));
  const lead = inHandReview
    ? <Pill tone="info">进行中</Pill>
    : scheduled
    ? <span className={`sched-chip${priority === 'T0' ? ' hot' : ''}`}>{S(t.schedule_label, `${S(t.schedule_start)}-${S(t.schedule_end)}`)}</span>
    : <Pill status={t.is_overdue ? 'overdue' : S(t.status)}>{taskStatus(t)}</Pill>;
  const pills = <>
    {lead}
    <span className={`task-priority priority-${priority}`}>{priority}</span>
    {tab === 'create' && returned ? <Pill tone="bad">已退回</Pill> : null}
  </>;
  const dueEl = t.due_at ? <span className={`small${t.is_overdue ? ' bad' : ''}`}>{t.is_overdue ? '已逾期 ' : '期限 '}{fmtDate(S(t.due_at))}</span> : null;
  const flowEl = <span className="flow-chip small"><Avatar name={flow.up} src={avatarOf(flow.upId)}/><b className="flow-up">{flow.up}</b><span className="flow-arrow">→</span><Avatar name={flow.down} src={avatarOf(flow.downId)}/><span className="flow-down">{flow.down}</span></span>;

  // 清单：一行铺开，任务名称紧跟在优先级右侧，其余自适应换行
  if (list) {
    return (
      <div className={`${cls} task-row`} {...common}>
        <span className="task-row-pills">{pills}</span>
        <span className="exec-title task-title-inline">{S(t.title)}</span>
        <span className="task-row-meta">{flowEl}{dueEl}</span>
        <span className="task-row-bar"><Bar value={Number(t.progress ?? 0)} /></span>
        <CardActions tab={tab} t={t} onQuick={onQuick} list />
        <span className="muted small task-row-time">{fmtRel(S(t.updated_at))}</span>
      </div>
    );
  }

  // 看板：竖排卡片
  return (
    <div className={cls} style={{ textAlign: 'left', cursor: 'pointer' }} {...common}>
      <div className="exec-head">{pills}<span className="right">{fmtRel(S(t.updated_at))}</span></div>
      <div className="exec-title">{S(t.title)}</div>
      <div className="task-card-meta">
        <div className="task-card-handoff"><span className="muted">协作交接</span>{flowEl}</div>
        <div className="task-card-facts">
          <span><span className="muted">类型</span> {taskType(t)}</span>
          <span className={t.is_overdue ? 'task-overdue' : ''}><span className="muted">截止日期</span> {S(t.due_at).slice(0,10) || '—'}</span>
        </div>
      </div>
      <div className="task-card-progress"><Bar value={Number(t.progress ?? 0)} /><span>{Number(t.progress ?? 0)}%</span></div>
      <CardActions tab={tab} t={t} onQuick={onQuick} />
    </div>
  );
}

/** 卡片底部按当前 tab 放该场景最常用的动作；tab 过滤已保证「我就是该段的责任人」 */
function CardActions({ tab, t, onQuick, list }: { tab: string; t: Json; onQuick: (kind: string, task: Json) => void; list?: boolean }) {
  const btn = (kind: string, label: string, variant?: 'primary' | 'danger', cls?: string) => (
    <Btn size="sm" variant={variant} className={cls} onClick={(e) => { e.stopPropagation(); onQuick(kind, t); }}>{label}</Btn>
  );
  const scheduled = t.scheduled === true || (S(t.schedule_date) && S(t.schedule_start));
  const map: Record<string, { kind: string; label: string; variant?: 'primary' | 'danger'; cls?: string }[]> = {
    // 创建：编辑 与 确认并指派 是两个独立按钮
    create: [{ kind: 'edit', label: '编辑' }, { kind: 'manual', label: '确认并指派', variant: 'primary' }],
    receive: [{ kind: 'estimate', label: '接收', variant: 'primary' }, { kind: 'manual', label: '调整' }, { kind: 'reject', label: '退回', variant: 'danger' }],
    // 负责：只留 4 个按钮，顺序固定；未排期时「手动排期」呈橙色提醒
    work: [
      { kind: 'schedule', label: '手动排期', cls: scheduled ? undefined : 'btn-warn' },
      { kind: 'workspace', label: '关联工作区' },
      { kind: 'agent', label: '前往办公' },
      { kind: 'handoff', label: '交接', variant: 'primary' },
    ],
    review: [{ kind: 'complete', label: '完成验收', variant: 'primary' }, { kind: 'reassign', label: '重新指派', variant: 'danger' }],
  };
  const acts = map[tab] ?? [];
  if (!acts.length) return null;
  const style = list ? { flexWrap: 'wrap' as const } : { marginTop: 8, borderTop: '1px solid var(--line)', paddingTop: 8, flexWrap: 'wrap' as const };
  return <div className="cluster task-row-actions" style={style}>{acts.map((a, i) => btn(a.kind, a.label, a.variant, a.cls))}</div>;
}

function TaskDetail({ d, onAct, onDialog, onAgent }: {
  d: Json; onAct: (id: string, action: string, payload?: Json, method?: 'post' | 'patch') => void;
  onDialog: (kind: string, task: Json) => void; onAgent: () => void;
}) {
  const id = S(d.id);
  const allowed = jsonOf<string[]>(d.allowed_actions, []);
  const has = (a: string) => allowed.includes(a);
  const chain = jsonOf<Json[]>(d.chain, []);
  const stage = S(d.stage);
  const dScheduled = d.scheduled === true || (S(d.schedule_date) && S(d.schedule_start));
  return (
    <div className="stack">
      <div className="cluster">
        <Pill status={S(d.status)} />
        {d.is_overdue ? <Pill tone="bad">已逾期</Pill> : null}
        {Number(d.review_round ?? 1) > 1 ? <Pill plain tone="count">第 {S(d.review_round)} 轮</Pill> : null}
        <span className="muted small right">r{S(d.revision)}</span>
      </div>
      <h3 style={{ fontSize: 17 }}>{S(d.title)}</h3>
      {d.description ? <div className="small">{S(d.description)}</div> : null}
      {d.returned ? <Note tone="warn">被接收人退回：{S(d.reject_reason)}</Note> : null}
      <div className="dl">
        <dt>创建人</dt><dd>{S(d.creator_name)}</dd>
        <dt>交付人</dt><dd>{S(d.reviewer_name, '未指定')}</dd>
        <dt>任务类型</dt><dd>{taskType(d)}</dd>
        <dt>期限</dt><dd>{d.due_at ? fmtDate(S(d.due_at)) : '未设'}</dd>
        <dt>优先级</dt><dd>{S(d.priority_label ?? d.priority)}</dd>
        <dt>关联工作区</dt><dd>{S(d.folder_name, '未关联')}</dd>
      </div>

      {chain.length?<TaskWorkflow chain={chain}/>:null}

      {S(d.criteria, '') && jsonOf<Json[]>(d.criteria, []).length ? (
        <Field label="完成标准">
          <div className="stack">{jsonOf<Json[]>(d.criteria, []).map((c, i) => (
            <div key={i} className="row-meta"><Check checked disabled>{S(c.text)}{c.required ? <span className="muted">（必需）</span> : null}</Check></div>
          ))}</div>
        </Field>
      ) : null}

      <div className="side-title">进度</div>
      <div className="task-progress-detail"><Bar value={Number(d.progress ?? 0)} /><span>{S(d.progress, 0)}%{d.blocked_note ? ` · 阻塞：${S(d.blocked_note)}` : ''}</span></div>

      {jsonOf<Json[]>(d.submissions, []).length ? (
        <>
          <div className="side-title">最终产物</div>
          {jsonOf<Json[]>(d.submissions, []).slice(-2).map((s, i) => (
            <div key={S(s.id)} className="exec idle" style={{ marginBottom: 6 }}>
              <div className="exec-head">提交 v{s.submission_no ?? s.seq ?? i + 1}<Pill status={S(s.status)} /><span className="right">{S(s.submitter_name)} · {fmtRel(S(s.created_at))}</span></div>
              <div className="exec-body small">{S(s.note, '无说明')}</div>
              {jsonOf<Json[]>(s.file_snapshot, []).map((f, j) => (
                <div className="row-meta" key={j}><FileBadge ext={S(f.name).split('.').pop()} /><span className="grow truncate">{S(f.name)}</span><Pill plain tone="count">v{S(f.version_no)}</Pill></div>
              ))}
            </div>
          ))}
        </>
       ) : null}

      <div className="row-sep" />
      <div className="cluster" style={{ flexWrap: 'wrap' }}>
        {has('assign') ? <Btn size="sm" variant="primary" onClick={() => onDialog('manual', d)}>确认并指派</Btn> : null}
        {has('edit') ? <Btn size="sm" onClick={() => onDialog('manual', d)}>编辑</Btn> : null}
        {has('accept') ? <Btn size="sm" variant="primary" onClick={() => onDialog('estimate', d)}>接收</Btn> : null}
        {has('adjust') ? <Btn size="sm" onClick={() => onDialog('manual', d)}>调整</Btn> : null}
        {has('reject') ? <Btn size="sm" variant="danger" onClick={() => onDialog('reject', d)}>退回</Btn> : null}
        {/* 负责：只保留 手动排期 / 关联工作区 / 前往办公 / 交接 四个按钮，按此顺序；未排期时手动排期呈橙色 */}
        {has('schedule') ? <Btn size="sm" className={dScheduled ? undefined : 'btn-warn'} onClick={() => onDialog('schedule', d)}>手动排期</Btn> : null}
        {has('folder') ? <Btn size="sm" onClick={() => onDialog('workspace', d)}>关联工作区</Btn> : null}
        {has('agent') ? <Btn size="sm" onClick={onAgent}>{d.agent_session_id ? '打开处理会话' : '前往办公'}</Btn> : null}
        {has('handoff_next') ? <Btn size="sm" variant="primary" onClick={() => onDialog('handoff', d)}>交接</Btn> : null}
        {has('review') ? <Btn size="sm" variant="primary" onClick={() => onDialog('review', d)}>完成验收</Btn> : null}
        {has('reassign') ? <Btn size="sm" variant="danger" onClick={() => onDialog('reassign', d)}>重新指派</Btn> : null}
        {has('cancel') ? <Btn size="sm" variant="ghost" onClick={() => onDialog('cancel', d)}>取消任务</Btn> : null}
      </div>
    </div>
  );
}

function TaskWorkflow({chain}:{chain:Json[]}) {
  const status=(state:string)=>({active:'处理中',done:'已交接',rejected:'已退回',waiting:'待接手',pending:'待接手'}[state]??'待接手');
  const duration=(member:Json)=>{
    if(!member.accepted_at)return '尚未开始';
    const elapsed=member.duration_ms??(Date.parse(S(member.ended_at))?Date.parse(S(member.ended_at))-Date.parse(S(member.accepted_at)):Date.now()-Date.parse(S(member.accepted_at)));
    return `用时 ${fmtDur(Math.max(0,Number(elapsed)||0))}`;
  };
  return <section className="task-workflow"><h3 className="side-title">协作流程与用时</h3><ol className="task-workflow-track">{chain.map((step,i)=>{
    const endpoint=step.role!=='stage';
    return <li className={`task-workflow-step ${endpoint?'endpoint':'processing'} state-${S(step.state)}`} key={i}><span className="task-workflow-node" aria-hidden="true"/>
      {endpoint?<div className="workflow-endpoint"><span className="workflow-role">{step.role==='creator'?'创建人':'交付人'}</span><Avatar name={S(step.name)} src={avatarSource(step.avatar)}/><b>{S(step.name)}</b>{step.role==='reviewer'&&step.state==='active'?<Pill status="pending_review"/>:null}</div>:<div className="workflow-stage-card"><header><span>{jsonOf<Json[]>(step.members,[]).length>1?'协作处理':'任务处理'}</span><small>{jsonOf<Json[]>(step.members,[]).length} 人</small></header>{jsonOf<Json[]>(step.members,[]).map(m=><div className="workflow-member" key={S(m.user_id)}><Avatar name={S(m.name)} src={avatarSource(m.avatar)}/><div className="workflow-member-name"><b>{S(m.name)}</b><small>{m.accepted_at?`${fmtRel(S(m.accepted_at))}接手`:'等待接收任务'}</small></div><div className="workflow-member-time"><span className={`workflow-state state-${S(m.state)}`}>{status(S(m.state))}</span><small>{duration(m)}</small></div></div>)}</div>}
    </li>;
  })}</ol></section>;
}

function fmtDur(ms: number): string {
  if (!ms || ms <= 0) return '未开始 / 未计时';
  const min = Math.round(ms / 60000);
  if (min < 1) return '不足 1 分钟';
  if (min < 60) return `${min} 分钟`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr} 小时`;
  return `${Math.round(hr / 24)} 天`;
}

// 统一渲染所有弹窗：manual（新建/编辑/确认并指派/调整）、choice（新建入口）、ai、reject、handoff、progress、submit、review、reassign
function renderDialog(dialog: { kind: string; task?: Json }, h: { onClose: () => void; onDone: (id?: string) => void; refresh: () => void }) {
  const { kind, task } = dialog;
  if (kind === 'choice') return <NewTaskChoice onClose={h.onClose} onCreated={h.refresh} />;
  if (kind === 'manual') return <ManualTaskDialog task={task} onClose={h.onClose} onDone={h.onDone} />;
  if (kind === 'edit') return <ManualTaskDialog task={task} onClose={h.onClose} onDone={h.onDone} />;
  if (kind === 'workspace') return <WorkspaceDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'schedule') return <ScheduleDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'estimate') return <EstimateDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'ai') return <AiParseDialog onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'reject') return <ReasonDialog title="退回任务" label="退回原因" required danger confirmText="退回" onClose={h.onClose} onSubmit={async (note) => { await api.post(`/tasks/${S(task?.id)}/reject`, { note }); h.refresh(); }} />;
  if (kind === 'cancel') return <ReasonDialog title="取消任务" label="取消原因" confirmText="确认取消" danger onClose={h.onClose} onSubmit={async (reason) => { if (!reason) throw new Error('请填写取消原因'); await api.post(`/tasks/${S(task?.id)}/cancel`, { reason }); h.refresh(); }} />;
  if (kind === 'handoff') return <HandoffDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'progress') return <ProgressDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'submit') return <SubmitDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'review') return <ReviewDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  if (kind === 'reassign') return <ReassignDialog task={task ?? {}} onClose={h.onClose} onDone={h.refresh} />;
  return null;
}

// ==================== 弹窗 ====================
function NewTaskChoice({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [pick, setPick] = useState<'' | 'manual' | 'ai'>('');
  if (pick === 'manual') return <ManualTaskDialog onClose={onClose} onDone={() => { onClose(); onCreated(); }} />;
  if (pick === 'ai') return <AiParseDialog onClose={onClose} onDone={onCreated} />;
  return (
    <Modal title="新建任务" onClose={onClose}>
      <div className="stack">
        <div className="task-create-ai">
          <Btn className="task-create-option" onClick={() => setPick('ai')} style={{ width: '100%', height: 52 }}>AI 解析任务</Btn>
          <div className="task-create-help-wrap">
            <button type="button" className="task-create-help" aria-label="了解 AI 解析任务" aria-describedby="task-ai-tip">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8.3 20.2c-1.5 1-3.2 1.6-5.1 1.6 1.2-1 2.1-2.1 2.6-3.2A9.3 9.3 0 1 1 8.3 20.2Z" />
                <path d="M9.5 8.5c.2-1.3 1.3-2.2 2.8-2.2 1.6 0 2.8 1 2.8 2.5 0 2-2.9 2.5-2.9 4.5" />
                <circle cx="12.2" cy="16.5" r="1" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <div id="task-ai-tip" className="task-ai-tip" role="tooltip">可以上传会议纪要、邮件内容，通过 AI 解析生成任务草稿</div>
          </div>
        </div>
        <Btn className="task-create-option" onClick={() => setPick('manual')} style={{ width: '100%', height: 52 }}>手动创建任务</Btn>
      </div>
    </Modal>
  );
}

function ReasonDialog({ title, label, required, confirmText, danger, onClose, onSubmit }: {
  title: string; label: string; required?: boolean; confirmText: string; danger?: boolean; onClose: () => void; onSubmit: (v: string) => Promise<void>;
}) {
  const [v, setV] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Btn variant="ghost" onClick={onClose}>取消</Btn>
      <Btn variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => {
        if (required && !v.trim()) { setErr('不能为空'); return; }
        setBusy(true); try { await onSubmit(v.trim()); onClose(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
      }}>{confirmText}</Btn>
    </>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <Field label={label}><textarea aria-required={required} autoFocus value={v} onChange={(e) => setV(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function usePeople() {
  const members = useQ<Json[]>(['members'], '/organizations/members');
  return members.data ?? [];
}
function useWorkspaces() {
  const spaces = useQ<Json[]>(['spaces'], '/spaces');
  return spaces.data ?? [];
}

/** 统一的任务创建/编辑/确认并指派/调整弹窗（AI 草稿编辑也用它，字段一致） */
function ManualTaskDialog({ task, onClose, onDone }: { task?: Json; onClose: () => void; onDone: (id?: string) => void }) {
  const toast = useToast();
  const { me } = useSession();
  const members = usePeople();
  const spaces = useWorkspaces();
  const isEdit = !!task?.id;
  const [f, setF] = useState<Json>(() => ({
    task_type: S(task?.task_type), title: S(task?.title), description: S(task?.description), expected_deliverable: S(task?.expected_deliverable),
    folder_id: S(task?.folder_id), reviewer_id: S(task?.reviewer_id) || S(me?.user.id),
    stages: initialStages(task).length ? initialStages(task) : [[]], due_at: S(task?.due_at).slice(0, 10),
    priority: DB_TO_T[S(task?.priority)] ?? S(task?.priority_label) ?? 't0',
    criteria: jsonOf<Json[]>(task?.criteria, []),
  }));
  const [err, setErr] = useState<string | null>(null);
  const set = (patch: Json) => setF((p) => ({ ...p, ...patch }));
  // 清洗后的环节（去掉空成员、空环节）；页面不再展示「≤5」这类小字提示，上限由服务端静默约束
  const cleanStages = jsonOf<string[][]>(f.stages, []).map((s) => (Array.isArray(s) ? s.filter(Boolean) : [])).filter((s) => s.length);
  // 只有「创建人在草稿/待指派（含退回）」时才可直接指派；接收人「调整」只保存，不指派
  const canAssign = !isEdit || ['draft', 'ready_to_assign'].includes(S(task!.status));

  function validateForAssign(): string | null {
    if (!S(f.title).trim()) return '任务名称必填';
    if (!cleanStages.length) return '任务经手成员为必填项，至少安排一位经手人';
    if (!S(f.reviewer_id)) return '任务交付人必填';
    if (!S(f.due_at)) return '任务期限必填';
    return null;
  }

  async function saveDraft(): Promise<string | null> {
    if (!S(f.title).trim()) { setErr('任务名称必填'); return null; }
    const body = { ...f, stages: cleanStages, status: 'ready_to_assign', source: S(task?.source) || 'manual', source_ref: task?.source_ref ?? undefined };
    if (isEdit) { await api.patch(`/tasks/${S(task!.id)}`, body); return S(task!.id); }
    const r = await api.post<Json>('/tasks', body); return S(r.id);
  }

  return (
    <Modal title={isEdit ? (S(task!.returned) ? '编辑被退回的任务' : '编辑任务') : '手动创建任务'}
      wide onClose={onClose}
      footer={<>
        <span className="muted small" style={{ marginRight: 'auto' }}>* 为必填项</span>
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        {canAssign ? (
          <>
            <Btn onClick={async () => { try { const id = await saveDraft(); if (id) { toast('已保存草稿'); onDone(id); } } catch (e) { setErr(errMsg(e)); } }}>{isEdit ? '保存草稿' : '存为草稿'}</Btn>
            <Btn variant="primary" onClick={async () => {
              const v = validateForAssign(); if (v) { setErr(v); return; }
              try {
                const id = await saveDraft(); if (!id) return;
                await api.post(`/tasks/${id}/assign`, {
                  stages: cleanStages, reviewer_id: S(f.reviewer_id),
                  due_at: S(f.due_at) || undefined, expected_deliverable: S(f.expected_deliverable) || undefined,
                  folder_id: S(f.folder_id) || undefined,
                  criteria: jsonOf<Json[]>(f.criteria, []).filter((c) => S(c.text)),
                });
                toast('已指派，首批经手成员可在「接收」中查看'); onDone();
              } catch (e) { setErr(errMsg(e)); }
            }}>确认并指派</Btn>
          </>
        ) : (
          <Btn variant="primary" onClick={async () => { try { await saveDraft(); toast('已保存调整'); onDone(); } catch (e) { setErr(errMsg(e)); } }}>保存调整</Btn>
        )}
      </>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <Field label={<>任务名称<span className="req">*</span></>}><input type="text" value={S(f.title)} autoFocus onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="任务内容"><textarea value={S(f.description)} onChange={(e) => set({ description: e.target.value })} /></Field>
        <div className="cluster">
          <div style={{ flex: 1 }}><Field label="任务类型"><input type="text" list="task-type-options" maxLength={120} value={S(f.task_type)} onChange={e=>set({task_type:e.target.value})}/><datalist id="task-type-options">{['产品设计','前端开发','后端开发','缺陷修复','文档撰写','会议安排'].map(type=><option key={type} value={type}/>)}</datalist></Field></div>
          <div style={{ flex: 1 }}><Field label="关联工作区"><select value={S(f.folder_id)} onChange={(e) => set({ folder_id: e.target.value })}>
            <option value="">不关联</option>{spaces.map((s) => <option key={S(s.id)} value={S(s.id)}>{S(s.name)}</option>)}</select></Field></div>
        </div>
        <div className="cluster">
          <div style={{ flex: 1 }}><Field label="任务创建人"><input type="text" value={S(me?.user.display_name)} disabled /></Field></div>
          <div style={{ flex: 1 }}><Field label={<>任务验收人<span className="req">*</span></>}><select value={S(f.reviewer_id)} onChange={(e) => set({ reviewer_id: e.target.value })}>
            <option value="">请选择</option>{members.map((m) => <option key={S(m.user_id ?? m.id)} value={S(m.user_id ?? m.id)}>{S(m.display_name)}</option>)}</select></Field></div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          
          <HandlerChain creatorName={S(me?.user.display_name)} reviewerName={S((members.find((m) => S(m.user_id ?? m.id) === S(f.reviewer_id)) as Json)?.display_name, f.reviewer_id ? '' : '未选')}
            members={members} value={jsonOf<string[][]>(f.stages, [])} onChange={(s) => set({ stages: s })} />
        </div>
        <div className="cluster">
          <div style={{ flex: 1 }}><Field label={<>任务期限<span className="req">*</span></>}><input type="date" value={S(f.due_at)} onChange={(e) => set({ due_at: e.target.value })} /></Field></div>
          <div style={{ flex: 1 }}><Field label="建议优先级"><select value={S(f.priority)} onChange={(e) => set({ priority: e.target.value })}>
            {PRIORITIES.map((p) => <option key={p.k} value={p.k}>{p.label}</option>)}</select></Field></div>
        </div>
        <Field label="完成标准">
          <div className="stack">{jsonOf<Json[]>(f.criteria, []).map((c, i) => (
            <div className="cluster" key={i}>
              <input type="text" value={S(c.text)} placeholder="例如：三套方向含配色与字体说明"
                onChange={(e) => { const nx = [...jsonOf<Json[]>(f.criteria, [])]; nx[i] = { ...nx[i], text: e.target.value }; set({ criteria: nx }); }} />
              <Check checked={c.required !== false} onChange={(v) => { const nx = [...jsonOf<Json[]>(f.criteria, [])]; nx[i] = { ...nx[i], required: v }; set({ criteria: nx }); }}>必需</Check>
              <Btn size="sm" variant="ghost" onClick={() => set({ criteria: jsonOf<Json[]>(f.criteria, []).filter((_, j) => j !== i) })}>删除</Btn>
            </div>
          ))}
            <Btn size="sm" onClick={() => set({ criteria: [...jsonOf<Json[]>(f.criteria, []), { text: '', required: true }] })}>添加一条</Btn>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

/** 成员 id → 显示名 */
const nameOfId = (members: Json[], id: string) => S(members.find((m) => S(m.user_id ?? m.id) === id)?.display_name, id ? id.slice(0, 6) : '');
const avatarOfId = (members: Json[], id: string) => { const m = members.find((x) => S(x.user_id ?? x.id) === id); return m ? avatarSource(m.avatar) : undefined; };

/** 老数据 / 草稿折算成环节：优先 stage_users(string[][])，否则把线性 handlers 折算成「每人一个环节」 */
function initialStages(task?: Json): string[][] {
  const su = jsonOf<string[][]>(task?.stage_users, []);
  if (Array.isArray(su) && su.length) return su.map((s) => (Array.isArray(s) ? s.filter(Boolean) : [])).filter((s) => s.length);
  const handlers = jsonOf<string[]>(task?.handlers, []);
  return handlers.filter(Boolean).map((h) => [h]);
}

/** One searchable multi-select per collaboration step. Keep order in the horizontal flow. */
function StageMembers({members,value,onChange}:{members:Json[];value:string[];onChange:(v:string[])=>void}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  return <div className="handler-select">
    <button ref={trigger} type="button" className="handler-select-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>
      <span className="handler-selected-avatars">{value.slice(0,3).map(id=><Avatar key={id} name={nameOfId(members,id)} src={avatarOfId(members,id)}/>)}</span>
      <span className="handler-selected-names">{value.length?value.map(id=>nameOfId(members,id)).join('、'):'选择经手成员'}</span>
      {value.length>0?<small>{value.length} 人</small>:null}<svg className="handler-select-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </button>
    {open?<StageMemberMenu members={members} value={value} onChange={onChange} anchor={trigger.current} onClose={()=>{setOpen(false);trigger.current?.focus();}}/>:null}
  </div>;
}
function StageMemberMenu({members,value,onChange,anchor,onClose}:{members:Json[];value:string[];onChange:(v:string[])=>void;anchor:HTMLButtonElement|null;onClose:()=>void}) {
  const [search,setSearch]=useState('');const menu=useRef<HTMLDivElement>(null);
  const layer=useOverlayLayer(onClose);
  const position=()=>{const r=anchor?.getBoundingClientRect();const width=Math.min(320,window.innerWidth-24);const below=(r?.bottom??100)+8;const height=Math.min(390,window.innerHeight-32);return {left:Math.max(12,Math.min(r?.left??12,window.innerWidth-width-12)),top:below+height<window.innerHeight?below:Math.max(12,(r?.top??height)-height-8),width,maxHeight:height};};
  const [style,setStyle]=useState(position);
  useEffect(()=>{const adjust=()=>setStyle(position());const outside=(e:PointerEvent)=>{if(e.target instanceof Node&&!menu.current?.contains(e.target)&&!anchor?.contains(e.target))onClose();};window.addEventListener('resize',adjust);document.addEventListener('scroll',adjust,true);document.addEventListener('pointerdown',outside,true);return()=>{window.removeEventListener('resize',adjust);document.removeEventListener('scroll',adjust,true);document.removeEventListener('pointerdown',outside,true);};},[anchor,onClose]);
  const query=search.trim().toLowerCase();
  const team=(m:Json)=>Array.isArray(m.teams)?m.teams.map((t:Json|string)=>typeof t==='string'?t:S(t.name)).join(' / '):S(m.team_name??m.title,'');
  const results=members.filter(m=>`${S(m.display_name)} ${S(m.email)} ${team(m)}`.toLowerCase().includes(query));
  return createPortal(<div ref={menu} className="handler-member-menu" style={{...style,zIndex:62+layer*2}}>
    <div className="handler-member-search searchbox"><input autoFocus type="search" aria-label="搜索经手成员" placeholder="搜索姓名、邮箱或团队" value={search} onChange={e=>setSearch(e.target.value)}/></div>
    <div className="handler-member-options" role="listbox" aria-label="经手成员" aria-multiselectable="true">{results.map(m=>{const id=S(m.user_id??m.id),selected=value.includes(id);return <button type="button" role="option" aria-selected={selected} key={id} onClick={()=>onChange(selected?value.filter(v=>v!==id):[...value,id])}><span className={`handler-member-check${selected?' checked':''}`} aria-hidden="true">{selected?'✓':''}</span><Avatar name={S(m.display_name)} src={avatarOfId(members,id)}/><span className="handler-member-label"><b>{S(m.display_name)}</b><small>{team(m)||S(m.email)}</small></span></button>;})}{!results.length?<p className="muted">未找到匹配成员</p>:null}</div>
    <footer><span>已选 {value.length} 人</span><Btn size="sm" variant="ghost" onClick={()=>onChange([])}>清空</Btn><Btn size="sm" variant="primary" onClick={onClose}>完成</Btn></footer>
  </div>,document.body);
}
function HandlerChain({creatorName,reviewerName,members,value,onChange}:{creatorName:string;reviewerName:string;members:Json[];value:string[][];onChange:(v:string[][])=>void}) {
  const endpoint=(label:string,name:string)=><div className="handler-endpoint"><small>{label}</small><div><Avatar name={name||'?'} src={avatarSource(members.find(m=>S(m.display_name)===name)?.avatar)}/><b>{name||'待选择'}</b></div></div>;
  const arrow=<span className="handler-flow-arrow" aria-hidden="true"><svg viewBox="0 0 32 24" width="30" height="24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12h25m-7-7 7 7-7 7"/></svg></span>;
  return <div className="handler-flow-section"><header className="handler-flow-heading"><b>任务经手成员<span className="req">*</span></b><Btn size="sm" disabled={value.length>=7} onClick={()=>onChange([...value,[]])}>增加经手人</Btn></header><div className="handler-flow-editor"><div className="handler-flow-track" aria-label="按从左到右顺序处理任务">
    {endpoint('创建人',creatorName)}{arrow}
    {value.map((stage,index)=><div className="handler-flow-step" key={index}><div className="handler-collaboration"><StageMembers members={members} value={stage} onChange={users=>onChange(value.map((v,i)=>i===index?users:v))}/><button type="button" className="handler-remove-step" aria-label="删除此经手环节" title="删除此经手环节" onClick={()=>onChange(value.filter((_,i)=>i!==index))}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg></button></div>{arrow}</div>)}
    {endpoint('交付人',reviewerName)}
  </div></div></div>;
}

/** AI 解析任务：上传/粘贴 → 走导入分析 → 把候选直接生成为「创建」tab 里的草稿 */
function AiParseDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'upload' | 'paste'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [poll, setPoll] = useState<Json | null>(null);

  async function analyze() {
    setBusy(true); setErr(null);
    try {
      let importId = '';
      if (mode === 'paste') {
        if (!text.trim()) throw new Error('请粘贴内容');
        const r = await api.post<Json>('/discovery/imports', { name: 'AI 解析任务', pasted_text: text, mode: 'paste' });
        importId = S(r.id ?? r.import_id);
      } else {
        if (!file) throw new Error('请选择文件');
        const form = new FormData(); form.append('file', file);
        const r = await api.upload<Json>('/discovery/imports', form);
        importId = S(r.id ?? r.import_id);
      }
      // 轮询导入状态直到终态
      let status = ''; let providerErr = '';
      for (let i = 0; i < 20; i++) {
        const d = await api.get<Json>(`/discovery/imports/${importId}`);
        status = S(d.status); providerErr = S(d.error_code); setPoll(d);
        if (['succeeded', 'partial_failed', 'failed'].includes(status)) break;
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (status === 'failed' || providerErr === 'PROVIDER_UNAVAILABLE') throw new Error('模型不可用：AI 解析需要先配置模型密钥（.env），配好后再试');
      // 把候选转成草稿
      const cands = jsonOf<Json[]>(await api.get<Json[]>(`/discovery/candidates`, { import_id: importId, status: 'pending' }), []);
      if (!cands.length) throw new Error('没有从内容里识别出可执行的行动项');
      for (const c of cands) {
        await api.post<Json>('/tasks', {
          title: S(c.title).slice(0, 180) || '来自 AI 解析的任务', description: S(c.description),
          expected_deliverable: S(c.deliverable), due_at: S(c.due_date) || undefined,
          priority: 'normal', status: 'ready_to_assign', source: 'candidate',
          source_ref: { candidate_id: S(c.id), import_id: importId },
        });
      }
      toast(`已生成 ${cands.length} 个任务草稿，可在「创建」tab 里确认并指派`);
      onDone();
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="AI 解析任务" wide onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn><Btn variant="primary" loading={busy} onClick={() => void analyze()}>开始解析</Btn></>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <div className="subtabs" role="tablist">
          <button className="subtab" role="tab" aria-selected={mode === 'upload'} onClick={() => setMode('upload')}>上传文件</button>
          <button className="subtab" role="tab" aria-selected={mode === 'paste'} onClick={() => setMode('paste')}>粘贴文本</button>
        </div>
        {mode === 'upload' ? (
          <div className="ai-file-upload">
            <label className="ai-file-picker">
              <input type="file" aria-label="选择文件" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span>选择文件</span>
            </label>
            <span className="muted small">{file?.name ?? '未选择文件'}</span>
            <div className="hint">支持 word / pdf / excel / ppt / md / html / txt格式</div>
          </div>
        ) : (
          <Field label={<span style={{ fontSize: 15, fontWeight: 600 }}>内容</span>}><textarea style={{ minHeight: 180 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={'例：\n张三下周三前完成权限矩阵文档，交给李四评审。'} /></Field>
        )}
        {poll ? <Note>分析状态：{S(poll.status)}{Number(poll.candidates ?? jsonOf<Json>(poll.counts, {}).candidates ?? 0) ? ` · 识别 ${jsonOf<Json>(poll.counts, {}).candidates} 个行动项` : ''}</Note> : null}
      </div>
    </Modal>
  );
}

function HandoffDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  const chain = jsonOf<Json[]>(task.chain, []);
  const next = chain.find((c) => S(c.role) === 'handler' && (S(c.state) === 'waiting' || S(c.state) === 'pending'));
  const reviewer = chain.find((c) => S(c.role) === 'reviewer');
  return (
    <Modal title="下游交接" onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn><Btn variant="primary" onClick={async () => { await api.post(`/tasks/${S(task.id)}/handoff-next`, { note: note || undefined }); onDone(); }}>交接</Btn></>}>
      <div className="stack">
        <Field label="交接说明"><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="写清已完成到哪、接下来要做什么" /></Field>
      </div>
    </Modal>
  );
}

function ProgressDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Json>({ done_text: '', blocked_text: '', progress: Number(task.progress ?? 0) });
  return (
    <Modal title="更新进度" onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn><Btn variant="primary" onClick={async () => { await api.post(`/tasks/${S(task.id)}/progress`, f); onDone(); }}>提交</Btn></>}>
      <div className="stack">
        <Field label="完成事项"><textarea value={S(f.done_text)} onChange={(e) => setF({ ...f, done_text: e.target.value })} /></Field>
        <Field label="阻塞"><textarea value={S(f.blocked_text)} onChange={(e) => setF({ ...f, blocked_text: e.target.value })} /></Field>
        <Field label={`进度 ${S(f.progress)}%`}><input type="range" min={0} max={100} value={S(f.progress)} onChange={(e) => setF({ ...f, progress: Number(e.target.value) })} style={{ padding: 0 }} /></Field>
      </div>
    </Modal>
  );
}

function SubmitDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const files = useQ<Json>(['pick-files', q], '/search', { q: q || '·', type: 'files' });
  const rows = jsonOf<Json[]>(jsonOf<Json>(files.data, {}).groups?.files ?? [], []);
  return (
    <Modal title="提交产物" sub="选择要作为交付物的工作区文件版本" wide onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={!picked.length} disabledReason="至少选择一个版本" onClick={async () => {
          try { await api.post(`/tasks/${S(task.id)}/submit`, { file_version_ids: picked, note: note || undefined }); onDone(); } catch (e) { toast(errMsg(e), true); }
        }}>{`提交 ${picked.length} 个版本`}</Btn></>}>
      <div className="stack">
        <div className="searchbox"><input type="search" placeholder="搜索成果文件" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="table-wrap" style={{ maxHeight: 300 }}><table className="grid"><tbody>
          {rows.map((f) => (
            <tr key={S(f.file_id ?? f.id)}><td><Check checked={picked.includes(S(f.current_version_id ?? f.version_id))} onChange={(v) => {
              const vid = S(f.current_version_id ?? f.version_id); if (!vid) return;
              setPicked((p) => (v ? [...p, vid] : p.filter((x) => x !== vid)));
            }}><span className="truncate">{S(f.name)}</span></Check></td></tr>
          ))}
          {!rows.length ? <tr><td className="muted">没有命中文件；先在文档页上传或新建</td></tr> : null}
        </tbody></table></div>
        <Field label="交付说明"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** 负责 tab 右侧：本周排期网格（共享时间轴 + 周一~周日 列，今天高亮），可切周、点块选中任务 */
function ScheduleWeekCalendar({ weekDays, blocks, total, onPrev, onNext, onToday, onAuto, onPick, onMove, tasks }: {
  weekDays: string[]; total: number; tasks:Json[]; onMove:(id:string,date:string,start:string,end:string)=>Promise<void>;
  blocks: { id: string; date: string; title: string; priority: string; start: string; end: string; note: string; done?: boolean }[];
  onPrev: () => void; onNext: () => void; onToday: () => void; onAuto: () => Promise<void>; onPick: (id: string) => void;
}) {
  const toast=useToast();
  const [autoBusy,setAutoBusy]=useState(false);
  const toMin = (time: string) => {
    const [hour, minute] = time.split(':').map(Number);
    const minutes = hour * 60 + minute;
    return Number.isFinite(minutes) ? Math.max(0, Math.min(1440, minutes)) : 0;
  };
  const startHour = Math.min(9, ...blocks.map((block) => Math.floor(toMin(block.start) / 60)));
  const endHour = Math.max(18, ...blocks.map((block) => Math.ceil(toMin(block.end) / 60)));
  const hours = endHour - startHour;
  const timelineHeight = 306;
  const hourHeight = timelineHeight / hours;
  const labelStep = Math.ceil(hours / 9);
  const today = localDate();
  const {dragging,drop,bindTask}=useScheduleDrag({startHour,endHour,hourHeight,blocks,onMove,onPick,onInvalid:message=>toast(message,true)});
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return (
    <aside className="sched-cal sched-week">
      <div className="sched-cal-head">
        <div className="grow">
          <b>{weekDays[0]} ~ {weekDays[6]}</b>
          <div className="muted small">共负责 {total} 个任务</div>
        </div>
        <div className="cluster" style={{ gap: 4 }}>
          <Btn size="sm" variant="ghost" onClick={onPrev} aria-label="上一周">◀</Btn>
          <Btn size="sm" variant="ghost" onClick={onToday}>本周</Btn>
          <Btn size="sm" variant="ghost" onClick={onNext} aria-label="下一周">▶</Btn>
          <Btn size="sm" loading={autoBusy} disabled={autoBusy} onClick={async()=>{setAutoBusy(true);try{await onAuto();}finally{setAutoBusy(false);}}} title="结合截止时间、优先级和预估时长安排整周任务">AI 排期</Btn>
        </div>
      </div>
      <div className="schedule-task-tray">{tasks.filter(t=>!blocks.some(b=>b.id===S(t.id))).map(t=><button key={S(t.id)} className={dragging?.id===S(t.id)?'dragging':''} {...bindTask(S(t.id),Math.max(15,Number(t.estimate_min)||60))}>{S(t.title)}</button>)}</div>
      {dragging?<div className="schedule-drag-ghost" style={{left:dragging.x+14,top:dragging.y+14}}>{S(tasks.find(t=>S(t.id)===dragging.id)?.title,'调整排期')}</div>:null}

      <div className="sched-scroll">
        <div className="sched-head">
          <span className="sched-corner"></span>
          {weekDays.map((d) => (
            <span key={d} className={`sched-dhead${d === today ? ' today' : ''}`}>
              <span className="wd">{wd[new Date(d + 'T00:00:00').getDay()]}</span><span className="dn">{Number(d.slice(8))}</span>
            </span>
          ))}
        </div>
        <div className="sched-body">
          <div className="sched-axis" style={{ height: timelineHeight }}>
            {Array.from({ length: hours + 1 }, (_, i) => i).filter((i) => i % labelStep === 0).map((i) => (
              <span key={i} className="sched-axlab" style={{ top: i * hourHeight - 7 }}>{String(startHour + i).padStart(2, '0')}:00</span>
            ))}
          </div>
          {weekDays.map((d) => {
            const dayBlocks = blocks.filter((b) => b.date === d);
            return (
              <div key={d} data-schedule-date={d} className={`sched-col${d === today ? ' today' : ''}`} style={{ height: timelineHeight }}>
                {Array.from({ length: hours }, (_, i) => (
                  <div className="sched-grid-line" key={i} style={{ top: i * hourHeight }} />
                ))}
                {drop?.date===d&&dragging?<div className="schedule-drop-preview" style={{top:(drop.minute/60-startHour)*hourHeight,height:(blocks.find(b=>b.id===dragging.id)?toMin(blocks.find(b=>b.id===dragging.id)!.end)-toMin(blocks.find(b=>b.id===dragging.id)!.start):Number(tasks.find(t=>S(t.id)===dragging.id)?.estimate_min)||60)/60*hourHeight}}>{minutesToTime(drop.minute)}</div>:null}
                {dayBlocks.map((b) => {
                  const duration = (toMin(b.end) - toMin(b.start)) / 60 * hourHeight;
                  const height = Math.min(timelineHeight, Math.max(18, duration));
                  const offset = (toMin(b.start) / 60 - startHour) * hourHeight;
                  const top = Math.min(timelineHeight - height, Math.max(0, offset));
                  return (
                    <button className={`sched-blk${b.priority === 'T0' ? ' hot' : ''}${b.done ? ' done' : ''}`} key={b.id}
                      style={{ top, height }} {...bindTask(b.id,toMin(b.end)-toMin(b.start),b.done)} title={`${b.start}-${b.end} ${b.title}`} aria-label={`${b.start} 至 ${b.end}，${b.title}`}>
                      {height >= 30 ? <span className="sched-blk-time">{b.start}-{b.end}</span> : null}
                      <span className="sched-blk-title">{b.title}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      
    </aside>
  );
}

/** 单任务手动排期：可改预估时长 + 设日期起止时间（也可取消排期） */
function ScheduleDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [hrs, setHrs] = useState(Number(task.estimate_min ?? 0) ? String(Number(task.estimate_min) / 60) : '');
  const [date, setDate] = useState(S(task.schedule_date) || new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState(S(task.schedule_start) || '09:00');
  const [end, setEnd] = useState(S(task.schedule_end) || '10:00');
  const [note, setNote] = useState(S(task.schedule_note));
  const save = async (clear: boolean) => {
    const h = Number(hrs);
    const estMin = hrs && Number.isFinite(h) && h > 0 ? Math.max(1, Math.min(1440, Math.round(h * 60))) : null;
    try {
      await api.patch(`/tasks/${S(task.id)}`, clear
        ? { schedule_date: null, schedule_start: null, schedule_end: null, schedule_note: null }
        : { estimate_min: estMin, schedule_date: date, schedule_start: start, schedule_end: end, schedule_note: note || null });
      toast(clear ? '已取消排期' : '已排期'); onDone();
    } catch (e) { toast(errMsg(e), true); }
  };
  return (
    <Modal title="手动排期" onClose={onClose}
      footer={<>
        <span className="group-required-note" style={{ marginRight: 'auto' }}><span className="group-required">*</span>为必填项</span>
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        {S(task.schedule_date) ? <Btn variant="danger" onClick={() => save(true)}>取消排期</Btn> : null}
        <Btn variant="primary" onClick={() => save(false)}>保存</Btn>
      </>}>
      <div className="stack">
        <Field label="预估时长（小时）">
          <input type="number" min={0.5} max={24} step={0.5} value={hrs} onChange={(e) => setHrs(e.target.value)} />
        </Field>
        <Field label={<>日期 <span className="group-required" aria-hidden="true">*</span></>}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="schedule-time-row">
          <Field label={<>开始 <span className="group-required" aria-hidden="true">*</span></>}><input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label={<>结束 <span className="group-required" aria-hidden="true">*</span></>}><input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="备注"><input type="text" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

/** 接收前先填预估时长（分钟）；确认后调用 accept，任务转入「负责」 */
function EstimateDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  // 界面用「小时」，落库存分钟（×60）；预估时长之后在负责页仍可改
  const [hrs, setHrs] = useState(String((Number(task.estimate_min ?? 0) || 60) / 60));
  const [err, setErr] = useState<string | null>(null);
  const submit = async () => {
    const h = Number(hrs);
    if (!Number.isFinite(h) || h <= 0 || h > 24) { setErr('请填写 0.5–24 之间的小时数'); return; }
    const minutes = Math.max(1, Math.min(1440, Math.round(h * 60)));
    try { await api.post(`/tasks/${S(task.id)}/accept`, { estimate_min: minutes }); toast('已接收，进入负责'); onDone(); }
    catch (e) { setErr(errMsg(e)); }
  };
  return (
    <Modal title="接收任务" onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn><Btn variant="primary" onClick={submit}>确认接收</Btn></>}>
      <div className="stack">
        {err ? <Err>{err}</Err> : null}
        <Field label="预估时长（小时）">
          <input type="number" min={0.5} max={24} step={0.5} autoFocus value={hrs} onChange={(e) => setHrs(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

/** 修改任务关联的工作区（负责阶段可用）：只改 folder_id，不动其它字段 */
function WorkspaceDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const spaces = useWorkspaces();
  const [folder, setFolder] = useState(S(task.folder_id));
  return (
    <Modal title="关联工作区" onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" onClick={async () => {
          try { await api.patch(`/tasks/${S(task.id)}`, { folder_id: folder || null }); toast('已更新关联工作区'); onDone(); }
          catch (e) { toast(errMsg(e), true); }
        }}>保存</Btn></>}>
      <div className="stack">
        <Field label="关联工作区">
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">不关联</option>{spaces.map((s) => <option key={S(s.id)} value={S(s.id)}>{S(s.name)}</option>)}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function ReviewDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="完成验收" sub="确认交付人满意后通过；不满意请点「重新指派」" onClose={onClose}
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn><Btn variant="primary" onClick={async () => { await api.post(`/tasks/${S(task.id)}/review`, { decision: 'approve', note: note || undefined }); onDone(); }}>完成验收</Btn></>}>
      <div className="stack">
        <Field label="验收说明"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ReassignDialog({ task, onClose, onDone }: { task: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const members = usePeople();
  // 默认沿用本轮环节，交付人可在其上增删改后再派
  const [stages, setStages] = useState<string[][]>(() => initialStages(task).length ? initialStages(task) : [[]]);
  const [note, setNote] = useState('');
  const { me } = useSession();
  const clean = stages.map((s) => s.filter(Boolean)).filter((s) => s.length);
  return (
    <Modal title="重新指派" onClose={onClose} wide
      footer={<><Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="danger" onClick={async () => {
          if (!clean.length) { toast('至少安排一位新的经手人', true); return; }
          try { await api.post(`/tasks/${S(task.id)}/reassign`, { stages: clean, reviewer_id: S(task.reviewer_id) || undefined, note: note || undefined }); onDone(); }
          catch (e) { toast(errMsg(e), true); }
        }}>重新指派</Btn></>}>
      <div className="stack">
        
        <HandlerChain creatorName={S(me?.user.display_name)} reviewerName={S((members.find((m) => S(m.user_id ?? m.id) === S(task.reviewer_id)) as Json)?.display_name, '')} members={members} value={stages} onChange={setStages} />
        <Field label="不通过原因 / 新要求"><textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}











function TaskHistory({scope,onClose,onSelect}:{scope:string;onClose:()=>void;onSelect:(id:string)=>void}) {
  const [q,setQ]=useState(''),[status,setStatus]=useState(''),[type,setType]=useState(''),[page,setPage]=useState(1);
  const result=useQ<{items:Json[];total:number;page:number;pages:number;types:string[]}>(['task-history',scope,q,status,type,page],'/tasks/history',{scope,q,status,type,page});
  return <Modal title="历史任务" onClose={onClose} wide footer={<><span className="grow small muted">共 {result.data?.total ?? 0} 项 · 每页最多 30 项</span><Btn disabled={page<=1} onClick={()=>setPage(page-1)}>上一页</Btn><span>{result.data?.page ?? page} / {result.data?.pages ?? 1}</span><Btn disabled={!result.data||page>=result.data.pages} onClick={()=>setPage(page+1)}>下一页</Btn></>}><div className="history-filters"><div className="searchbox grow"><input type="search" aria-label="搜索历史任务" placeholder="搜索任务标题或描述" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}}/></div><select aria-label="历史任务状态" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">全部状态</option><option value="completed">已完成</option><option value="cancelled">已取消</option></select><select aria-label="历史任务类型" value={type} onChange={e=>{setType(e.target.value);setPage(1);}}><option value="">全部类型</option>{result.data?.types.map(t=><option key={t}>{t}</option>)}</select></div>{result.isLoading?<Skel rows={5}/>:result.isError?<Err>{errMsg(result.error)}</Err>:<div className="task-data-wrap"><table className="task-data-table history-table"><thead><tr>{['任务标题','状态','类型','优先级','完成日期','创建人','创建时间','查看详情'].map(x=><th key={x}>{x}</th>)}</tr></thead><tbody>{result.data?.items.map(t=><tr key={S(t.id)}><td><button className="task-title-link" onClick={()=>onSelect(S(t.id))}>{S(t.title)}</button></td><td><Pill tone={t.status==='completed'?'ok':'idle'}>{t.status==='completed'?'已完成':'已取消'}</Pill></td><td>{taskType(t)}</td><td><span className={`task-priority priority-${S(t.priority_label)}`}>{S(t.priority_label)}</span></td><td>{t.status==='completed'?S(t.completed_at??t.updated_at).slice(0,10):'—'}</td><td>{S(t.creator_name)}</td><td>{S(t.created_at).slice(0,10)}</td><td><Btn size="sm" onClick={()=>onSelect(S(t.id))}>查看详情</Btn></td></tr>)}</tbody></table>{!result.data?.items.length?<Empty title="没有符合条件的历史任务"/>:null}</div>}</Modal>;
}

