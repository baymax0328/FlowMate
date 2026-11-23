// FlowMate · 看板（Dashboard）：我的看板 / 团队看板 × 当日/当周/当月。图表全内联 SVG/CSS，不引第三方库。
// 数据来自 GET /dashboard，实时从任务/用量/事件/提交聚合，与任务、办公等页面联动。
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { avatarSource } from '../../app/avatar-options';
import { useQ, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { dashboardPreview } from './preview';
import { PersonalDashboard, TeamMetrics, DashboardWelcome, useDashboardClock } from './PersonalDashboard';
import { TaskDrawer } from '../task/TaskPage';
import { FilePreviewModal } from '../workspace/WorkspacePage';
import { DashboardTaskAction } from './task-actions';
import { Pill, SlideToggle, Avatar } from '../../components/ui';

const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));
const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const todayStr = () => new Date().toISOString().slice(0, 10);

export default function DashboardPage() {
  const { params, update } = useUrlState({ view: 'mine', period: 'week' });
  const scope = params.view === 'team' ? 'team' : 'mine';
  const q = useQ<Json>(['dashboard', scope, params.period], '/dashboard', { scope, period: params.period }, { refetchMs: 30000 });
  const [preview, setPreview] = usePersistentState('dashboard.preview',false);
  const [taskId,setTaskId]=useState('');
  const d = (preview ? { ...q.data, ...dashboardPreview(params.period, scope === 'team') } : q.data ?? {}) as Json;
  const kpi = (d.kpi ?? {}) as Json;
  const series = (d.series ?? []) as Json[];
  const isMine = scope === 'mine';
  const now = useDashboardClock();

  return (
    <DashboardTaskAction.Provider value={setTaskId}><div className={`dash ${isMine ? 'personal-dashboard' : 'team-dashboard'}`}>
      <div className="dash-top">
        <DashboardWelcome now={now}/>
        <section className="dashboard-quick-actions" aria-label="快捷操作"><div>
        <SlideToggle left="查看示例" right="真实数据" checked={!preview} onChange={(real) => setPreview(!real)} label="示例或真实数据" />
        <div className="seg-pill" role="group" aria-label="统计周期">
          {([['day', '当日'], ['week', '当周'], ['month', '当月']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={params.period === k} onClick={() => update({ period: k })}>{l}</button>
          ))}
        </div>
        <SlideToggle left="我的看板" right="团队看板" checked={!isMine} onChange={(team) => update({ view: team ? 'team' : 'mine' })} label="看板视图" />
        </div></section>
      </div>
      {q.isLoading ? <div style={{ padding: 20 }}><div className="skeleton" style={{ height: 160 }} /><div className="skeleton" style={{ height: 320, marginTop: 14 }} /></div> : null}

      {q.data || preview ? (
        isMine ? (
          <PersonalDashboard d={d} preview={preview} now={now} period={params.period} />
        ) : (
          <div className="dash-team">
            <TeamMetrics preview={preview} period={params.period} d={d}/>
            <RecentResults rows={(d.gallery ?? []) as Json[]} preview={preview} />
            <TeamCollaboration data={d} preview={preview} />
          </div>
        )
      ) : null}
    </div>{taskId?<TaskDrawer taskId={taskId} onClose={()=>setTaskId('')}/>:null}</DashboardTaskAction.Provider>
  );
}

// ---------- KPI 卡 ----------
function ActiveCard({ active2, phases }: { active: number; active2: number; phases: Json }) {
  const p = phases ?? {}; const total = (Number(p.create) || 0) + (Number(p.receive) || 0) + (Number(p.work) || 0) + (Number(p.review) || 0);
  const seg = [
    { k: 'create', label: '创建', v: Number(p.create) || 0, c: '#BcCfB8' },
    { k: 'receive', label: '接收', v: Number(p.receive) || 0, c: '#7FA88C' },
    { k: 'work', label: '负责', v: Number(p.work) || 0, c: 'var(--grow)' },
    { k: 'review', label: '验收', v: Number(p.review) || 0, c: '#C97A2B' },
  ];
  return (
    <div className="card kpi">
      <div className="kpi-label">进行任务数</div>
      <div className="kpi-value">{active2}<span className="kpi-unit">项</span></div>
      <div className="stack-bar" title="创建/接收/负责/验收">
        {seg.map((s) => s.v ? <span key={s.k} style={{ width: `${(s.v / Math.max(1, total)) * 100}%`, background: s.c }} /> : null)}
        {!total ? <span style={{ width: '100%', background: 'var(--line)' }} /> : null}
      </div>
      <div className="kpi-legend">{seg.map((s) => <span key={s.k}><i style={{ background: s.c }} />{s.label} {s.v}</span>)}</div>
    </div>
  );
}

