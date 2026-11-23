import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { services } from '../dist/server/core/contracts.js';
import { SessionsService } from '../dist/server/modules/sessions/sessions.service.js';
import { OrchestratorService } from '../dist/server/modules/orchestrator/orchestrator.service.js';
import { SessionsController } from '../dist/server/modules/sessions/sessions.controller.js';

test('artifact cards resolve imported and run references, and preview enforces session access', async () => {
  const d=useDbFile(':memory:');runMigrations(d);
  d.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  for(const user of ['owner','outsider']) d.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,'now','now')",user,`${user}@test`,user);
  for(const session of ['session','other-session']) d.run("INSERT INTO agent_sessions(id,organization_id,mode,title,owner_id,created_at,updated_at) VALUES(?,'org','personal',?,'owner','now','now')",session,session);
  d.run("INSERT INTO session_participants(session_id,user_id,organization_id,role,joined_at) VALUES('session','owner','org','coordinator','now')");
  d.run("INSERT INTO requests(id,organization_id,session_id,creator_id,goal,created_at,updated_at) VALUES('request','org','session','owner','Summary','now','now')");
  d.run("INSERT INTO runs(id,organization_id,request_id,session_id,subtask_id,subtask_name,status,created_at,updated_at) VALUES('run','org','request','session','summary','Summary','succeeded','now','now')");
  for(const [aid,sid,rid] of [['artifact','session','run'],['other-artifact','other-session',null]]) d.run("INSERT INTO artifacts(id,organization_id,session_id,run_id,kind,name,status,draft_version_id,created_at,updated_at) VALUES(?,'org',?,?,'report','行动清单','committed','version','now','now')",aid,sid,rid);
  for(const [seq,type,ref] of [[1,'artifact','artifact'],[2,'run','run'],[3,'artifact','other-artifact']]) d.run("INSERT INTO session_messages(id,session_id,organization_id,seq,role,kind,body,ref_type,ref_id,created_at) VALUES(?,'session','org',?,'agent','artifact','已生成',?,?,'now')",`message-${seq}`,seq,type,ref);
  services.orchestrator=new OrchestratorService();
  services.files={readVersion:async id=>{assert.equal(id,'version');return {buffer:Buffer.from('# 行动清单\n\n核对需求与验收材料。')};}};
  const actor={userId:'owner',orgId:'org',role:'member',displayName:'Owner'};
  const svc=new SessionsService(), cards=await svc.messages(actor,'session');
  for(const card of cards.slice(0,2)) {assert.equal(card.aux.artifact_id,'artifact');assert.equal(card.aux.status,'committed');assert.equal(card.aux.name,'行动清单');}
  assert.equal(cards[2].aux.artifact_id,undefined,'Never resolve artifacts belonging to another session');
  assert.match((await svc.artifactContent(actor,'artifact')).content,/核对需求/);
  await assert.rejects(svc.artifactContent({...actor,userId:'outsider'},'artifact'),e=>e.code==='NOT_FOUND');
  await assert.rejects(svc.artifactContent(actor,'missing'),e=>e.code==='NOT_FOUND');
  assert.equal(Reflect.getMetadata('path',SessionsController.prototype.artifactContent),'artifacts/:id/content');
});
