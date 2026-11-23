// 走 Web 接口同一套服务来校验展示数据，而不是只查表。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const require=createRequire(import.meta.url); require('reflect-metadata');
const {getDb}=require('../dist/server/core/db.js');
const {config}=require('../dist/server/core/config.js');
const {scheduler}=require('../dist/server/core/queue.js'); await scheduler.stop();
const {FilesService}=require('../dist/server/modules/files/files.service.js');
const {SessionsService}=require('../dist/server/modules/sessions/sessions.service.js');
const {MessagesService}=require('../dist/server/modules/messages/messages.service.js');
const {TasksService}=require('../dist/server/modules/tasks/tasks.service.js');
const {DashboardService}=require('../dist/server/modules/dashboard/dashboard.service.js');
const {OrchestratorService}=require('../dist/server/modules/orchestrator/orchestrator.service.js');
const {services}=require('../dist/server/core/contracts.js');
const d=getDb(), files=new FilesService(), sessions=new SessionsService(), messages=new MessagesService(), tasks=new TasksService(), dashboard=new DashboardService();
files.onModuleInit();services.sessions=sessions;services.orchestrator=new OrchestratorService();
const m=JSON.parse(fs.readFileSync(path.join(config.dataDir,'presentation-20261107.json'),'utf8'));
assert.equal(d.val('PRAGMA integrity_check'),'ok');
const backupName=fs.readdirSync(path.join(config.root,'backups')).filter(n=>n.startsWith('before-demo-')).sort()[0];
const baseline=new DatabaseSync(path.join(config.root,'backups',backupName,'flowmate.sqlite3'),{readOnly:true});
const beforeForeign=baseline.prepare('PRAGMA foreign_key_check').all(), afterForeign=d.all('PRAGMA foreign_key_check');
assert.equal(JSON.stringify(afterForeign),JSON.stringify(beforeForeign),'Demo import introduced a foreign key error');baseline.close();
const org=d.get('SELECT id FROM organizations WHERE name=?','星屿科技').id;
const actors=['baymax@xingyu.test','hy123@xingyu.test','cyx666@xingyu.test','xuyangtian@xingyu.test'].map(email=>{
  const u=d.get('SELECT * FROM users WHERE email=?',email), membership=d.get('SELECT role FROM memberships WHERE user_id=? AND organization_id=?',u.id,org);
  return {userId:u.id,orgId:org,role:membership.role,displayName:u.display_name};
});
let previews=0;
for(const f of m.files) {
  const a=actors.find(a=>a.userId===f.owner); const row=d.get('SELECT current_version_id FROM files WHERE id=?',f.id);
  const text=d.get('SELECT * FROM file_text WHERE file_version_id=?',row.current_version_id); assert.equal(text.status,'ready',f.name);
  const v=d.get('SELECT * FROM file_versions WHERE id=?',row.current_version_id), {buffer}=await files.readVersion(v.id);
  assert.ok(buffer.length>0);assert.equal(createHash('sha256').update(buffer).digest('hex'),v.sha256);
  await files.preview(a,f.id); previews++;
}
const result=[];
for(let i=0;i<actors.length;i++) {
  const a=actors[i], list=await messages.list(a), personal=await sessions.list(a,'personal'), team=await sessions.list(a,'team'), shared=await sessions.sharedWithMe(a);
  const stage={};for(const sub of ['create','receive','work','review']) {const t=await tasks.list(a,{scope:'mine',sub});stage[sub]=t.stage_counts[sub];assert.ok(stage[sub]>0,`${a.displayName}:${sub}`);}
  const mine=await dashboard.summary(a,'mine','week'), all=await dashboard.summary(a,'team','week');
  assert.ok(mine.gallery.length>0);assert.ok(mine.relay.length>0);assert.ok(mine.series.some(x=>x.created>0));assert.ok(mine.series.some(x=>x.done>0));assert.ok(mine.calendar);
  assert.ok(all.workload.length>=4);assert.ok(all.workloadDepartments.length>=3);assert.ok(all.gallery.length>=4);assert.ok(all.relay.length>=5);
  for(let g=0;g<4;g++) {
    const history=await messages.messages(a,m.entities[`group-${g}`],{limit:50});assert.ok(history.items.length>=18);
    const fileCard=history.items.find(x=>x.card_type==='file_version');assert.ok(fileCard);
    const version=d.get('SELECT file_id FROM file_versions WHERE id=?',fileCard.card.card_id);await files.preview(a,version.file_id);
  }
  const sid=m.entities[`office-${i}-0`], history=await sessions.messages(a,sid), read=await sessions.readManifest(a,sid), artifacts=await sessions.artifactsOf(a,sid);
  assert.equal(history.length,11);assert.equal(read.file_count,3);assert.equal(artifacts.length,1);
  const card=history.find(message=>message.kind==='artifact');assert.equal(card.aux.artifact_id,artifacts[0].id);assert.equal(card.aux.status,'committed');
  const artifact=await sessions.artifactContent(a,artifacts[0].id);assert.ok(artifact.content.includes('行动清单'));
  assert.ok(shared.length>=1);assert.ok(personal.length>=4);assert.ok(team.length>=3);
  result.push({account:a.displayName,message_conversations:list.length,personal_office:personal.length,team_office:team.length,shared_office:shared.length,task_stages:stage,recent_files:(await files.recent(a)).length,gallery:mine.gallery.length,relay:mine.relay.length,weekly_created:mine.series.map(x=>x.created),weekly_completed:mine.series.map(x=>x.done)});
}
// 重复执行后行数必须不变：装配脚本用固定 id 加持久化清单，不会重复插入。
const counts={};for(const table of ['tasks','task_transitions','task_submissions','messages','agent_sessions','session_messages','files','artifacts','usage_records'])counts[table]=d.val(`SELECT count(*) FROM ${table}`);
const report={verified_at:new Date().toISOString(),integrity:'ok',new_foreign_key_errors:0,preexisting_foreign_key_errors:beforeForeign,verified_file_previews:previews,accounts:result,total_database_rows:counts};
fs.writeFileSync(path.join(config.dataDir,'presentation-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));d.close();process.exit(0);
