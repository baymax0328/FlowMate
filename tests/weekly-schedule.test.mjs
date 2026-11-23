import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planWeek } from '../dist/server/modules/tasks/week-scheduler.js';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { DashboardService } from '../dist/server/modules/dashboard/dashboard.service.js';
import { TasksService } from '../dist/server/modules/tasks/tasks.service.js';

const week=['2026-11-09','2026-11-10','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15'];
test('service week boundaries use local dates, and overdue tasks can be recovered in a later week',()=>{
  assert.deepEqual(new TasksService().weekOf('2026-11-09'),week);
  const p=planWeek([{id:'overdue',estimate_min:60,priority:'high',due_at:'2026-11-07T10:00:00+08:00'}],week,new Date('2026-11-07T20:00:00+08:00'));
  assert.equal(p.placed[0].date,'2026-11-09');assert.equal(p.overflow.length,0);
});
test('weekly scheduling balances work, respects deadlines, preserves duration and avoids occupied periods',()=>{
  const tasks=Array.from({length:10},(_,i)=>({id:String(i),priority:i===0?'urgent':'normal',estimate_min:90,due_at:i===0?'2026-11-09T12:00:00+08:00':'2026-11-15',created_at:'2026-11-01'}));
  const reserved=[{id:'completed',date:week[0],start:'09:00',end:'10:00'}];
  const {placed,overflow}=planWeek(tasks,week,new Date('2026-11-09T10:10:00+08:00'),reserved);
  assert.equal(overflow.length,0);assert.equal(placed.length,10);
  assert.equal(placed[0].date,week[0]);assert.equal(placed[0].start,'10:15');assert.equal(placed[0].end,'11:45');
  assert.ok(new Set(placed.map(p=>p.date)).size>=5);
  for(const p of placed){const min=t=>Number(t.slice(0,2))*60+Number(t.slice(3));assert.equal(min(p.end)-min(p.start),90);for(const other of [...placed,...reserved].filter(x=>x.id!==p.id&&x.date===p.date))assert.ok(p.end<=other.start||p.start>=other.end);}
});
test('elapsed weeks and tasks too long for a work period remain unscheduled',()=>{
  const task={id:'long',priority:'normal',estimate_min:360,due_at:'2026-11-15'};
  assert.deepEqual(planWeek([task],week,new Date('2026-11-09T09:00:00+08:00')).overflow,['long']);
  assert.deepEqual(planWeek([{...task,estimate_min:60}],week,new Date('2026-11-16T09:00:00+08:00')).overflow,['long']);
});
test('my agenda includes only tasks I currently handle, while daily focus retains related tasks',()=>{
  const d=useDbFile(':memory:');runMigrations(d);
  d.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  for(const id of ['me','other'])d.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,'now','now')",id,id+'@test',id);
  for(const [id,creator,assignee,status] of [['created','me','other','in_progress'],['responsible','other','me','accepted'],['awaiting','other','me','pending_accept'],['finished','other','me','completed']])d.run("INSERT INTO tasks(id,organization_id,title,creator_id,assignee_id,status,due_at,created_at,updated_at) VALUES(?,'org',?,?,?,?, '2026-11-09','now','now')",id,id,creator,assignee,status);
  const svc=new DashboardService(),actor={userId:'me',orgId:'org',role:'member',displayName:'Me'};
  d.run("UPDATE tasks SET schedule_date='2026-11-09',schedule_start='13:00',schedule_end='14:00' WHERE id='responsible'");
  assert.equal(svc.agenda(actor,'mine','2026-11-09').tasks.length,4);
  assert.deepEqual(svc.agenda(actor,'mine','2026-11-09',true).tasks.map(t=>t.id),['responsible']);
  assert.equal(svc.calendar(actor,'mine','2026-11').days.find(day=>day.date==='2026-11-09').count,1);
  d.run("UPDATE tasks SET schedule_date='2026-11-10' WHERE id='responsible'");
  assert.equal(svc.calendar(actor,'mine','2026-11').days.find(day=>day.date==='2026-11-09').count,0);
  assert.equal(svc.calendar(actor,'mine','2026-11').days.find(day=>day.date==='2026-11-10').count,1);
  assert.equal(svc.agenda(actor,'mine','2026-11-09',true).tasks.length,0);
});