function TokenCard({ token }: { token: Json }) {
  const t = token ?? {}; const total = Number(t.total) || 0; const inV = Number(t.in) || 0; const outV = Number(t.out) || 0;
  return (
    <div className="card kpi">
      <div className="kpi-label">Token 消耗量</div>
      <div className="kpi-value">{fmtK(total)}<span className="kpi-unit">tokens</span></div>
      <div className="split-bar">{inV || outV ? <><span className="sb-in" style={{ width: `${(inV / Math.max(1, total)) * 100}%` }} /><span className="sb-out" style={{ width: `${(outV / Math.max(1, total)) * 100}%` }} /></> : null}</div>
      <div className="kpi-legend"><span><i style={{ background: 'var(--grow-dark)' }} />输入 {fmtK(inV)}</span><span><i style={{ background: '#9CBEA8' }} />输出 {fmtK(outV)}</span></div>
    </div>
  );
}

function AvgCard({ avg }: { avg: Json }) {
  const a = avg ?? {}; const actual = Number(a.hours) || 0; const target = Number(a.target) || 4; const max = Math.max(actual, target, 1);
  return (
    <div className="card kpi">
      <div className="kpi-label">平均任务耗时</div>
      <div className="kpi-value">{actual}<span className="kpi-unit">小时 / 项</span></div>
      <div className="cmp-row"><span className="cmp-lab muted">目标</span><div className="cmp-track"><span className="cmp-target" style={{ width: `${(target / max) * 100}%` }} /></div><span className="cmp-val">{target}h</span></div>
      <div className="cmp-row"><span className="cmp-lab">实际</span><div className="cmp-track"><span className="cmp-actual" style={{ width: `${(actual / max) * 100}%` }} /></div><span className="cmp-val">{actual}h</span></div>
    </div>
  );
}

function CompletionCard({ c }: { c: Json }) {
  const x = c ?? {}; const onTime = Number(x.onTime) || 0, atRisk = Number(x.atRisk) || 0, overdue = (Number(x.overdueDone) || 0) + (Number(x.overdue) || 0), total = Number(x.total) || (onTime + atRisk + overdue);
  return (
    <div className="card kpi kpi-donut">
      <div className="kpi-label">交付完成度</div>
      <div className="donut-wrap">
        <Donut onTime={onTime} atRisk={atRisk} overdue={overdue} pct={Number(x.pct) || 0} accepted={Number(x.accepted) || 0} total={total} />
        <div className="donut-legend">
          <span><i style={{ background: 'var(--grow)' }} />按时 {onTime}</span>
          <span><i style={{ background: '#C97A2B' }} />可能延期 {atRisk}</span>
          <span><i style={{ background: '#C4573F' }} />超期 {overdue}</span>
        </div>
      </div>
    </div>
  );
}

// ---------- 图表 ----------
function Donut({ onTime, atRisk, overdue, pct, accepted, total }: { onTime: number; atRisk: number; overdue: number; pct: number; accepted: number; total: number }) {
  const r = 34, c = 2 * Math.PI * r; const sum = Math.max(1, onTime + atRisk + overdue);
  const seg = (v: number) => (v / sum) * c; let acc = 0;
  const parts = [{ v: onTime, col: 'var(--grow)' }, { v: atRisk, col: '#C97A2B' }, { v: overdue, col: '#C4573F' }];
  return (
    <svg viewBox="0 0 88 88" className="donut-svg" role="img" aria-label="交付完成度">
      <circle cx="44" cy="44" r={r} fill="none" stroke="var(--line)" strokeWidth="10" />
      <g transform="rotate(-90 44 44)">
        {parts.map((p, i) => { const dash = seg(p.v); const el = <circle key={i} cx="44" cy="44" r={r} fill="none" stroke={p.col} strokeWidth="10" strokeDasharray={`${dash} ${c - dash}`} strokeDashoffset={-acc} />; acc += dash; return el; })}
      </g>
      <text x="44" y="42" textAnchor="middle" className="donut-pct">{pct}%</text>
      <text x="44" y="56" textAnchor="middle" className="donut-sub">已验收 {accepted}/{total}</text>
    </svg>
  );
}

