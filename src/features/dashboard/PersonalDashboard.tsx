import { WeatherMark } from './WeatherMark';
import { tasksOnDate, scheduledTasksOnDate, dailyAgenda, priorityFocus } from './calendar-data';
import { useContext, useEffect, useRef, useState } from 'react';
import { useQ, usePersistentState, type Json } from '../../api/hooks';
import { useSession } from '../../app/session';
import { DashboardTaskAction } from './task-actions';
import { Pill, Err } from '../../components/ui';

export const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const text = (v: unknown, fallback = '—') => v == null || v === '' ? fallback : String(v);
// 优先级 → 圆点颜色 / 排序权重（T0 最高最醒目，T3 最低最绿），与任务页 priority-T* 同色系
const PRI_COLOR: Record<string, string> = { T0: '#c0392b', T1: '#d9803f', T2: '#d4a72c', T3: '#5c9c72' };
const PRI_ORDER: Record<string, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };
const taskLink = (t: Json) => `/task?tab=${({pending_accept:'receive',accepted:'work',in_progress:'work',pending_review:'review'} as Record<string,string>)[text(t.status)] ?? 'create'}&focus=${encodeURIComponent(text(t.id))}`;
function previewTasks(): Json[] {
  const active = ['整理客户门户权限矩阵','与产品团队对齐需求','编写上线评估文档','季度版本发布'].map((title,i) => { const day=new Date(); day.setDate(day.getDate()+(i===3?4:0)); return {id:`demo-${i}`,title,status:['in_progress','pending_accept','pending_review','in_progress'][i],priority_label:i===0?'T1':'T2',assignee_name:'示例成员',schedule_date:localDay(day),schedule_start:['09:00','11:00','14:00','16:00'][i],schedule_end:['10:00','12:00','16:00','17:00'][i],due_at:localDay(day),progress:[70,0,90,40][i]}; });
  const finished = ['客户门户需求评审完成','团队知识库首版交付','协作权限方案验收','季度运营报告发布'].map((title,i) => {
    const day = new Date(); day.setDate(day.getDate()-i-1); day.setHours(16-i,30,0,0);
    return {id:`demo-milestone-${i}`,title,status:'completed',priority_label:i===0?'T1':'T2',assignee_name:['示例成员一','示例成员二','示例成员三','示例成员四'][i],completed_at:day.toISOString(),updated_at:day.toISOString(),due_at:localDay(day),progress:100};
  });
  return [...active, ...finished];
}
export function useDashboardClock() {
  const [now,setNow]=useState(()=>new Date());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(new Date()),60000);return()=>window.clearInterval(timer);},[]);
  return now;
}
export function DashboardWelcome({now}: {now:Date}) {
  const {me}=useSession(); const h=now.getHours();
  const greeting=h<12?'早上好':h<18?'下午好':'晚上好';
  return <section className="dashboard-welcome"><h1><WeatherMark />{greeting}，{me?.user.display_name ?? '伙伴'}</h1></section>;
}

