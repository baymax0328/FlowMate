import test from 'node:test';
import assert from 'node:assert/strict';
import {useDbFile,runMigrations} from '../dist/server/core/db.js';
import {SessionsService} from '../dist/server/modules/sessions/sessions.service.js';
import {sessionAccess} from '../dist/server/core/permissions.js';

async function fixture(){
  const d=useDbFile(':memory:');runMigrations(d);
  for(const org of ['org','other'])d.run('INSERT INTO organizations(id,name,slug,created_at,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',org,org,org);
  const actors=['owner','a','b','outsider'].map(userId=>({userId,orgId:userId==='outsider'?'other':'org',displayName:userId,role:userId==='owner'?'owner':'member'}));
  for(const a of actors){
    d.run("INSERT INTO users(id,email,password_hash,display_name,created_at,updated_at) VALUES(?,?,'hash',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)",a.userId,a.userId+'@test',a.userId);
    d.run("INSERT INTO memberships(id,organization_id,user_id,role,status,created_at) VALUES(?,?,?,?,'active',CURRENT_TIMESTAMP)",a.userId,a.orgId,a.userId,a.role);
  }
  const [owner,a,b,outsider]=actors,svc=new SessionsService();
  const s=await svc.createPersonal(owner,{title:'共享测试'});
  const message=(body,kind='message',aux='{}')=>{
    const seq=d.val('SELECT last_message_seq FROM agent_sessions WHERE id=?',s.id)+1;
    d.run("INSERT INTO session_messages(id,session_id,organization_id,seq,sender_user_id,sender_label,role,kind,body,aux,created_at) VALUES(?,?,'org',?,'owner','owner','user',?,?,?,CURRENT_TIMESTAMP)",`msg${seq}`,s.id,seq,kind,body,aux);
    d.run('UPDATE agent_sessions SET last_message_seq=? WHERE id=?',seq,s.id);
  };
  message('过去的消息');
  return {d,owner,a,b,outsider,svc,s,message};
}

test('enable without recipients permits scoped ID access but never auto-lists it',async()=>{
  const {owner,a,b,outsider,svc,s}=await fixture();
  await assert.rejects(svc.openById(a,s.id));
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'all',forever:true});
  assert.equal((await svc.get(owner,s.id)).sharing,true);
  assert.deepEqual(await svc.sharedWithMe(a),[]);
  const opened=await svc.openById(a,`  ${s.id.toUpperCase()}  `);
  assert.equal(opened.id,s.id);
  assert.equal(opened.read_only,true);
  assert.equal((await svc.get(a,s.id)).my_role,'share_viewer');
  assert.equal((await svc.get(a,s.id)).read_only,true);
  assert.deepEqual(await svc.sharedWithMe(a),[]);
  assert.equal((await svc.messages(a,s.id))[0].body,'过去的消息');
  await assert.rejects(svc.openById(outsider,s.id));
  await assert.rejects(svc.openById({...b,orgId:'other'},s.id));
  await assert.rejects(svc.setLinkSharing(a,s.id,{enabled:false,range_type:'all'}));
  await assert.rejects(svc.postMessage(a,{session_id:s.id,body:'不能写'}));
});

test('from-now boundary is fixed when enabled, including later direct invitations',async()=>{
  const {owner,a,b,svc,s,message}=await fixture();
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'from_now',forever:true});
  message('开启之后');
  await svc.openById(a,s.id);
  await svc.share(owner,{session_id:s.id,grantee_user_id:b.userId,range_type:'from_now',forever:true});
  assert.deepEqual((await svc.messages(a,s.id)).map(m=>m.body),['开启之后']);
  assert.deepEqual((await svc.messages(b,s.id)).map(m=>m.body),['开启之后']);
  assert.equal((await svc.sharedWithMe(b)).length,1);
  assert.equal((await svc.sharedWithMe(a)).length,0);
});