function AreaChart({ points, unit = '' }: { points: number[]; unit?: string }) {
  const w = 320, h = 84, pad = 8; const vals = points.length ? points : [0]; const mx = Math.max(...vals, 1);
  const step = vals.length > 1 ? (w - pad * 2) / (vals.length - 1) : 0;
  const xy = vals.map((v, i) => [pad + i * step, h - pad - (v / mx) * (h - pad * 2)] as [number, number]);
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${pad},${h - pad} ${xy.map((p) => p.join(',')).join(' ')} ${xy[xy.length - 1][0]},${h - pad}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="chart-svg" role="img" aria-label="趋势">
      <polygon points={area} className="chart-area" />
      <polyline points={xy.map((p) => p.join(',')).join(' ')} className="chart-line" fill="none" />
      {xy.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={1.8} className="chart-dot" />)}
      <text x={w - pad} y={12} textAnchor="end" className="chart-max">{fmtK(mx)}{unit}</text>
    </svg>
  );
}

function BarChart({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="bars">
      {data.map((d, i) => (
        <div className="bar-col" key={i} title={`${d.label}：${d.value}`}>
          <div className="bar-track"><span className="bar-fill" style={{ height: `${(d.value / max) * 100}%` }} /></div>
          <span className="bar-lab">{d.label}</span>
        </div>
      ))}
      {!data.length ? <div className="muted small">暂无数据</div> : null}
    </div>
  );
}

type WorkBubble = { id: string; name: string; total: number; completed: number; x: number; y: number; radius: number };

function workloadBubbles(rows: Json[], width: number, height: number): WorkBubble[] {
  const ordered = rows.filter(row => Number(row.total) > 0).slice().sort((a, b) => Number(b.total) - Number(a.total));
  const largest = Math.max(1, ...ordered.map(row => Number(row.total)));
  const placed: WorkBubble[] = [];
  const bounds = (items: WorkBubble[]) => ({
    left: Math.min(...items.map(item => item.x - item.radius)),
    right: Math.max(...items.map(item => item.x + item.radius)),
    top: Math.min(...items.map(item => item.y - item.radius)),
    bottom: Math.max(...items.map(item => item.y + item.radius)),
  });
  ordered.forEach((row, index) => {
    const radius = 27 + 40 * Math.sqrt(Number(row.total) / largest);
    let best = { x: 0, y: 0, score: Infinity };
    for (const neighbor of placed) {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 12) {
        const x = neighbor.x + Math.cos(angle) * (neighbor.radius + radius) * 0.94;
        const y = neighbor.y + Math.sin(angle) * (neighbor.radius + radius) * 0.94;
        if (placed.some(item => Math.hypot(item.x - x, item.y - y) < (item.radius + radius) * 0.935)) continue;
        const box = bounds([...placed, { id:'', name:'', total:0, completed:0, x, y, radius }]);
        const score = Math.max((box.right - box.left) / width, (box.bottom - box.top) / height);
        if (score < best.score) best = { x, y, score };
      }
    }
    placed.push({ id: S(row.id, index), name: S(row.name), total: Number(row.total), completed: Number(row.completed) || 0, x:best.x, y:best.y, radius });
  });
  if (!placed.length) return [];
  const box = bounds(placed);
  const scale = 0.90 * Math.min((width - 16) / (box.right - box.left), (height - 16) / (box.bottom - box.top));
  return placed.map(item => ({ ...item, x:width / 2 + (item.x - (box.left + box.right) / 2) * scale,
    y:height / 2 + (item.y - (box.top + box.bottom) / 2) * scale, radius:item.radius * scale }));
}

