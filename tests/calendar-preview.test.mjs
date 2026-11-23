import test from 'node:test';
import assert from 'node:assert/strict';
import { tasksOnDate, scheduledTasksOnDate, dailyAgenda, priorityFocus } from '../src/features/dashboard/calendar-data.ts';
test('daily focus includes due-only tasks and deduplicates matching dates', () => {
 const tasks=[{id:'due',due_at:'2026-11-01',status:'completed'},{id:'both',schedule_date:'2026-11-01',due_at:'2026-11-01'},{id:'scheduled',schedule_date:'2026-11-01'},{id:'cancelled',schedule_date:'2026-11-01',status:'cancelled'},{id:'other',due_at:'2026-11-02'}];
 assert.deepEqual(tasksOnDate(tasks,'2026-11-01').map(t=>t.id),['due','both','scheduled']);
 assert.deepEqual(tasksOnDate(tasks,'2026-11-02').map(t=>t.id),['other']);
 assert.equal(tasksOnDate(tasks,'2026-11-03').length,0);
});

test('calendar markers follow scheduled work, not deadlines or finished tasks',()=>{
 const tasks=[{id:'due-only',due_at:'2026-11-07',status:'in_progress'},{id:'moved',due_at:'2026-11-07',schedule_date:'2026-11-08',schedule_start:'14:00',status:'accepted'},{id:'work',schedule_date:'2026-11-07',schedule_start:'13:00',status:'in_progress'},{id:'done',schedule_date:'2026-11-07',schedule_start:'14:00',status:'completed'}];
 assert.deepEqual(scheduledTasksOnDate(tasks,'2026-11-07').map(t=>t.id),['work']);
 assert.deepEqual(scheduledTasksOnDate(tasks,'2026-11-08').map(t=>t.id),['moved']);
});
test('agenda shows the first four unfinished work slots in time order; focus ignores schedule order',()=>{
 const times=['16:00','10:00','14:00','12:00','13:00','15:00'];
 const tasks=times.map((time,i)=>({id:i,status:'in_progress',schedule_date:'2026-11-07',schedule_start:time,priority_label:i===0?'T0':i===1?'T1':'T3',due_at:'2026-11-07T18:00:00+08:00'}));
 const excluded=[{id:'done',status:'completed',schedule_date:'2026-11-07',schedule_start:'08:00'},{id:'cancelled',status:'cancelled',schedule_date:'2026-11-07',schedule_start:'09:00'},{id:'other-date',status:'in_progress',schedule_date:'2026-11-08',schedule_start:'09:00'}];
 assert.deepEqual(dailyAgenda([...excluded,...tasks],'2026-11-07').map(t=>t.schedule_start),['10:00','12:00','13:00','14:00']);
 assert.deepEqual(dailyAgenda([...excluded,...tasks.map(t=>t.schedule_start==='10:00'?{...t,status:'completed'}:t)],'2026-11-07').map(t=>t.schedule_start),['12:00','13:00','14:00','15:00']);
 assert.deepEqual(priorityFocus(tasks).map(t=>t.priority_label),['T0','T1','T3','T3']);
});