function MetricIcon({index}: {index:number}) {
  const paths=[
   'M5 4h14v17H5zM9 2v4m6-4v4M8 11h3m-3 4h6M14 10l2 2 4-4',
   'M14 5.5a6 2.5 0 1 1-12 0 6 2.5 0 1 1 12 0ZM2 5.5v11c0 1.4 2.7 2.5 6 2.5m6-13.5V8M2 9c0 1.4 2.7 2.5 6 2.5m-6 1c0 1.4 2.7 2.5 6 2.5M22 11a6 2.5 0 1 1-12 0 6 2.5 0 1 1 12 0Zm-12 0v8c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-8m-12 4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5',
   'M9 3h6M12 7v6l3 2M20 14a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    'M16.36 4.5A9 9 0 1 0 19.5 7.5M8 12l3.2 3.4L19.2 6.8'
  ];
 return <span className="metric-icon"><svg width="26" height="26" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[index]}/></svg></span>;
}
function SecIcon({d}:{d:string}) {
  return <svg className="panel-h-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d}/></svg>;
}
export function PersonalDashboard({d,preview,now,period}: {d:Json;preview:boolean;now:Date;period:string}) {
  const [trendPeriod,setTrendPeriod]=usePersistentState('dashboard.trend-period','14');
  const insights=useQ<Json>(['dashboard-insights',period,trendPeriod],'/dashboard/insights',{period,days:trendPeriod},{enabled:!preview,refetchMs:30000});
  const today=localDay(now); const current=useQ<{items:Json[]}>(['dashboard-personal-tasks'], '/tasks', {scope:'mine',limit:500});
  const completed=useQ<{items:Json[]}>(['dashboard-personal-completed'], '/tasks', {scope:'mine',tab:'done',limit:500});
  const daily=useQ<{tasks:Json[]}>(['dashboard','agenda','mine',today],'/dashboard/agenda',{scope:'mine',date:today},{refetchMs:30000});
  const tasks=preview?previewTasks():[...(current.data?.items ?? []),...(completed.data?.items ?? [])];
  const agenda=preview?tasksOnDate(tasks,today):daily.data?.tasks ?? [];
  const k=d.kpi ?? {}; const series=(d.series ?? []) as Json[];
  const total=tasks.length; const done=tasks.filter(t=>t.status==='completed').length;
  const late=tasks.filter(t=>t.status!=='completed'&&t.status!=='cancelled'&&t.due_at&&String(t.due_at).slice(0,10)<today).length;
  const work=tasks.filter(t=>['accepted','in_progress','pending_review'].includes(t.status)&&!(t.due_at&&String(t.due_at).slice(0,10)<today)).length;
  const pending=total-done-late-work;
  const milestones=tasks.filter(t=>t.status==='completed').sort((a,b)=>String(b.completed_at ?? b.updated_at ?? '').localeCompare(String(a.completed_at ?? a.updated_at ?? ''))).slice(0,4);
  const metrics=[{name:'今日任务数',value:agenda.length,unit:'项',note:'今日排期或到期',values:series.map(s=>Number(s.done)||0)}, {name:'Tokens 消耗量',value:Number(k.token?.total ?? 0)>=1000?`${(Number(k.token.total)/1000).toFixed(1)}k`:Number(k.token?.total ?? 0),unit:'tokens',note:`输入 ${Number(k.token?.in ?? 0).toLocaleString()}`,values:series.map(s=>Number(s.token)||0)}, {name:'平均耗时',value:k.avg?.hours ?? 0,unit:'小时 / 项',note:`参考目标 ${k.avg?.target ?? 4} 小时`,values:[Number(k.avg?.target)||4,Number(k.avg?.hours)||0]}, {name:'交付完成度',value:`${k.completion?.pct ?? 0}%`,unit:'',note:`已验收 ${k.completion?.accepted ?? 0} / ${k.completion?.total ?? 0}`,values:[]}];
  const groups=[{name:'进行中',n:work,color:'#2d7758'},{name:'已完成',n:done,color:'#8ebd9b'},{name:'待开始',n:pending,color:'#d8dfd8'},{name:'已逾期',n:late,color:'#edb578'}];
  const ring=groups.reduce((a,g)=>{const prev=a.at(-1)?.end ?? 0;return [...a,{...g,start:prev,end:prev+(total?g.n/total*100:0)}];},[] as Array<{name:string;n:number;color:string;start:number;end:number}>);
  const demoDays=Array.from({length:Number(trendPeriod)},(_,i)=>{const date=new Date(now);date.setDate(date.getDate()-Number(trendPeriod)+i+1);return {label:`${date.getMonth()+1}/${date.getDate()}`,created:[3,5,2,4,6,3,7][i%7],done:[2,3,1,4,5,2,6][i%7],token:[1200,2300,1800,3400,2800][i%5],avg:[3.2,2.8,3.5,2.1,1.8][i%5]};});
  const chartSeries=(preview?demoDays:(insights.data?.daily ?? d.insights?.daily?.slice(-Number(trendPeriod))) ?? []) as Json[];
  const liveInsights=insights.data ?? d.insights;
  const stats=preview?{today:agenda.length,token:86400,avg:3.2,pct:83}:liveInsights?.metrics ?? {};
  const changes=preview?{today:-20,token:12,avg:-15,pct:8}:liveInsights?.changes ?? {};
  const dailyPhases=preview?{pending:1,work:1,done:1,overdue:0}:liveInsights?.phases ?? {};

  return <>
    {!preview && insights.isError && !d.insights ? <Err>看板统计加载失败，请刷新或重启服务。{String((insights.error as Error)?.message ?? '')}</Err> : null}
    <OverviewMetrics loading={!preview && !liveInsights} stats={stats} changes={changes} dailyPhases={dailyPhases} chartSeries={chartSeries}/>

    <div className="personal-dashboard-grid"><div className="personal-dashboard-main">
      <section className="personal-panel"><header><h2 className="panel-h"><SecIcon d="M3 17l6-6 4 4 8-9m-5 0h5v5"/>任务趋势</h2><select aria-label="趋势范围" value={trendPeriod} onChange={e=>setTrendPeriod(e.target.value)}><option value="7">近一周</option><option value="14">近两周</option><option value="30">近一月</option></select></header><div className="trend-legend"><span className="legend-created"><i/>创建任务</span><span className="legend-done"><i/>完成任务</span></div><TaskTrend data={chartSeries}/></section>
      <div className="personal-dashboard-bottom"><section className="personal-panel"><header><h2 className="panel-h"><SecIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8"/>今日重点</h2><a href="/task?tab=work">查看全部 →</a></header>{daily.isError&&!preview?<p>日程暂时无法加载</p>:<TaskRows tasks={priorityFocus(agenda)} preview={preview}/>}</section>
      <section className="personal-panel"><header><h2 className="panel-h"><SecIcon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v9h9"/>任务状态分布</h2></header><div className="status-layout"><StatusRing groups={groups} total={total}/><div className="status-key">{groups.map(g=><div key={g.name}><i style={{background:g.color}}/>{g.name}<b>{g.n}</b><span>{total?Math.round(g.n/total*100):0}%</span></div>)}</div></div></section>
      <section className="personal-panel milestone-panel"><header><h2 className="panel-h"><SecIcon d="M5 21V4q4-2 7 0t7 0v10q-4 2-7 0t-7 0"/>近期里程碑</h2><a href="/task?history=1">查看全部 →</a></header><MilestoneRows tasks={milestones} preview={preview}/></section></div>
      {(current.isError||completed.isError)&&!preview ? <p className="panel-caption">部分任务加载失败，状态分布暂不完整。</p>:null}
    </div><PersonalCalendar tasks={tasks} today={today} preview={preview}/></div>
  </>;
}
export function smoothPath(points: number[][]): string {return points.map((p,i)=>{if(!i)return `M${p[0]},${p[1]}`;const prev=points[i-1],mid=(prev[0]+p[0])/2;return `C${mid},${prev[1]} ${mid},${p[1]} ${p[0]},${p[1]}`;}).join(' ');}
function StatusRing({groups,total}:{groups:{name:string;n:number;color:string}[];total:number}) {
  const [active,setActive]=useState(-1);let offset=0;
  return <div className="status-ring interactive-status-ring"><svg viewBox="0 0 160 160" role="img" aria-label="任务状态分布"><circle cx="80" cy="80" r="60" fill="none" stroke="var(--line)" strokeWidth="20"/>{groups.map((g,i)=>{const length=total?g.n/total*377:0;const start=offset;offset+=length;return g.n?<circle key={g.name} className="status-ring-segment" tabIndex={0} onMouseEnter={()=>setActive(i)} onMouseLeave={()=>setActive(-1)} onFocus={()=>setActive(i)} onBlur={()=>setActive(-1)} cx="80" cy="80" r="60" fill="none" stroke={g.color} strokeWidth={active===i?26:20} strokeDasharray={`${Math.max(0,length-2)} ${377-length+2}`} strokeDashoffset={-start} transform="rotate(-90 80 80)"><title>{g.name} {g.n} 项 · {Math.round(g.n/total*100)}%</title></circle>:null;})}</svg><div><strong>{active<0?total:groups[active].n}</strong><span>{active<0?'总任务数':groups[active].name}</span></div></div>;
}
function TaskPhaseBar({phases}: {phases:Json}) {const keys=['pending','work','done','overdue'];const colors=['#cfdad1','#387b5b','#9ac8a7','#e5b381'];const names=['待开始','进行中','已完成','已逾期'];const total=keys.reduce((n,k)=>n+Number(phases[k]??0),0);return <div className="today-phase-bar" role="img" aria-label={keys.map((k,i)=>`${names[i]} ${phases[k]??0}`).join('，')}>{total?keys.map((k,i)=><span key={k} style={{width:`${Number(phases[k]??0)/total*100}%`,background:colors[i]}} title={`${names[i]} ${phases[k]??0}`}/>):<span style={{width:'100%',background:'#e4ebe4'}}/>}</div>;}
function RoundedRing({value}: {value:number}) {return <svg className="rounded-metric-ring" viewBox="0 0 90 90" role="img" aria-label={`完成度 ${value}%`}><circle cx="45" cy="45" r="33" fill="none" stroke="#e1ece3" strokeWidth="9"/><circle cx="45" cy="45" r="33" fill="none" stroke="#3c8960" strokeWidth="9" strokeLinecap="round" strokeDasharray={`${Math.max(0,Math.min(100,value))/100*207.35} 207.35`} transform="rotate(-90 45 45)"/></svg>;}
function MiniChart({values,bars=false}: {values:number[];bars?:boolean}) {const vals=values.length?values:Array(5).fill(0);const max=Math.max(1,...vals);const points=vals.map((v,i)=>[8+i*84/Math.max(1,vals.length-1),56-v/max*44]);const path=smoothPath(points);return <svg className="metric-mini" viewBox="0 0 100 64" role="img" aria-label={bars?'近五日平均耗时':'近五日 Token 用量'}>{bars?vals.map((v,i)=><rect key={i} x={i*20+5} y={58-v/max*48} width="11" height={v/max*48} rx="3" fill={i===4?'#4f9469':'#b7d6bf'}><title>{v.toFixed(1)} 小时</title></rect>):<><path d={`${path} L92,61 L8,61 Z`} fill="#edf5ec"/><path d={path} fill="none" stroke="#68a47e" strokeWidth="1.8"/>{points.map((p,i)=><circle key={i} cx={p[0]} cy={p[1]} r="2" fill="#68a47e"><title>{vals[i]} tokens</title></circle>)}</>}</svg>;}
function TaskTrend({data}: {data:Json[]}) {
 const max=Math.max(1,...data.flatMap(s=>[Number(s.created)||0,Number(s.done)||0]));
 const chart = useRef<SVGSVGElement>(null);
 const [chartWidth, setChartWidth] = useState(660);
 useEffect(() => {
   const node = chart.current;
   if (!node) return;
   const observer = new ResizeObserver(([entry]) => setChartWidth(Math.max(1, entry.contentRect.width)));
   observer.observe(node);
   return () => observer.disconnect();
 }, []);
 const step=(chartWidth-44)/Math.max(1,data.length),width=Math.min(14,step*.36);
 const pts=data.map((s,i)=>[30+(i+.5)*step,180-(Number(s.created)||0)/max*145]);const path=smoothPath(pts);
 const tickStep=max<=8?1:Math.ceil(max/8);const yTicks:number[]=[];for(let t=0;t<=max;t+=tickStep)yTicks.push(t);const yVal=(t:number)=>180-t/max*145;
 return <svg ref={chart} className="personal-trend" viewBox={`0 0 ${chartWidth} 216`} role="img" aria-label="创建任务为浅绿、完成任务为深绿的双柱图及创建趋势">
  <defs>
   <linearGradient id="task-created-gradient" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#92c6a7"/><stop offset=".48" stopColor="#b6dac3" stopOpacity=".85"/><stop offset="1" stopColor="#a5cdb4" stopOpacity=".8"/></linearGradient>
   <linearGradient id="task-done-gradient" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#216b4b"/><stop offset=".48" stopColor="#428f68" stopOpacity=".9"/><stop offset="1" stopColor="#65a27e" stopOpacity=".8"/></linearGradient>
   <linearGradient id="task-area-gradient" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#99c9ac" stopOpacity=".5"/><stop offset=".6" stopColor="#c7e3d0" stopOpacity=".18"/><stop offset="1" stopColor="#a2c9b2" stopOpacity=".18"/></linearGradient>
  </defs>
   <g stroke="#eceff1">{yTicks.map(t=>{const y=yVal(t);return <g key={t}><path d={`M30 ${y}H${chartWidth-14}`}/><text x="8" y={y+4} fill="#8b949c" stroke="none" fontSize="13">{t}</text></g>;})}</g>
  {data.length?<path d={`${path} L${pts.at(-1)![0]},180 L${pts[0][0]},180 Z`} fill="url(#task-area-gradient)"/>:null}
  {data.map((s,i)=>{const x=pts[i][0];return <g key={i}>{['created','done'].map((key,j)=>{const bh=Number(s[key]??0)/max*145,bx=x+(j?1.5:-width-1.5),by=180-bh,r=Math.min(width/2,bh);return bh>.5?<path key={key} data-series={key} d={`M${bx},180V${by+r}Q${bx},${by} ${bx+r},${by}H${bx+width-r}Q${bx+width},${by} ${bx+width},${by+r}V180Z`} fill={j?'url(#task-done-gradient)':'url(#task-created-gradient)'}><title>{s.label} {j?'完成':'创建'} {s[key]??0} 项</title></path>:null;})}{i%Math.max(1,Math.ceil(data.length / Math.max(1, Math.floor((chartWidth-44)/46))))===0?<text x={x} y="204" textAnchor="middle" fontSize="13" fill="#879889">{s.label}</text>:null}</g>})}
  <path className="trend-line" d={path} fill="none" stroke="#76ab8d" strokeWidth="2"/>
 </svg>;
}

