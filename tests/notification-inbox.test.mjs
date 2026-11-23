import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { INBOX_NOTIFICATION_SQL } from '../server/modules/notifications/inbox-policy.ts';

function fixture() {
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE notifications(id TEXT,user_id TEXT,organization_id TEXT,type TEXT,title TEXT,actor_id TEXT,task_id TEXT,session_id TEXT,read_at TEXT,created_at TEXT); CREATE TABLE task_transitions(task_id TEXT,actor_id TEXT,created_at TEXT);`);
 const insert=db.prepare('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,?,?,?)');
 const add=(id,type,actor,task=null,session=null,title='交给你的内容',user='me',org='org')=>insert.run(id,user,org,type,title,actor,task,session,null,'2026-11-02T10:00:00Z');
 add('assigned','task_assigned','other');add('review','task_review','other');add('share','share_assigned','other',null,'session');
 add('self','task_assigned','me');add('completed','review_result','other');add('mention','mention','other');add('office-mention','session_mentioned','other');add('accepted','task_transition','other');
 add('return','task_transition','other',null,null,'退回了任务');add('invite','invite_received','other');add('foreign-user','task_assigned','other',null,null,'内容','another');add('foreign-org','task_assigned','other',null,null,'内容','me','another');
 add('legacy-self','task_review',null,'legacy-self');add('legacy-other','task_review',null,'legacy-other');
 db.prepare('INSERT INTO task_transitions VALUES(?,?,?)').run('legacy-self','me','2026-11-02T09:59:00Z');db.prepare('INSERT INTO task_transitions VALUES(?,?,?)').run('legacy-other','other','2026-11-02T09:59:00Z');
 return db;
}
const where=`n.user_id='me' AND n.organization_id='org' AND ${INBOX_NOTIFICATION_SQL}`;
test('inbox contains incoming work, excludes self receipts, completions and mentions',()=>{const db=fixture();try{assert.deepEqual(db.prepare(`SELECT id FROM notifications n WHERE ${where} ORDER BY id`).all().map(r=>r.id),['assigned','legacy-other','return','review','share']);}finally{db.close();}});
test('inbox badge and mark-all-read use exactly the same scope, preserving audit rows',()=>{const db=fixture();try{const count=()=>db.prepare(`SELECT count(*) AS n FROM notifications n WHERE ${where} AND read_at IS NULL`).get().n;assert.equal(count(),5);db.prepare(`UPDATE notifications AS n SET read_at='read' WHERE ${where} AND read_at IS NULL`).run();assert.equal(count(),0);assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n,14);assert.equal(db.prepare("SELECT read_at FROM notifications WHERE id='mention'").get().read_at,null);db.prepare("INSERT INTO notifications VALUES('new','me','org','task_assigned','新任务','other',NULL,NULL,NULL,'2026-11-02T11:00:00Z')").run();assert.equal(count(),1);}finally{db.close();}});
