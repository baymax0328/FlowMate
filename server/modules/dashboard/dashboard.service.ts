// FlowMate · 看板（Dashboard）：从真实任务 / 用量 / 事件 / 提交聚合，随其它页面数据变化而联动。
// scope=mine|team（mine 只看与我相关；team 看全组织），period=day|week|month。
// Token 按 usage_records.user_id 归属过滤；在线时长按「有活跃事件/消息的 5 分钟时段」估算（真实派生，非写死）。
import { Injectable } from '@nestjs/common';
import { getDb, j, nowIso } from '../../core/db';
import type { Json } from '../../core/contracts';
import type { Actor } from '../../core/permissions';

function pad(n: number) { return String(n).padStart(2, '0'); }
function ymd(d: Date) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function ymdFromIso(s: string) { return String(s || '').slice(0, 10); } // 用量/事件用 UTC ISO，取日部分足够做分桶
function hourKey(s: string) { return String(s || '').slice(11, 13); }

@Injectable()
export class DashboardService {
  private d = () => getDb();

  private buckets(period: string): { key: string; label: string; day: string; hour: string | null }[] {
    const now = new Date();
    if (period === 'month') {
      const y = now.getFullYear(), m = now.getMonth();
      const days = new Date(y, m + 1, 0).getDate();
      return Array.from({ length: days }, (_, i) => ({ key: ymd(new Date(y, m, i + 1)), label: String(i + 1), day: ymd(new Date(y, m, i + 1)), hour: null }));
    }
    if (period === 'week') {
      const dow = (now.getDay() + 6) % 7; const mon = new Date(now); mon.setDate(now.getDate() - dow);
      return Array.from({ length: 7 }, (_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); return { key: ymd(d), label: ['一', '二', '三', '四', '五', '六', '日'][i], day: ymd(d), hour: null }; });
    }
    const y = now.getFullYear(), m = now.getMonth(), da = now.getDate();
    return Array.from({ length: 13 }, (_, i) => { const h = i + 8; return { key: pad(h), label: `${pad(h)}:00`, day: ymd(new Date(y, m, da)), hour: pad(h) }; });
  }

  // 我的：与我相关（创建/负责/验收）；团队：全组织
  private mineSql = `(t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=?)`;
  async summary(actor: Actor, scope: 'mine' | 'team', period: string): Promise<Json> {
    const d = this.d();
    const p = period === 'month' || period === 'day' ? period : 'week';
    const bk = this.buckets(p);
    const isMine = scope === 'mine'; const u = actor.userId; const op = actor.orgId;
    const T = (extra = 't.status NOT IN (\'cancelled\')') => isMine
      ? d.all<Json>(`SELECT t.* FROM tasks t WHERE t.organization_id=? AND ${this.mineSql} AND ${extra}`, op, u, u, u)
      : d.all<Json>(`SELECT t.* FROM tasks t WHERE t.organization_id=? AND ${extra}`, op);
    const tasks = T();
    const nowMs = Date.now(), dayMs = 86400000;
    const dueTs = (t: Json) => (t.due_at ? Date.parse(String(t.due_at)) : null);

    const status = (t: Json) => String(t.status);
    const phases = {
      create: tasks.filter((t) => ['draft', 'ready_to_assign'].includes(status(t))).length,
      receive: tasks.filter((t) => status(t) === 'pending_accept').length,
      work: tasks.filter((t) => ['accepted', 'in_progress'].includes(status(t))).length,
      review: tasks.filter((t) => status(t) === 'pending_review').length,
    };
    const active = phases.work;

    // 交付完成度：完成(绿) / 可能延期(黄: 未完成且 ≤3 天内到期) / 超期(红: 未完成且已过期限) / 在轨(灰)
    let doneCnt = 0, onTime = 0, overdueDone = 0, atRisk = 0, overdue = 0, onTrack = 0;
    for (const t of tasks) {
      const st = status(t); const due = dueTs(t);
      if (st === 'completed') { doneCnt++; if (due && Date.parse(String(t.updated_at)) > due) overdueDone++; else onTime++; continue; }
      if (st === 'draft' || st === 'ready_to_assign') continue;
      if (due == null) { onTrack++; continue; }
      if (due < nowMs) overdue++;
      else if (due - nowMs <= 3 * dayMs) atRisk++;
      else onTrack++;
    }
    const total = onTime + overdueDone + atRisk + overdue + onTrack;

    // 平均任务耗时（完成的任务 updated-created）；目标固定 4h 用于对比条
    let sumMin = 0, durN = 0;
    for (const t of tasks) if (status(t) === 'completed') { const a = Date.parse(String(t.created_at)), b = Date.parse(String(t.updated_at)); if (a && b && b > a) { sumMin += (b - a) / 60000; durN++; } }
    const avgHours = durN ? Math.round((sumMin / durN / 60) * 10) / 10 : 0;

    // Token：mine 只算 user_id=我；team 全组织。分桶
    const tokRows = isMine
      ? d.all<{ c: string; i: number; o: number }>(`SELECT created_at c, COALESCE(input_tokens,0) i, COALESCE(output_tokens,0) o FROM usage_records WHERE organization_id=? AND user_id=?`, op, u)
      : d.all<{ c: string; i: number; o: number }>(`SELECT created_at c, COALESCE(input_tokens,0) i, COALESCE(output_tokens,0) o FROM usage_records WHERE organization_id=?`, op);
    let tokenIn = 0, tokenOut = 0;
    const tokenBy = new Map<string, number>();
    for (const b of bk) tokenBy.set(b.key, 0);
    for (const r of tokRows) {
      const k = p === 'day' ? hourKey(r.c) : ymdFromIso(r.c);
      tokenIn += Number(r.i); tokenOut += Number(r.o);
      if (tokenBy.has(k)) tokenBy.set(k, (tokenBy.get(k) ?? 0) + Number(r.i) + Number(r.o));
    }

    // 在线（活跃时段）：事件 + 消息（mine 再按人过滤）
    const evSql = isMine
      ? `SELECT occurred_at c FROM events WHERE organization_id=? AND actor_id=? UNION ALL SELECT created_at FROM messages WHERE created_at IS NOT NULL AND sender_id=?`
      : `SELECT occurred_at c FROM events WHERE organization_id=? UNION ALL SELECT created_at m FROM messages`;
    const evRows = isMine
      ? d.all<{ c: string }>(evSql, op, u, u)
      : d.all<{ c: string }>(evSql, op);
    const onlineBy = new Map<string, number>();
    for (const b of bk) onlineBy.set(b.key, new Set<string>().size);
    const slotMap = new Map<string, Set<string>>();
    for (const b of bk) slotMap.set(b.key, new Set());
    for (const r of evRows) { const c = String(r.c); const k = p === 'day' ? hourKey(c) : ymdFromIso(c); if (slotMap.has(k)) slotMap.get(k)!.add(c.slice(0, 16)); }
    for (const b of bk) onlineBy.set(b.key, (slotMap.get(b.key)?.size ?? 0) * 5);

    // 完成节奏：完成任务按天
    const doneBy = new Map<string, number>(); for (const b of bk) doneBy.set(b.key, 0);
    for (const t of tasks) if (status(t) === 'completed') { const k = ymdFromIso(String(t.updated_at)); if (doneBy.has(k)) doneBy.set(k, doneBy.get(k)! + 1); }

    const createdBy = new Map<string, number>();
    for (const t of tasks) { const key = ymdFromIso(String(t.created_at)); createdBy.set(key, (createdBy.get(key) ?? 0) + 1); }
    const series = bk.map((b) => ({ label: b.label, created: createdBy.get(b.key) ?? 0, token: tokenBy.get(b.key) ?? 0, online: onlineBy.get(b.key) ?? 0, done: doneBy.get(b.key) ?? 0 }));
    const cal = this.calendar(actor, scope);
    const extras = this.extras(actor, isMine, op);

    return {
      scope, period: p, generated_at: nowIso(),
      kpi: {
        active, phases,
        token: { total: tokenIn + tokenOut, in: tokenIn, out: tokenOut },
        avg: { hours: avgHours, target: 4 },
        completion: { done: doneCnt, accepted: doneCnt, onTime, overdueDone, atRisk, overdue, total, pct: total ? Math.round((doneCnt / total) * 100) : 0 },
      },
      series, calendar: cal, insights: this.insights(actor, p, 30, scope), ...extras,
    };
  }

  insights(actor: Actor, period: string, days: number, scope: 'mine'|'team' = 'mine'): Json {
    const d=this.d(); const now=new Date(); const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
    const tasks=scope==='mine'?d.all<Json>(`SELECT t.* FROM tasks t WHERE t.organization_id=? AND ${this.mineSql} AND t.status<>'cancelled'`,actor.orgId,actor.userId,actor.userId,actor.userId):d.all<Json>(`SELECT t.* FROM tasks t WHERE t.organization_id=? AND t.status<>'cancelled'`,actor.orgId);
    const usage=scope==='mine'?d.all<Json>('SELECT created_at,input_tokens,output_tokens FROM usage_records WHERE organization_id=? AND user_id=?',actor.orgId,actor.userId):d.all<Json>('SELECT created_at,input_tokens,output_tokens FROM usage_records WHERE organization_id=?',actor.orgId);
    const dayKey=(v: unknown) => { const x=new Date(String(v)); return Number.isFinite(x.getTime())?ymd(x):''; };
    const dueOn=(t:Json,key:string)=>String(t.schedule_date??'')===key||dayKey(t.due_at)===key;
    const start=new Date(today); if(period==='week')start.setDate(start.getDate()-(start.getDay()+6)%7); if(period==='month')start.setDate(1);
    const end=new Date(today);end.setDate(end.getDate()+1);
    const previousStart=new Date(start),previousEnd=new Date(start);
    if(period==='month')previousStart.setMonth(previousStart.getMonth()-1);else previousStart.setDate(previousStart.getDate()-(period==='week'?7:1));
    const inRange=(v:unknown,a:Date,b:Date)=>{const n=Date.parse(String(v));return n>=a.getTime()&&n<b.getTime();};
    const stats=(a:Date,b:Date)=>{const completed=tasks.filter(t=>t.status==='completed'&&inRange(t.updated_at,a,b));const hours=completed.map(t=>(Date.parse(String(t.updated_at))-Date.parse(String(t.created_at)))/3600000).filter(n=>Number.isFinite(n)&&n>=0);const relevant=tasks.filter(t=>inRange(t.created_at,a,b)||inRange(t.due_at,a,b)||inRange(t.updated_at,a,b)&&t.status==='completed');return {token:usage.filter(r=>inRange(r.created_at,a,b)).reduce((n,r)=>n+Number(r.input_tokens??0)+Number(r.output_tokens??0),0),avg:hours.length?hours.reduce((a,b)=>a+b,0)/hours.length:0,pct:relevant.length?relevant.filter(t=>t.status==='completed'&&Date.parse(String(t.updated_at))<b.getTime()).length/relevant.length*100:0};};
    const cur=stats(start,end),prev=stats(previousStart,previousEnd);const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
    const daily=Array.from({length:Math.max(7,Math.min(30,days))},(_,i)=>{const dt=new Date(today);dt.setDate(dt.getDate()-Math.max(7,Math.min(30,days))+i+1);const next=new Date(dt);next.setDate(next.getDate()+1);const st=stats(dt,next);return {date:ymd(dt),label:`${dt.getMonth()+1}/${dt.getDate()}`,created:tasks.filter(t=>dayKey(t.created_at)===ymd(dt)).length,done:tasks.filter(t=>t.status==='completed'&&dayKey(t.updated_at)===ymd(dt)).length,token:st.token,avg:st.avg};});
    const todays=tasks.filter(t=>dueOn(t,ymd(today)));const phases={pending:0,work:0,done:0,overdue:0};
    for(const t of todays){if(t.status==='completed')phases.done++;else if(t.due_at&&Date.parse(String(t.due_at))<now.getTime())phases.overdue++;else if(['accepted','in_progress','pending_review'].includes(String(t.status)))phases.work++;else phases.pending++;}
    const delta=(a:number,b:number)=>b?Math.round((a-b)/b*1000)/10:null;
    return {daily,metrics:{today:todays.length,token:cur.token,avg:Math.round(cur.avg*10)/10,pct:Math.round(cur.pct)},changes:{today:delta(todays.length,tasks.filter(t=>dueOn(t,ymd(yesterday))).length),token:delta(cur.token,prev.token),avg:delta(cur.avg,prev.avg),pct:Math.round((cur.pct-prev.pct)*10)/10},phases};
  }

  calendar(actor: Actor, scope: string, month?: string): Json {
    const d = this.d(); const now = new Date(); const valid = /^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? '');
    const y = valid ? Number(month!.slice(0,4)) : now.getFullYear(), m = valid ? Number(month!.slice(5,7))-1 : now.getMonth();
    const days = new Date(y, m + 1, 0).getDate(); const first = new Date(y, m, 1);
    const isMine = scope === 'mine'; const u = actor.userId; const op = actor.orgId;
    const rows = isMine
      ? d.all<Json>(`SELECT * FROM tasks t WHERE t.organization_id=? AND t.assignee_id=? AND t.status IN ('accepted','in_progress') AND t.schedule_date IS NOT NULL AND t.schedule_start IS NOT NULL`, op, u)
      : d.all<Json>(`SELECT * FROM tasks t WHERE t.organization_id=? AND t.status IN ('accepted','in_progress') AND t.schedule_date IS NOT NULL AND t.schedule_start IS NOT NULL`, op);
    const tasksByDay = new Map<string, Array<{id:string;priority:string}>>();
    const over = new Map<string, boolean>(); const nowDay=ymd(now);
    for(const t of rows) {
      const dates=new Set([String(t.schedule_date ?? '').slice(0,10)].filter(k=>/^\d{4}-\d{2}-\d{2}$/.test(k)));
      const priority=({urgent:'T0',high:'T1',normal:'T2',low:'T3'} as Record<string,string>)[String(t.priority)] ?? 'T2';
      for(const date of dates) {const list=tasksByDay.get(date)??[];list.push({id:String(t.id),priority});tasksByDay.set(date,list);if(t.due_at&&String(t.due_at).slice(0,10)<nowDay&&t.status!=='completed')over.set(date,true);}
    }
    const monthDays=Array.from({length:days},(_,i)=>{const date=`${y}-${pad(m+1)}-${pad(i+1)}`;const tasks=(tasksByDay.get(date)??[]).sort((a,b)=>a.priority.localeCompare(b.priority));return {date,count:tasks.length,tasks,overdue:!!over.get(date)};});
    const today = this.agendaList(actor, scope, ymd(now));
    return { year: y, month: m + 1, firstWeekday: (first.getDay() + 6) % 7, days: monthDays, today: ymd(now), agenda: today };
  }

  agenda(actor: Actor, scope: 'mine' | 'team', date: string, responsible = false): { date: string; tasks: Json[] } {
    const safe = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : ymd(new Date());
    const tasks = this.agendaList(actor, scope, safe);
    return { date: safe, tasks: responsible ? tasks.filter(t=>t.assignee_id===actor.userId && ['accepted','in_progress'].includes(String(t.status)) && t.schedule_date===safe && /^\d{2}:\d{2}$/.test(String(t.schedule_start??''))).sort((a,b)=>String(a.schedule_start).localeCompare(String(b.schedule_start))) : tasks };
  }

  private agendaList(actor: Actor, scope: string, day: string): Json[] {
    const d = this.d(); const isMine = scope === 'mine'; const u = actor.userId; const op = actor.orgId;
    const rows = isMine
      ? d.all<Json>(`SELECT t.*, au.display_name AS assignee_name, ru.display_name AS reviewer_name
         FROM tasks t LEFT JOIN users au ON au.id=t.assignee_id LEFT JOIN users ru ON ru.id=t.reviewer_id
         WHERE t.organization_id=? AND ${this.mineSql} AND t.status NOT IN ('cancelled')
           AND (t.schedule_date=? OR substr(t.due_at,1,10)=?) ORDER BY t.schedule_start IS NULL, t.schedule_start`, op, u, u, u, day, day)
      : d.all<Json>(`SELECT t.*, au.display_name AS assignee_name, ru.display_name AS reviewer_name
         FROM tasks t LEFT JOIN users au ON au.id=t.assignee_id LEFT JOIN users ru ON ru.id=t.reviewer_id
         WHERE t.organization_id=? AND t.status NOT IN ('cancelled') AND (t.schedule_date=? OR substr(t.due_at,1,10)=?)
         ORDER BY t.schedule_start IS NULL, t.schedule_start`, op, day, day);
    return rows.map((t) => ({ ...t, priority_label: ({ urgent: 'T0', high: 'T1', normal: 'T2', low: 'T3' } as Record<string, string>)[String(t.priority)] ?? 'T2', scheduled: !!(t.schedule_date && t.schedule_start) }));
  }

  private extras(actor: Actor, isMine: boolean, op: string): Json {
    const d = this.d(); const u = actor.userId;
    const ownerSql = isMine ? 'AND (t.assignee_id=? OR t.creator_id=? OR t.reviewer_id=?)' : '';
    const ownerArgs = isMine ? [u, u, u] : [];
    // 成果陈列室：最近 12 条提交（带团队名与多文件）
    const gallery = d.all<Json>(
      `SELECT s.id, s.task_id, s.note, s.created_at, s.status, s.file_snapshot, t.title AS task_title, tm.name AS team_name, us.display_name AS submitter_name
       FROM task_submissions s JOIN tasks t ON t.id=s.task_id LEFT JOIN users us ON us.id=s.submitter_id LEFT JOIN teams tm ON tm.id=t.team_id
       WHERE t.organization_id=? AND s.status='approved' AND t.status='completed' ${ownerSql.replace(/\bt\./g, 't.')} ORDER BY s.created_at DESC LIMIT 12`, op, ...ownerArgs)
      .map((s) => ({ id: String(s.id), task_id: String(s.task_id), fileDetails: j<Json[]>(s.file_snapshot as string, []), task: String(s.task_title), desc: String(s.note ?? ''), files: j<Json[]>(s.file_snapshot as string, []).map((f) => String(f.name)), fileCount: j<Json[]>(s.file_snapshot as string, []).length, accepted: String(s.status) === 'approved', who: String(s.submitter_name ?? ''), team: String(s.team_name ?? ''), at: String(s.created_at) }));
    // 项目与里程碑：按 project 完成度 + 最近期限
    const projects = d.all<Json>(
      `SELECT t.project, COUNT(*) total, SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) done, MIN(t.due_at) dl
       FROM tasks t WHERE t.organization_id=? AND t.project IS NOT NULL AND t.project<>'' ${ownerSql} GROUP BY t.project ORDER BY total DESC LIMIT 8`, op, ...ownerArgs)
      .map((r) => ({ project: String(r.project), total: Number(r.total), done: Number(r.done ?? 0), pct: Number(r.total) ? Math.round((Number(r.done ?? 0) / Number(r.total)) * 100) : 0, deadline: r.dl ? ymdFromIso(String(r.dl)) : '' }));
    // 每个任务最近一次交接，用时由该任务的处理日志累加得出。
    const relay = d.all<Json>(
      `SELECT * FROM (
         SELECT tr.fields, tr.created_at, tr.actor_id AS from_id, ua.display_name AS from_name, ua.prefs AS from_prefs, t.assignee_id, t.reviewer_id,
                t.id AS task_id, t.title AS task_title, t.status, t.handler_log,
                ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY tr.created_at DESC, tr.rowid DESC) AS rn
         FROM task_transitions tr JOIN tasks t ON t.id=tr.task_id LEFT JOIN users ua ON ua.id=tr.actor_id
         WHERE t.organization_id=? AND tr.action IN ('assign','handoff_next') ${ownerSql}
       ) WHERE rn=1 ORDER BY created_at DESC LIMIT 12`, op, ...ownerArgs)
      .map((r) => {
        const fields = j<Json>(String(r.fields), {});
        const targetId = fields.next ?? (Array.isArray(fields.handlers) ? fields.handlers[0] : undefined) ?? (r.status === 'pending_review' ? r.reviewer_id : r.assignee_id);
        const recipient = targetId ? d.get<{ display_name: string; prefs: string }>('SELECT display_name, prefs FROM users WHERE id=?', targetId) : undefined;
        const processingMs = j<Json[]>(String(r.handler_log ?? '[]'), []).reduce((sum, entry) => {
          const duration = entry.duration_ms ?? (entry.accepted_at ? Date.parse(String(entry.ended_at ?? nowIso())) - Date.parse(String(entry.accepted_at)) : 0);
          return sum + (Number.isFinite(Number(duration)) ? Math.max(0, Number(duration)) : 0);
        }, 0);
        return { task_id: r.task_id, task: r.task_title, status: r.status, from_id: r.from_id, to_id: targetId ?? null, from: r.from_name ?? '—',
          to: recipient?.display_name ?? '—', from_avatar: j<Json>(String(r.from_prefs ?? '{}'), {}).avatar,
          to_avatar: j<Json>(recipient?.prefs ?? '{}', {}).avatar,
          processingMs, at: r.created_at };
      });
    // 团队工作负荷：在职成员的进行中 / 已完成 / 总任务 + 负载（负载 = 进行中相对单人并发容量折算）
    const WORKLOAD_CAP = 5;
    const workload = d.all<Json>(
      `SELECT us.id, us.display_name, us.title,
         SUM(CASE WHEN t.status IN ('pending_accept','accepted','in_progress') THEN 1 ELSE 0 END) AS in_progress,
         SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) AS completed, COUNT(t.id) AS total
       FROM users us
       JOIN memberships mm ON mm.user_id=us.id AND mm.organization_id=? AND mm.status='active'
       LEFT JOIN tasks t ON t.assignee_id=us.id AND t.organization_id=?
       GROUP BY us.id, us.display_name, us.title
       ORDER BY in_progress DESC, completed DESC`, op, op)
      .map((r) => {
        const inProgress = Number(r.in_progress) || 0; const completed = Number(r.completed) || 0; const total = Number(r.total) || 0;
        const load = Math.min(100, Math.round((inProgress / WORKLOAD_CAP) * 100));
        return { id: String(r.id), name: String(r.display_name), role: String(r.title ?? ''), inProgress, completed, total, load };
      });
    const workloadDepartments = d.all<Json>(
      `SELECT tm.id, tm.name, COUNT(DISTINCT t.id) AS total,
         COUNT(DISTINCT CASE WHEN t.status='completed' THEN t.id END) AS completed
       FROM teams tm
       LEFT JOIN team_members tmem ON tmem.team_id=tm.id
       LEFT JOIN memberships mm ON mm.user_id=tmem.user_id AND mm.organization_id=tm.organization_id AND mm.status='active'
       LEFT JOIN users us ON us.id=mm.user_id AND us.status='active'
       LEFT JOIN tasks t ON t.assignee_id=us.id AND t.organization_id=tm.organization_id
       WHERE tm.organization_id=? GROUP BY tm.id, tm.name
       UNION ALL
       SELECT 'unassigned', '未加入团队', COUNT(t.id),
         SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END)
       FROM tasks t JOIN memberships mm ON mm.user_id=t.assignee_id AND mm.organization_id=t.organization_id AND mm.status='active'
       WHERE t.organization_id=? AND NOT EXISTS (
         SELECT 1 FROM team_members tmem JOIN teams tm ON tm.id=tmem.team_id
         WHERE tmem.user_id=t.assignee_id AND tm.organization_id=t.organization_id
       ) HAVING COUNT(t.id)>0 ORDER BY total DESC`, op, op)
      .map((row) => ({ id: row.id, name: row.name, total: Number(row.total), completed: Number(row.completed) }));
    return { gallery, projects, relay, workload, workloadDepartments };
  }
}

let dashInstance: DashboardService | null = null;
export function getDashboardService(): DashboardService {
  if (!dashInstance) dashInstance = new DashboardService();
  return dashInstance;
}