function TaskRows({tasks,preview,showAction=false}: {tasks:Json[];preview:boolean;showAction?:boolean}) {
  const openTask=useContext(DashboardTaskAction);
  const deadline=(task:Json)=>{
    if(!task.due_at)return '未设截止时间';
    const raw=String(task.due_at);if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return `截止 ${raw.slice(5).replace('-','/')}`;
    const d=new Date(raw);return Number.isFinite(+d)?`截止 ${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:'未设截止时间';
  };
  if (!tasks.length) return <p className="personal-empty">{showAction?'暂无当日排期':'今日暂无重点任务'}</p>;
  return <div className={`focus-list${showAction?' agenda-list':''}`}>{tasks.slice(0,4).map(t=>{
    const priority=text(t.priority_label,'T2');
    const content=showAction?<><span className="timeline-node"/><time className="focus-time">{text(t.schedule_start)}</time><span className="focus-body"><b title={text(t.title)}>{text(t.title)}</b><small>{t.schedule_end?`至 ${t.schedule_end} · `:''}{priority}</small></span></>:<><span className={`focus-priority priority-${priority}`} style={{color:PRI_COLOR[priority]}}>{priority}</span><span className="focus-body"><b title={text(t.title)}>{text(t.title)}</b><small>{deadline(t)}</small></span></>;
    return showAction ? <div className="focus-task agenda-task" key={text(t.id)}>{content}<a className="agenda-view" href={preview?undefined:taskLink(t)} onClick={e=>{e.preventDefault();if(!preview)openTask(text(t.id));}} aria-label={`查看任务：${text(t.title)}`} aria-disabled={preview}>查看</a></div> : <a className="focus-task focus-priority-task" key={text(t.id)} href={preview?undefined:taskLink(t)} onClick={e=>{e.preventDefault();if(!preview)openTask(text(t.id));}} aria-disabled={preview}>{content}<Pill status={text(t.status)}/></a>;
  })}</div>;
}
function MilestoneRows({tasks,preview}: {tasks:Json[];preview:boolean}) {
  const openTask=useContext(DashboardTaskAction);
  if (!tasks.length) return <p className="personal-empty">暂时没有已完成的任务</p>;
  return <div className="milestone-check-list">{tasks.map(task => {
    const date = text(task.completed_at ?? task.updated_at, '').slice(0, 10);
    return <a className="milestone-check-row" key={text(task.id)} href={preview ? undefined : taskLink(task)} onClick={e=>{e.preventDefault();if(!preview)openTask(text(task.id));}} aria-disabled={preview}>
      <span className="milestone-check"><SecIcon d="m6 12 4 4 8-8"/></span>
      <strong title={text(task.title)}>{text(task.title)}</strong>
      {date && <time dateTime={date}>{date.slice(5).replace('-', '/')}</time>}
    </a>;
  })}</div>;
}
function PersonalCalendar({tasks,today,preview}: {tasks:Json[];today:string;preview:boolean}) {
 const [month,setMonth]=useState(()=>today.slice(0,7));const [selected,setSelected]=useState(today);const [y,m]=month.split('-').map(Number);const first=(new Date(y,m-1,1).getDay()+6)%7;const count=new Date(y,m,0).getDate();
 const calendar=useQ<Json>(['dashboard-calendar',month],'/dashboard/calendar',{scope:'mine',month},{enabled:!preview,refetchMs:30000});
 const agenda=useQ<{tasks:Json[]}>(['dashboard','agenda','mine','responsible',selected],'/dashboard/agenda',{scope:'mine',date:selected,responsible:'1'},{enabled:!preview,refetchMs:15000});
 const change=(delta:number)=>{const next=new Date(y,m-1+delta,1);const key=localDay(next);setMonth(key.slice(0,7));setSelected(key);};
 const rows=dailyAgenda(preview?tasks:agenda.data?.tasks??[],selected);
 return <aside className="personal-calendar"><section className="personal-panel"><header><h2 className="panel-h"><SecIcon d="M7 5h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm1-2v4m8-4v4M4 10h16m-12 4h.1m4 0h.1m4 0h.1m-8.3 3h.1m4 0h.1m4 0h.1"/>{y} 年 {m} 月</h2><div className="calendar-actions"><button aria-label="上一月" onClick={()=>change(-1)}>‹</button><button onClick={()=>{setMonth(today.slice(0,7));setSelected(today);}}>今天</button><button aria-label="下一月" onClick={()=>change(1)}>›</button></div></header><div className="personal-calendar-grid">{['一','二','三','四','五','六','日'].map(w=><span key={w} className="calendar-weekday">{w}</span>)}{Array.from({length:first},(_,i)=><span key={`pad-${i}`}/>)}{Array.from({length:count},(_,i)=>{const date=`${month}-${String(i+1).padStart(2,'0')}`;const dayTasks:Json[]=preview?scheduledTasksOnDate(tasks,date):(calendar.data?.days?.find((d:Json)=>d.date===date)?.tasks??[]).map((t:Json)=>({...t,priority_label:t.priority}));const dots=[...dayTasks].sort((a,b)=>(PRI_ORDER[text(a.priority_label,'T2')]??9)-(PRI_ORDER[text(b.priority_label,'T2')]??9)).slice(0,3);return <button key={date} title={dayTasks.length?`${dayTasks.length} 项任务 · ${dayTasks.map(t=>text(t.priority_label)).join('、')}`:date} aria-label={dayTasks.length?`${date} · ${dayTasks.length} 项任务`:date} aria-pressed={date===selected} aria-current={date===today?'date':undefined} onClick={()=>setSelected(date)}><span>{i+1}</span>{dots.length?<span className="calendar-task-dots" aria-hidden="true">{dots.map((t,k)=><i key={k} style={{background:PRI_COLOR[text(t.priority_label,'T2')]??'#7f9b7a'}}/>)}</span>:null}</button>;})}</div>{calendar.isError&&!preview?<p className="panel-caption">日历任务标记加载失败，请稍后重试。</p>:null}<div className="joined-agenda"><header><div className="agenda-heading"><h2>我的日程</h2><span className="panel-caption">{selected.slice(5).replace('-','月')}日</span></div><a href="/task?tab=work">查看全部 →</a></header>{agenda.isError&&!preview?<p>日程加载失败</p>:agenda.isLoading&&!preview?<p>正在加载日程…</p>:<div className="agenda-fit-list"><TaskRows tasks={rows} preview={preview} showAction/></div>}</div></section></aside>;
}

function OverviewMetrics({stats,changes,dailyPhases,chartSeries,loading=false}:{stats:Json;changes:Json;dailyPhases:Json;chartSeries:Json[];loading?:boolean}) {
  const displayMetrics=[ {name:'今日任务数',key:'today',unit:'项',value:stats.today}, {name:'Tokens 消耗量',key:'token',unit:'tokens',value:stats.token==null?undefined:stats.token>=1000?`${(stats.token/1000).toFixed(1)}k`:stats.token}, {name:'平均耗时',key:'avg',unit:'小时 / 项',value:stats.avg}, {name:'交付完成度',key:'pct',unit:'%',value:stats.pct}];
  return <div className="personal-metrics">{displayMetrics.map((m,i)=>{
    const change=changes[m.key];
    // 上一期分母为 0 时服务端返回 null，此时不显示环比。
    const zeroTokenBaseline=m.key==='token'&&change===null&&stats.token!=null;
    const tokenAdded=Number(stats.token)>=1000?`${(Number(stats.token)/1000).toFixed(1)}k`:String(stats.token??0);
    const comparison=zeroTokenBaseline
      ? Number(stats.token)>0?`新增 ${tokenAdded}`:'持平 0%'
      : change==null?'暂无可比数据':`${Number(change)>0?'↑':Number(change)<0?'↓':'—'} ${Math.abs(Number(change))}${i===3?' 个百分点':'%'}`;
    const caption=zeroTokenBaseline&&Number(stats.token)>0?'上期为 0':i===0?'较昨日':'较上期';
    const comparisonTitle=zeroTokenBaseline?`上期 Token 用量为 0，本期 ${Number(stats.token).toLocaleString()} tokens`:i===0?'较昨日；按当前任务记录计算':i===3?'较上一周期，单位百分点':'较上一完整周期';
    return <section className={`personal-metric metric-${m.key}`} key={m.key}>
      <header><MetricIcon index={i}/><span>{m.name}</span></header>
      <div className="personal-metric-bottom"><div className="metric-value"><strong>{loading?'—':m.value??'—'}</strong><small>{m.unit}</small></div>
        <p className={`metric-change ${Number(change)<0?'fall':'rise'}`} title={comparisonTitle}>{comparison}<span>{caption}</span></p>
        {i===0?<TaskPhaseBar phases={dailyPhases}/>:i===3?<RoundedRing value={Number(stats.pct)||0}/>:<MiniChart values={chartSeries.slice(-5).map(s=>Number(i===1?s.token:s.avg)||0)} bars={i===2}/>}</div>
    </section>;
  })}</div>;
}

export function TeamMetrics({preview,period,d}:{preview:boolean;period:string;d:Json}) {
 const q=useQ<Json>(['dashboard-team-insights',period],'/dashboard/insights',{scope:'team',period,days:7},{enabled:!preview,refetchMs:30000});
 const liveInsights=q.data ?? d.insights;
 const stats=preview?{today:16,token:d.kpi?.token?.total??0,avg:d.kpi?.avg?.hours??0,pct:d.kpi?.completion?.pct??0}:liveInsights?.metrics??{};
 return <>{q.isError&&!preview&&!liveInsights?<Err>团队看板统计加载失败，请刷新或重启服务。</Err>:null}<OverviewMetrics loading={!preview&&!liveInsights} stats={stats} changes={preview?{today:20,token:12,avg:-10,pct:8}:liveInsights?.changes??{}} dailyPhases={preview?{pending:4,work:6,done:5,overdue:1}:liveInsights?.phases??{}} chartSeries={preview?Array.from({length:5},(_,i)=>({token:[2400,3200,2800,4600,4100][i],avg:[4,3.7,2.8,3.4,3.2][i]})):liveInsights?.daily??[]}/></>;
}


