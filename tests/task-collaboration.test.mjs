import test from 'node:test';
import assert from 'node:assert/strict';
import {useDbFile,runMigrations} from '../dist/server/core/db.js';
import {TasksService} from '../dist/server/modules/tasks/tasks.service.js';

test('parallel collaborators accept independently and advance only after both complete',async()=>{
 const d=useDbFile(':memory:');runMigrations(d);
 d.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
 const actors=['creator','a','b','c'].map(id=>({userId:id,orgId:'org',displayName:id,role:id==='creator'?'owner':'member'}));
 for(const a of actors){d.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,'now','now')",a.userId,a.userId+'@test',a.displayName);d.run("INSERT INTO memberships(id,organization_id,user_id,role,status,created_at) VALUES(?,'org',?,?,'active','now')",a.userId,a.userId,a.role);}
 const [creator,a,b,c]=actors,svc=new TasksService();
 for(const person of actors)d.run('UPDATE users SET prefs=? WHERE id=?',JSON.stringify({avatar:`account-${person.userId}`}),person.userId);
 const task=await svc.create(creator,{title:'协作流程验证',status:'ready_to_assign'});
 await svc.transition(creator,{task_id:task.id,action:'assign',payload:{stages:[['a','b'],['c']],reviewer_id:'creator'}});
 for(const who of [a,b])assert.ok((await svc.list(who,{scope:'mine',tab:'receive'})).items.some(t=>t.id===task.id));
 await assert.rejects(svc.transition(c,{task_id:task.id,action:'accept',payload:{estimate_min:60}}));
 await svc.transition(a,{task_id:task.id,action:'accept',payload:{estimate_min:60}});
 assert.ok((await svc.list(b,{scope:'mine',tab:'receive'})).items.some(t=>t.id===task.id));
 await svc.transition(a,{task_id:task.id,action:'handoff_next',payload:{}});
 assert.equal((await svc.get(creator,task.id)).handler_index,0);
 await svc.transition(b,{task_id:task.id,action:'accept',payload:{estimate_min:60}});
 const advanced=await svc.transition(b,{task_id:task.id,action:'handoff_next',payload:{}});
 assert.equal(advanced.chain[0].avatar,'account-creator');
 assert.deepEqual(advanced.chain[1].members.map(m=>m.avatar),['account-a','account-b']);
 assert.equal(advanced.chain.at(-1).avatar,'account-creator');
 assert.equal(advanced.handler_index,1);assert.equal(advanced.status,'pending_accept');assert.deepEqual(advanced.stage_users,[['a','b'],['c']]);
 await assert.rejects(svc.transition(a,{task_id:task.id,action:'handoff_next',payload:{}}));
 await svc.transition(c,{task_id:task.id,action:'accept',payload:{estimate_min:60}});
 assert.equal((await svc.transition(c,{task_id:task.id,action:'handoff_next',payload:{}})).status,'pending_review');
});