test('direct invitations appear once; removing an invite removes it from the list',async()=>{
  const {owner,a,svc,s}=await fixture();
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'all',forever:true});
  await svc.openById(a,s.id);
  for(let i=0;i<2;i++)await svc.share(owner,{session_id:s.id,grantee_user_id:a.userId,range_type:'all',forever:true});
  assert.equal((await svc.sharedWithMe(a)).length,1);
  const shares=await svc.listShares(owner,s.id),active=shares.filter(s=>!s.revoked_at);
  assert.equal(active.length,1);
  await svc.revokeShare(owner,active[0].id);
  assert.equal((await svc.sharedWithMe(a)).length,0);
});

test('closing sharing revokes ID and direct access; re-enabling cannot restore wider old history',async()=>{
  const {owner,a,b,svc,s,message}=await fixture();
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'all',forever:true});
  await svc.openById(a,s.id);
  await svc.share(owner,{session_id:s.id,grantee_user_id:b.userId,range_type:'all',forever:true});
  await svc.setLinkSharing(owner,s.id,{enabled:false,range_type:'all',forever:true});
  for(const person of [a,b]){assert.equal(sessionAccess(person,s.id),null);await assert.rejects(svc.openById(person,s.id));}
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'from_now',forever:true});
  message('新的共享范围');
  await svc.openById(a,s.id);
  assert.deepEqual((await svc.messages(a,s.id)).map(m=>m.body),['新的共享范围']);
  await svc.share(owner,{session_id:s.id,grantee_user_id:b.userId,range_type:'from_now',forever:true});
  assert.equal((await svc.sharedWithMe(b)).length,1);
});

test('expired policies and grants cannot be opened or branched',async()=>{
  const {owner,a,svc,s,d}=await fixture();
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'all',days:1});
  await svc.openById(a,s.id);
  d.run("UPDATE session_link_shares SET expires_at='2000-01-01' WHERE session_id=?",s.id);
  assert.equal(sessionAccess(a,s.id),null);
  await assert.rejects(svc.openById(a,s.id));
  await assert.rejects(svc.forkShared(a,s.id,'expired'));
});

test('large histories do not hide new shared messages or truncate a personal branch',async()=>{
  const {owner,a,b,svc,s,message}=await fixture();
  for(let i=0;i<510;i++)message(`历史 ${i}`);
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'from_now',forever:true});
  message('最新的可见消息');
  await svc.openById(a,s.id);
  assert.deepEqual((await svc.messages(a,s.id)).map(m=>m.body),['最新的可见消息']);
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'all',forever:true});
  await svc.openById(b,s.id);
  const fork=await svc.forkShared(b,s.id,'large');
  assert.equal(fork.last_message_seq,512);
});

test('personal branch preserves only visible text, has no workspace, assets, refs or sharing, and remains independent',async()=>{
  const {owner,a,svc,s,message,d}=await fixture();
  await svc.setLinkSharing(owner,s.id,{enabled:true,range_type:'from_now',forever:true});
  message('保留的上下文','message',JSON.stringify({aux_ids:['secret'],parent_id:'msg1',file_id:'private'}));
  message('不复制产物','artifact');
  await svc.openById(a,s.id);
  const fork=await svc.forkShared(a,s.id,'copy-key');
  assert.equal(fork.owner_id,a.userId);assert.equal(fork.mode,'personal');assert.equal(fork.my_role,'coordinator');
  assert.equal(fork.binding.folder_id,null);assert.equal(fork.sharing,false);assert.equal(fork.share_id,null);
  assert.deepEqual(fork.context_snapshot,{});
  const copied=await svc.messages(a,fork.id);
  assert.deepEqual(copied.map(m=>m.body),['保留的上下文']);
  assert.deepEqual(copied[0].aux,{});assert.equal(copied[0].ref_id,null);
  assert.equal(d.val('SELECT COUNT(*) FROM runs WHERE session_id=?',fork.id),0);
  assert.equal((await svc.forkShared(a,s.id,'copy-key')).id,fork.id);
  await svc.postMessage(a,{session_id:fork.id,body:'继续对话'});
  assert.equal((await svc.messages(a,fork.id)).length,2);
  await svc.setLinkSharing(owner,s.id,{enabled:false,range_type:'all'});
  assert.equal((await svc.messages(a,fork.id)).length,2);
  await assert.rejects(svc.get(owner,fork.id));
  assert.ok((await svc.list(a,'personal')).some(r=>r.id===fork.id));
});

