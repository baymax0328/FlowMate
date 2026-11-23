type Task = { id: unknown; priority?: unknown; due_at?: unknown; estimate_min?: unknown; created_at?: unknown };
export type Placement = {id:string;date:string;start:string;end:string};
const dateKey=(d:Date)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const minute=(v:string)=>{const [h,m]=v.split(':').map(Number);return h*60+m;};
const time=(v:number)=>`${String(Math.floor(v/60)).padStart(2,'0')}:${String(v%60).padStart(2,'0')}`;

/** 兼顾期限的一周均衡排期：已占用时段与已经过去的时间一律不可用。 */
export function planWeek(rows:Task[],week:string[],now=new Date(),reserved:Placement[]=[]) {
  const today=dateKey(now), windows=[[540,720],[840,1080]], occupied=[...reserved];
  const rank:Record<string,number>={urgent:0,high:1,normal:2,low:3};
  const duration=(t:Task)=>Math.ceil(Math.max(15,Number(t.estimate_min)||({urgent:120,high:90,normal:60,low:45}[String(t.priority)]??60))/15)*15;
  const deadline=(t:Task)=>t.due_at?dateKey(new Date(String(t.due_at))):'';
  const ordered=[...rows].sort((a,b)=>{
    const dueA=deadline(a)||'9999',dueB=deadline(b)||'9999';
    return dueA.localeCompare(dueB)||(rank[String(a.priority)]??2)-(rank[String(b.priority)]??2)||String(a.created_at).localeCompare(String(b.created_at));
  });
  const placed:Placement[]=[],overflow:string[]=[];
  for(const task of ordered) {
    const length=duration(task),due=deadline(task),nowMin=Math.ceil((now.getHours()*60+now.getMinutes()+1)/15)*15;
    const overdue=due && (/T\d{2}:\d{2}/.test(String(task.due_at)) ? Date.parse(String(task.due_at))<+now : due<today);
    const candidates:{date:string;start:number;load:number}[]=[];
    for(const day of week) {
      if(day<today || due&&!overdue&&day>due)continue;
      const intervals=occupied.filter(x=>x.date===day);
      const load=intervals.reduce((n,x)=>n+minute(x.end)-minute(x.start),0);
      let found=false;
      for(const [begin,end] of windows) {
        for(let start=Math.max(begin,day===today?nowMin:begin);start+length<=end;start+=15) {
          if(due&&!overdue&&day===due&&/T\d{2}:\d{2}/.test(String(task.due_at))&&Number.isFinite(Date.parse(String(task.due_at)))&&new Date(`${day}T${time(start+length)}:00`).getTime()>Date.parse(String(task.due_at)))continue;
          if(intervals.some(x=>minute(x.start)<start+length&&minute(x.end)>start))continue;
          candidates.push({date:day,start,load});found=true;break;
        }
        if(found)break;
      }
    }
    // 紧急和临近期限的任务就近排；其余任务按当天已排负载摊到整周。
    const imminent=due&&due<=dateKey(new Date(+now+86400000));
    candidates.sort((a,b)=>imminent||String(task.priority)==='urgent'?a.date.localeCompare(b.date)||a.start-b.start:a.load-b.load||a.date.localeCompare(b.date)||a.start-b.start);
    const slot=candidates[0];
    if(!slot){overflow.push(String(task.id));continue;}
    const p={id:String(task.id),date:slot.date,start:time(slot.start),end:time(slot.start+length)};placed.push(p);occupied.push(p);
  }
  return {placed,overflow};
}