function TeamPanelIcon({ kind }: { kind: 'workload' | 'relay' | 'results' }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={kind === 'workload' ? 'M4 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M9 5.5h12M4 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M9 12h12M4 17a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3M9 18.5h12' : kind === 'results' ? 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5' : 'M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4'} />
  </svg>;
}

function TeamCollaboration({ data, preview }: { data: Json; preview: boolean }) {
  const [mode, setMode] = usePersistentState('dashboard.workload-mode','member');
  const rows: Json[] = (mode === 'member' ? data.workload : data.workloadDepartments) ?? [];
  return <div className="team-insight-row">
    <section className="personal-panel team-insight-panel">
      <header><h2 className="panel-h"><TeamPanelIcon kind="workload" />团队工作负荷</h2>
        <div className="workload-mode"><SlideToggle left="按成员" right="按部门" checked={mode === 'department'} onChange={department => setMode(department ? 'department' : 'member')} label="工作负荷统计维度" /></div>
      </header>
      <Workload rows={rows} summaryRows={(data.workload ?? []) as Json[]} />
    </section>
    <section className="personal-panel team-insight-panel">
      <header><h2 className="panel-h"><TeamPanelIcon kind="relay" />协作接力台</h2>
        <a href="/task?scope=team&teamStatus=done">查看全部 →</a>
      </header>
      <Relay rows={(data.relay ?? []) as Json[]} preview={preview} />
    </section>
  </div>;
}

function Workload({ rows, summaryRows }: { rows: Json[]; summaryRows: Json[] }) {
  const chart = useRef<SVGSVGElement>(null);
  const gradientId = useId().replaceAll(':', '');
  const [size, setSize] = useState({ width:410, height:235 });
  const hasData = rows.some(row => Number(row.total) > 0);
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasData]);
  const bubbles = workloadBubbles(rows, size.width, size.height);
  const total = summaryRows.reduce((sum, row) => sum + (Number(row.total) || 0), 0);
  const completed = summaryRows.reduce((sum, row) => sum + (Number(row.completed) || 0), 0);
  return <>
    <div className="workload-visual">
      {bubbles.length ? <svg ref={chart} className="workload-bubbles" viewBox={`0 0 ${size.width} ${size.height}`} role="img" aria-label={rows.map(row => `${S(row.name)}，已完成 ${Number(row.completed) || 0} 项，共 ${Number(row.total) || 0} 项`).join('；')}>
        <defs>
          <linearGradient id={`${gradientId}-high`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#73ac77" /><stop offset="1" stopColor="#3f8e50" />
          </linearGradient>
          <linearGradient id={`${gradientId}-medium`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#dfedcf" /><stop offset="1" stopColor="#badcaa" />
          </linearGradient>
          <linearGradient id={`${gradientId}-low`} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#f0f5e9" /><stop offset="1" stopColor="#dfedd8" />
          </linearGradient>
        </defs>
        {bubbles.map(bubble => {
          const fontSize = Math.max(9, Math.min(25, bubble.radius * 0.33));
          const maxCharacters = Math.max(2, Math.floor(bubble.radius * 1.7 / fontSize));
          const name = bubble.name.length > maxCharacters ? bubble.name.slice(0, maxCharacters - 1) + '…' : bubble.name;
          return <g key={bubble.id} tabIndex={0} className={bubble.total >= 8 ? 'bubble-high' : bubble.total >= 4 ? 'bubble-medium' : 'bubble-low'}>
            <title>{bubble.name}，已完成 {bubble.completed} / {bubble.total}</title>
            <circle cx={bubble.x} cy={bubble.y} r={bubble.radius}
              fill={`url(#${gradientId}-${bubble.total >= 8 ? 'high' : bubble.total >= 4 ? 'medium' : 'low'})`} />
            {bubble.radius >= 24 ? <>
              <text x={bubble.x} y={bubble.y - fontSize * 0.25} textAnchor="middle" fontSize={fontSize} fontWeight="600">{name}</text>
              <text x={bubble.x} y={bubble.y + fontSize * 1.15} textAnchor="middle" fontSize={fontSize}>{bubble.completed} / {bubble.total}</text>
            </> : null}
          </g>;
        })}
      </svg> : <div className="workload-empty muted">暂无任务数据</div>}
      <dl className="workload-summary">
        <div><dt>总任务数</dt><dd>{total}</dd></div>
        <div><dt>已完成</dt><dd>{completed}</dd></div>
        <div><dt>整体完成率</dt><dd>{total ? Math.round(completed / total * 100) : 0}%</dd></div>
      </dl>
    </div>
    <div className="workload-legend"><span><i className="bubble-high" />工作量高（≥8）</span><span><i className="bubble-medium" />中等（4–7）</span><span><i className="bubble-low" />较低（≤3）</span></div>
  </>;
}

// ---------- 团队区 ----------
function RecentResults({ rows, preview }: { rows: Json[]; preview: boolean }) {
  const [file,setFile]=useState<Json|null>(null);
  const products: (Json & { file: Json; key: string })[] = rows.filter(row=>row.accepted).flatMap(row => {
    const details: Json[] = Array.isArray(row.fileDetails) ? row.fileDetails : (row.files ?? []).map((name: string) => ({ name }));
    return details.map((file, index) => ({ ...row, file, key: `${S(row.id)}-${index}` }));
  }).slice(0, 4);
  return <section className="personal-panel recent-results-panel">
    <header>
      <h2 className="panel-h"><TeamPanelIcon kind="results" />近期成果展示</h2>
      <a href="/task?scope=team&teamStatus=done">查看全部 →</a>
    </header>
    {products.length ? <div className="recent-results-strip">
      {products.map(product => {
        const extension = S(product.file.name).split('.').pop()?.toUpperCase() ?? '';
        const format = ['PDF','DOCX','DOC','XLSX','XLS','PPTX','PPT','MD','TXT'].includes(extension) ? extension : 'FILE';
        const content = <>
          <div className={`result-file-preview result-format-${format.toLowerCase()}`} aria-hidden="true">
            <span>{format}</span><i /><i /><i /><i />
          </div>
          <div className="recent-result-info">
            <strong title={S(product.file.name)}>{S(product.file.name, '交付成果')}</strong>
            <span className="result-task" title={S(product.task)}>{S(product.task)}</span>
            <div><Pill status="completed">已验收</Pill></div>
            <div className="result-delivery"><span title="最终经手人"><Avatar name={S(product.who)} />{S(product.who, '—')}</span>
              <time dateTime={S(product.at)} title={S(product.at)}>{product.at ? new Date(S(product.at)).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }) : '—'}</time>
            </div>
          </div>
        </>;
          return !preview && product.file.file_id
            ? <button type="button" className="recent-result" key={product.key} onClick={()=>setFile(product.file)}>{content}</button>
            : <article className="recent-result" key={product.key}>{content}</article>;
      })}
    </div> : <div className="muted result-empty">暂无交付成果</div>}
    {file?<FilePreviewModal fileId={S(file.file_id)} title={S(file.name)} onClose={()=>setFile(null)}/>:null}
  </section>;
}

