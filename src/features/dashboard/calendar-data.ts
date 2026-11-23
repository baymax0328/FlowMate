/** Daily focus includes deadlines as well as scheduled slots. */
export function tasksOnDate<T extends { status?: unknown; schedule_date?: unknown; due_at?: unknown }>(tasks: T[], date: string): T[] {
  return tasks.filter(task => task.status !== 'cancelled' &&
    (String(task.schedule_date ?? '').slice(0, 10) === date || String(task.due_at ?? '').slice(0, 10) === date));
}

type CalendarTask={status?:unknown;schedule_date?:unknown;schedule_start?:unknown;due_at?:unknown;priority_label?:unknown;priority?:unknown};
/** Calendar dots and agenda represent actual work slots, never deadline-only reminders. */
export function scheduledTasksOnDate<T extends CalendarTask>(tasks:T[],date:string):T[] {
  return tasks.filter(t=>['accepted','in_progress'].includes(String(t.status))&&t.schedule_date===date&&/^\d{2}:\d{2}$/.test(String(t.schedule_start??'')));
}
export function dailyAgenda<T extends CalendarTask>(tasks:T[],date:string):T[] {
  return scheduledTasksOnDate(tasks,date).sort((a,b)=>String(a.schedule_start).localeCompare(String(b.schedule_start))).slice(0,4);
}
export function priorityFocus<T extends CalendarTask>(tasks:T[]):T[] {
  const rank:Record<string,number>={T0:0,T1:1,T2:2,T3:3,urgent:0,high:1,normal:2,low:3};
  return tasks.filter(t=>!['completed','cancelled','draft'].includes(String(t.status))).sort((a,b)=>(rank[String(a.priority_label??a.priority)]??2)-(rank[String(b.priority_label??b.priority)]??2)||String(a.due_at??'9999').localeCompare(String(b.due_at??'9999'))).slice(0,4);
}
