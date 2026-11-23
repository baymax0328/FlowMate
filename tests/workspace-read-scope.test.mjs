import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useDbFile, runMigrations } from '../dist/server/core/db.js';
import { FilesService } from '../dist/server/modules/files/files.service.js';
import { fsList, fsRead } from '../dist/server/modules/orchestrator/tools.js';
import { services } from '../dist/server/core/contracts.js';
import { SessionsService } from '../dist/server/modules/sessions/sessions.service.js';
import { OrchestratorService } from '../dist/server/modules/orchestrator/orchestrator.service.js';

test('workspace listing ignores file payload size and reads stay in the selected root', async () => {
  const db=useDbFile(':memory:');runMigrations(db);
  db.run("INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES('org','Org','org','now','now')");
  db.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES('owner','owner@test','hash','Owner','now','now')");
  db.run("INSERT INTO memberships(id,organization_id,user_id,role,created_at) VALUES('membership','org','owner','member','now')");
  for(const id of ['root-a','root-b']) db.run("INSERT INTO folders(id,organization_id,space,owner_id,name,created_at,updated_at) VALUES(?,'org','personal','owner',?,'now','now')",id,id);
  db.run("INSERT INTO folders(id,organization_id,space,owner_id,parent_id,name,created_at,updated_at) VALUES('child','org','personal','owner','root-a','child','now','now')");
  db.run("INSERT INTO agent_sessions(id,organization_id,mode,title,owner_id,folder_id,status,created_at,updated_at) VALUES('session','org','personal','Test','owner','root-a','active','now','now')");
  db.run("INSERT INTO requests(id,organization_id,session_id,creator_id,goal,created_at,updated_at) VALUES('request','org','session','owner','Read','now','now')");
  db.run("INSERT INTO runs(id,organization_id,request_id,session_id,subtask_id,subtask_name,status,created_at,updated_at) VALUES('run','org','request','session','subtask','Read','running','now','now')");
  for(const [id,folder,kind,name,size] of [
    ['large','root-a','pdf','a-large.pdf',30*1024*1024],
    ['note-a','root-a','text','b-notes.txt',12],
    ['nested','child','text','nested.txt',12],
    ['note-b','root-b','text','b-notes.txt',12],
  ]) {
    db.run("INSERT INTO files(id,organization_id,space,owner_id,folder_id,name,ext,mime,kind,size,created_at,updated_at) VALUES(?,'org','personal','owner',?,?,'txt','text/plain',?,?,'now','now')",id,folder,name,kind,size);
    db.run("INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,change_source,created_at) VALUES(?,?,'org',1,?,'hash',?,'text/plain','seed','now')",id+'-v',id,id,size);
    db.run("UPDATE files SET current_version_id=? WHERE id=?",id+'-v',id);
  }
  const files=new FilesService();files.onModuleInit();
  files.readVersion=async(id)=>({buffer:Buffer.from(id)});
  files.text=async()=>({status:'ready',raw_text:'PDF contents'});
  const box={actor:{userId:'owner',orgId:'org',role:'member',displayName:'Owner'},organizationId:'org',sessionId:'session',requestId:'request',runId:'run',attempt:1,leaseToken:0,cancelEpoch:0,planner:'deterministic',rootFolderId:'root-a',includeChildren:false,readBytes:0,stepIndex:0};
  const listing=await fsList(box,{path:'/'});
  assert.deepEqual(listing.entries.filter(e=>e.file_id).map(e=>e.file_id),['large','note-a']);
  assert.equal(listing.truncated,false);
  assert.equal(listing.file_count,2);
  assert.ok(db.get("SELECT output_bytes FROM run_steps WHERE tool_name='fs.list'").output_bytes<2000);
  assert.equal((await fsRead(box,{file_id:'large'})).content,'PDF contents');
  await assert.rejects(fsRead(box,{file_id:'note-b'}));
  await assert.rejects(fsRead(box,{file_id:'nested'}));
  box.includeChildren=true;
  assert.ok((await fsList(box,{path:'/',recursive:true})).entries.some(e=>e.file_id==='nested'));
  box.rootFolderId='root-b';box.includeChildren=false;
  assert.deepEqual((await fsList(box,{path:'/'})).entries.map(e=>e.file_id),['note-b']);
  assert.equal((await fsRead(box,{file_id:'note-b'})).content,'note-b-v');
  await assert.rejects(fsRead(box,{file_id:'note-a'}));
  for (const [id, kind, extension] of [['html-count', 'html', '.html'], ['word-count', 'word', '.docx']]) {
    db.run("INSERT INTO files(id,organization_id,space,owner_id,folder_id,name,ext,mime,kind,size,created_at,updated_at) VALUES(?,'org','personal','owner','root-b',?,?,'application/octet-stream',?,100,'now','now')", id, id + extension, extension, kind);
  }
  const counted = await fsList(box, {path:'/',limit:1});
  assert.equal(counted.entries.length,1);
  assert.equal(counted.truncated,true);
  assert.equal(counted.file_count,3);
  assert.deepEqual(counted.counts_by_kind,{text:1,html:1,word:1});
  assert.equal(counted.folder_count,0);
  for (const kind of ['markdown', 'text', 'html', 'word', 'pdf', 'excel', 'ppt']) {
    db.run("UPDATE files SET kind=? WHERE id='note-b'", kind);
    assert.ok((await fsRead(box, {file_id:'note-b'})).content);
  }
  services.sessions = new SessionsService();
  db.run("INSERT INTO session_participants(session_id,user_id,organization_id,role,joined_at) VALUES('session','owner','org','coordinator','now')");
  const orchestrator = new OrchestratorService();
  for (const [goal, folder] of [['你好', 'root-a'], ['嗯', null]]) {
    db.run("UPDATE agent_sessions SET folder_id=? WHERE id='session'", folder);
    const result = await orchestrator.createRequest(box.actor, { session_id:'session', goal, output_kind:'draft', chat_mode:true });
    assert.equal(result.clarification, undefined);
    const request = db.get('SELECT chat_mode, clarification, plan FROM requests WHERE id=?', result.request.id);
    assert.equal(request.chat_mode, 1);
    assert.equal(request.clarification, null);
    assert.equal(JSON.parse(request.plan)[0].exec, 'answer');
  }
  db.run("UPDATE users SET prefs=? WHERE id='owner'", JSON.stringify({avatar:'female-2', unrelated:'private'}));
  const messages = await services.sessions.messages(box.actor, 'session');
  const ownMessage = messages.find(message => message.sender_user_id === 'owner');
  assert.equal(ownMessage.sender_avatar, 'female-2');
  assert.equal(ownMessage.sender_prefs, undefined);
  db.run("UPDATE users SET prefs=? WHERE id='owner'", JSON.stringify({avatar:'male-3'}));
  const refreshed = await services.sessions.messages(box.actor, 'session');
  assert.equal(refreshed.find(message => message.sender_user_id === 'owner').sender_avatar, 'male-3');
});