function Relay({ rows, preview = false }: { rows: Json[]; preview?: boolean }) {
  const openTask=useContext(DashboardTaskAction);
  const members = useQ<Json[]>(['members'], '/organizations/members', undefined, { enabled: !preview });
  const people = members.data ?? [];
  const avatars = new Map(people.map(member => [S(member.user_id ?? member.id), avatarSource(member.avatar)]));
  function relayAvatar(id: unknown, name: unknown, savedAvatar: unknown) {
    const byId = avatars.get(S(id));
    if (byId) return byId;
    if (savedAvatar) return avatarSource(savedAvatar);
    const matches = people.filter(member => S(member.display_name ?? member.name) === S(name));
    return matches.length === 1 ? avatarSource(matches[0].avatar) : undefined;
  }
  if (!rows.length) return <div className="relay-empty muted">暂无协作接力任务</div>;
  return <div className="team-relay-list">
    {rows.slice(0, 5).map((row, index) => {
      const milliseconds = Number(row.processingMs) || 0;
      const minutes = Math.floor(milliseconds / 60000);
      const duration = milliseconds <= 0 ? '未计时' : minutes < 1 ? '不足1分钟' : minutes < 60 ? `${minutes}分钟` : `${Math.floor(minutes / 60)}小时${minutes % 60 ? `${minutes % 60}分钟` : ''}`;
      return <div className="team-relay-row" key={S(row.task_id, index)}>
        <div className="team-relay-task">
          {row.task_id && !preview ? <a href={`/task?scope=team&focus=${encodeURIComponent(S(row.task_id))}`} onClick={e=>{e.preventDefault();if(!preview)openTask(S(row.task_id));}}>{S(row.task)}</a> : <strong>{S(row.task)}</strong>}
          <span className="relay-duration">处理时长 {duration}</span>
        </div>
        <div className="team-relay-people"><span><Avatar name={S(row.from)} src={preview ? avatarSource(row.from_avatar) : relayAvatar(row.from_id, row.from, row.from_avatar)} /><b>{S(row.from, '—')}</b></span><span className="relay-person-arrow" aria-hidden="true">→</span><span><Avatar name={S(row.to)} src={preview ? avatarSource(row.to_avatar) : relayAvatar(row.to_id, row.to, row.to_avatar)} /><b>{S(row.to, '—')}</b></span></div>
        <Pill status={S(row.status, 'in_progress')} />
      </div>;
    })}
  </div>;
}

// ---------- 日历 + 当天日程（联动）----------
function CalendarAndAgenda({ cal, scope }: { cal: Json; scope: string }) {
  const [ym, setYm] = useState(() => ({ y: (cal?.year as number) || new Date().getFullYear(), m: (cal?.month as number) || new Date().getMonth() + 1 }));
  const [sel, setSel] = useState<string>(todayStr());
  const days = (cal?.days ?? []) as Json[];
  const agenda = useQ<{ date: string; tasks: Json[] }>(['dashboard', 'agenda', scope, sel], '/dashboard/agenda', { scope, date: sel }, { enabled: !!sel });
  const first = (cal?.firstWeekday as number) || 0;
  const padCells: (null | Json)[] = [];
  for (let i = 0; i < first; i++) padCells.push(null);
  for (const dd of days) padCells.push(dd);
  const shiftMonth = (delta: number) => { let m2 = ym.m + delta, y2 = ym.y; if (m2 < 1) { m2 = 12; y2--; } if (m2 > 12) { m2 = 1; y2++; } setYm({ y: y2, m: m2 }); };
  const now = new Date(); const isCurMonth = ym.y === now.getFullYear() && ym.m === now.getMonth() + 1;
  return (
    <div className="card cal-card">
      <div className="cal-head">
        <b>{isCurMonth ? `${ym.y} 年 ${ym.m} 月` : `${ym.y} 年 ${ym.m} 月`}</b>
        <span className="cal-nav"><button onClick={() => shiftMonth(-1)} aria-label="上一月">‹</button><button onClick={() => setYm({ y: now.getFullYear(), m: now.getMonth() + 1 })} className="cal-today" aria-label="回到本月">今天</button><button onClick={() => shiftMonth(1)} aria-label="下一月">›</button></span>
      </div>
      <div className="cal-grid">
        {['一', '二', '三', '四', '五', '六', '日'].map((w) => <span key={w} className="cal-wd">{w}</span>)}
        {padCells.map((c, i) => c === null ? <span key={'e' + i} className="cal-cell blank" /> : (
          <button key={String((c as Json).date)} className={`cal-cell${String((c as Json).date) === (cal?.today ?? todayStr()) ? ' today' : ''}${String((c as Json).date) === sel ? ' sel' : ''}`}
            onClick={() => setSel(String((c as Json).date))} aria-label={String((c as Json).date)}>
            <span className="cal-num">{Number(String((c as Json).date).slice(8))}</span>
            <span className="cal-dots">{Array.from({ length: Math.min(4, Number((c as Json).count) || 0) }).map((_, k) => <i key={k} className={((c as Json).overdue && k === 0) ? 'red' : ''} />)}</span>
          </button>
        ))}
      </div>
      <div className="agenda-head"><b>{sel.slice(5).replace('-', '/')} · {scope === 'team' ? '团队' : '我的'}任务日程</b></div>
      <div className="agenda">
        {(agenda.data?.tasks ?? []).length ? (agenda.data?.tasks ?? []).map((t) => (
          <button className="agenda-row" key={S(t.id)} onClick={() => { window.location.href = `/task?focus=${S(t.id)}`; }}>
            <span className="agenda-time">{t.scheduled && t.schedule_start ? S(t.schedule_start) : '待排期'}</span>
            <span className="agenda-body"><span className="agenda-title truncate">{S(t.title)}</span><span className="agenda-meta muted small">{S(t.assignee_name, '未指派')} · {S(t.priority_label, 'T2')}</span></span>
            <span className="agenda-go">查看 →</span>
          </button>
        )) : <div className="muted small" style={{ padding: '8px 2px' }}>这一天没有排期或到期的任务。</div>}
      </div>
    </div>
  );
}

