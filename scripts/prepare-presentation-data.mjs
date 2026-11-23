// 只追加的展示用数据：不调用模型、不重置账号、不删除任何已有记录。
// 先在 FlowMate 目录执行 npm run build，再运行：node scripts/prepare-presentation-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { getDb } = require('../dist/server/core/db.js');
const { scheduler } = require('../dist/server/core/queue.js');
const { FilesService } = require('../dist/server/modules/files/files.service.js');
const { SessionsService } = require('../dist/server/modules/sessions/sessions.service.js');
const { MessagesService } = require('../dist/server/modules/messages/messages.service.js');
const { services } = require('../dist/server/core/contracts.js');
const { config } = require('../dist/server/core/config.js');
const d = getDb();
await scheduler.stop(); // Extraction is explicitly awaited below. Never start Agent workers.
const prefix = 'presentation-20261107';
const manifestPath = path.join(config.dataDir, `${prefix}.json`);
const source = path.resolve(config.root, '..', '测试文件');
const generated = path.join(source, '演示资料');
fs.mkdirSync(generated, { recursive: true });
const backups = path.join(config.root, 'backups');
if (!fs.existsSync(backups) || !fs.readdirSync(backups).some(n => n.startsWith('before-demo-') && fs.existsSync(path.join(backups, n, 'flowmate.sqlite3')))) {
  throw new Error('Back up the SQLite database and storage into backups/before-demo-* before running.');
}
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {
  fixture: prefix, created_at: new Date().toISOString(), note: '演示样例：对话、任务历史与用量均为合成记录；未调用模型、未产生费用。', entities: {}, files: []
};
function save() { fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); }
function id(key) { const h = createHash('sha256').update(`${prefix}:${key}`).digest('hex'); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; }
function insert(table, key, row) {
  const entityId = id(key);
  if (d.get(`SELECT id FROM ${table} WHERE id=?`, entityId)) return entityId;
  const data = { id: entityId, ...row };
  d.run(`INSERT INTO ${table} (${Object.keys(data).join(',')}) VALUES (${Object.keys(data).map(() => '?').join(',')})`, ...Object.values(data));
  return entityId;
}
const anchor = new Date('2026-11-07T09:00:00+08:00');
function when(days = 0, hours = 0) { return new Date(+anchor + days * 86400000 + hours * 3600000).toISOString(); }
function day(offset = 0) { return new Date(+anchor + offset * 86400000 + 8*3600000).toISOString().slice(0,10); }
const org = d.get('SELECT id FROM organizations WHERE name=?', '星屿科技').id;
const emails = ['baymax@xingyu.test', 'hy123@xingyu.test', 'cyx666@xingyu.test', 'xuyangtian@xingyu.test'];
const actors = emails.map(email => {
  const u = d.get('SELECT id,display_name FROM users WHERE email=?', email);
  const m = d.get('SELECT role FROM memberships WHERE user_id=? AND organization_id=?', u.id, org);
  return { userId:u.id, orgId:org, role:m.role, displayName:u.display_name };
});
const teams = ['产品团队','设计团队','研发团队'].map(name => d.get('SELECT id,name FROM teams WHERE organization_id=? AND name=?', org, name));
const files = new FilesService(); files.onModuleInit();
const sessions = new SessionsService(); services.sessions = sessions;
const messages = new MessagesService();
async function tracked(key, create) {
  if (manifest.entities[key]) return manifest.entities[key];
  const result = await create(); const value = result.id || result;
  manifest.entities[key] = value; save(); return value;
}
async function folder(actor, parent, name) {
  const existing = d.get("SELECT id FROM folders WHERE parent_id=? AND name=? AND status='active'", parent, name);
  return existing?.id || (await files.createFolder(actor, {parent_id:parent,name})).id;
}
async function upload(actor, folderId, name, content, key, offset = -5) {
  let fid = manifest.entities[key];
  if (!fid) {
    const local = path.join(generated, name);
    if (typeof content === 'string') { fs.writeFileSync(local, content); content = Buffer.from(content); }
    const r = await files.createFile(actor, {folder_id:folderId,name,buffer:content,change_source:'seed',summary:'演示资料导入'});
    fid = r.file.id; manifest.entities[key] = fid; manifest.files.push({id:fid,name,folder_id:folderId,owner:actor.userId}); save();
    // 只回写本次新增记录的时间戳，既有文档一律不动。
    d.run('UPDATE files SET created_at=?,updated_at=? WHERE id=?', when(offset),when(offset,2),fid);
    d.run('UPDATE file_versions SET created_at=? WHERE file_id=?',when(offset),fid);
  }
  const f = d.get('SELECT * FROM files WHERE id=?', fid);
  const v = d.get('SELECT * FROM file_versions WHERE id=?', f.current_version_id);
  await files.processExtraction(v.id);
  return {file:f,version:v};
}
const projects = ['市场进入与种子客户计划','营销方案 AI 审核平台','FlowMate 秋季产品发布','客户试点与交付保障'];
const personalRoots = [], personalFiles = [];
const deliverables = [
  ['2026年市场进入专题会议纪要.md','baymax交付_竞品审核流程调研表.xlsx'],
  ['虎牙交付_2026年Q1市场进入预算表.xlsx','2026年市场进入专题会议纪要.md'],
  ['陈奕迅交付_2026年市场进入方案汇报提纲.docx','营销方案AI审核工作平台_PRD.html'],
  ['许杨天交付_首批种子客户名单.xlsx','任务安排_2026年11月.txt']
];
for (let i=0;i<4;i++) {
  const a=actors[i]; await files.spaceRoots(a);
  const root=await tracked(`personal-space-${i}`,()=>files.createSpace(a,{name:'项目工作台'})); personalRoots.push(root);
  const materials=await folder(a,root,'项目资料'); const delivery=await folder(a,root,'交付成果');
  const pool=[];
  for (const [j,name] of deliverables[i].entries()) pool.push(await upload(a,materials,name,fs.readFileSync(path.join(source,name)),`original-${i}-${j}`,-9+j));
  const names=['阶段交付报告','客户需求与验收清单','产品上线检查表','试点复盘与改进方案','本周工作计划','风险跟进清单'];
  for (let j=0;j<names.length;j++) {
    const title=`${a.displayName}_${names[j]}`;
    const content=`# ${names[j]}\n\n项目：${projects[i]}\n负责人：${a.displayName}\n更新日期：2026-11-07\n\n## 本阶段目标\n完成客户需求、方案评审、交付验证与回访闭环，形成可验收的交付材料。\n\n## 关键进展\n- 已完成首轮需求访谈与范围确认，覆盖 12 个试点客户场景。\n- 核心流程已通过联调，验收清单中的 18 项已完成 15 项。\n- 已将方案、预算和客户反馈整理到项目资料中，供跨团队协作使用。\n\n## 行动清单\n|事项|负责人|截止日期|状态|\n|验收标准复核|${actors[(i+1)%4].displayName}|2026-11-09|进行中|\n|交付材料归档|${a.displayName}|2026-11-10|待验收|\n|试点客户回访|${actors[(i+2)%4].displayName}|2026-11-12|待开始|\n\n## 验收标准\n1. 数据口径与需求基线一致。\n2. 附件可以打开，关键结论有依据。\n3. 遗留事项明确负责人和完成时间。\n\n## 风险与应对\n部分客户反馈尚未回收，安排下周二集中追踪；发布前由产品与研发联合复核。\n\n> 本文为展示使用的合成项目资料。\n`;
    pool.push(await upload(a,j<4?delivery:materials,`${title}.md`,content,`personal-doc-${i}-${j}`,-6+j));
  }
  personalFiles.push(pool); console.log('Personal workspace ready:',a.displayName,pool.length);
  const defaultRoot=d.get("SELECT id FROM folders WHERE owner_id=? AND space='personal' AND parent_id IS NULL AND ifnull(is_space,0)=0 AND status='active'",a.userId).id;
  await upload(a,defaultRoot,`${a.displayName}_本周项目概览.md`,`# 本周项目概览\n\n## 当前项目\n${projects[i]}\n\n## 工作入口\n完整项目资料和交付成果位于左侧「项目工作台」空间；团队材料位于对应团队空间的「秋季项目协作」文件夹。\n\n## 本周重点\n- 完成核心交付与验收核对。\n- 关闭试点客户关键阻塞项。\n- 更新任务进度与交付附件。\n\n> 展示样例资料。\n`,`default-overview-${i}`,-1);
  await upload(a,defaultRoot,deliverables[i][0],fs.readFileSync(path.join(source,deliverables[i][0])),`default-original-${i}`,-3);
}
const teamRoots=[], teamFiles=[];
for(let i=0;i<3;i++) {
  const a=actors[i+1]; await files.spaceRoots(a);
  const base=d.get("SELECT id FROM folders WHERE team_id=? AND parent_id IS NULL AND status='active'",teams[i].id).id;
  const root=await tracked(`team-folder-${i}`,async()=>({id:await folder(actors[0],base,['秋季产品策划','秋 · 设计','Q3项目开发'][i])})); teamRoots.push(root);
  // Deliberate cross-team collaboration access for these demo folders only.
  await files.aclSet(actors[0],{kind:'folder',id:root,grants:actors.map(x=>({principal_type:'user',principal_id:x.userId,permission:x.userId===a.userId?'manager':'editor'}))});
  const pool=[];
  for(let j=0;j<6;j++) {
    const title=['项目里程碑与责任分工','需求基线与验收矩阵','周会纪要与决策清单','跨团队交接规范','发布风险与回滚预案','客户试点总结'][j];
    pool.push(await upload(a,root,`${teams[i].name}_${title}.md`,`# ${title}\n\n所属团队：${teams[i].name}\n项目：${projects[i]}\n\n## 项目概况\n本轮交付围绕需求澄清、方案设计、开发联调、试点验证四个阶段推进。\n\n## 责任分工\n${actors.map((x,k)=>`- ${x.displayName}：${['统筹计划与验收','需求与客户反馈','体验设计与交付材料','接口联调与质量验证'][k]}`).join('\n')}\n\n## 本周节点\n- 11 月 5 日：方案评审完成，确认验收口径。\n- 11 月 7 日：核心链路联调，输出问题清单。\n- 11 月 10 日：试点发布与客户培训。\n- 11 月 13 日：交付验收与复盘。\n\n## 决策与风险\n试点阶段保持范围稳定，新增需求进入下轮排期；高优问题当天反馈并明确处理人。\n\n> 演示样例资料。\n`,`team-doc-${i}-${j}`,-8+j));
  }
  // Include the user's actual Office/HTML material in shared workspaces too.
  const original=deliverables[i+1][0]; pool.push(await upload(a,root,original,fs.readFileSync(path.join(source,original)),`team-original-${i}`,-2));
  teamFiles.push(pool);
}

const workNames=[
  ['确认市场进入目标与资源范围','整理竞品审核流程调研结论','完善试点客户分层策略','评审市场进入预算与资源配置','整理跨团队交付验收基线','跟进种子客户访谈反馈','完成首轮竞品流程调研交付','确认试点项目验收标准','跟进客户方案中的待确认问题','汇总发布前跨团队阻塞项','归档市场进入阶段交付报告','完成渠道试点复盘与建议','评审下阶段市场增长实验','整理客户价值与产品能力映射','输出季度市场进入路线图'],
  ['梳理营销审核平台需求范围','完善内容审核规则与例外场景','校对预算拆分与投入产出测算','确认营销方案审核流转角色','补齐审核结果导出验收条件','整理首批客户产品反馈','交付市场进入预算测算表','确认营销审核 MVP 需求基线','跟进预算审批与资源到位','完善客户试点培训与演示脚本','归档试点客户需求分析','完成产品方案评审与交接','准备产品试点复盘材料','整理需求变更影响清单','输出第二阶段产品迭代计划'],
  ['设计产品发布视觉与组件规范','完善审核结果页信息层级','校对移动端表单交互细节','评审客户汇报材料信息结构','补齐异常状态与空状态设计','跟进试点客户体验反馈','交付市场进入方案汇报提纲','完成产品发布视觉规范验收','制作客户演示与培训素材','完善版本发布说明与配图','归档审核平台交互设计方案','完成设计走查与体验验收','整理产品发布展示案例','复核首页看板图表与数据口径','输出下一阶段体验优化清单'],
  ['制定客户试点联调与发布计划','完善审核接口异常处理','校对试点客户数据与授权范围','确认上线回滚与监控方案','补齐数据导出自动化检查','跟进种子客户数据接入进度','交付首批种子客户名单','完成核心接口联调验收','跟进测试环境遗留问题修复','完善发布前巡检与告警规则','归档试点运行质量报告','完成客户试点上线与交付','整理客户数据对账与校验报告','复核接口性能与容量指标','输出试点保障与值班安排']
];
const states=['ready_to_assign','pending_accept','accepted','in_progress','pending_review','in_progress','completed','completed','pending_accept','in_progress','completed','completed','pending_review','in_progress','ready_to_assign'];
const taskIds=[];
for(let i=0;i<4;i++) for(let j=0;j<15;j++) {
  const a=actors[i], creator=actors[(i+3)%4], reviewer=actors[(i+1)%4], previous=actors[(i+2)%4];
  const st=states[j], done=st==='completed', review=st==='pending_review', updated=when(done?({6:-5,7:-3,10:-1,11:0}[j]):0,-2+(j/30));
  const created=done?new Date(Date.parse(updated)-4*86400000).toISOString():when(j===0||j===14?0:-7+j%7,i/4);
  const handedAt=done?new Date(Date.parse(updated)-2*86400000).toISOString():when(-1,j/16+i/10);
  const acceptedAt=done?new Date(Date.parse(updated)-86400000).toISOString():when(-1,2+j/16+i/10);
  const criteria=[{id:id(`criterion-${i}-${j}-1`),text:'交付内容覆盖需求范围，关键数据来源明确',required:true},{id:id(`criterion-${i}-${j}-2`),text:'文件可打开，验收结果和后续行动清晰',required:true}];
  const handlers=[previous.userId,a.userId];
  const history=st==='ready_to_assign'?[]:[{user_id:previous.userId,accepted_at:new Date(Date.parse(created)+360000).toISOString(),ended_at:handedAt,action:'handoff_next',duration_ms:(90+j*12)*60000}];
  if(!['ready_to_assign','pending_accept'].includes(st)) history.push({user_id:a.userId,accepted_at:acceptedAt,ended_at:done||review?updated:null,action:done||review?'submit':'accept',...(done||review?{duration_ms:(120+j*14)*60000}:{})});
  const taskId=insert('tasks',`task-${i}-${j}`,{organization_id:org,title:workNames[i][j],description:`${projects[i]}的阶段行动项。\n请参考项目工作台中的原始资料，完成核对、协作交接与交付。\n交付前确认数据口径、异常处理和验收材料完整。`,project:projects[i],expected_deliverable:`${workNames[i][j]}：可查看的交付文档及验收说明`,status:st,creator_id:j===0||j===14?a.userId:creator.userId,assignee_id:st==='ready_to_assign'?null:a.userId,reviewer_id:reviewer.userId,team_id:teams[Math.min(2,Math.max(0,i-1))].id,priority:['high','normal','normal','urgent','high','low'][j%6],due_at:when(done?-1+(j%3):j===9?-1:j%5,9),criteria,source:'manual',source_ref:{demo_fixture:prefix},progress:done||review?100:st==='in_progress'?35+j*3:st==='accepted'?10:0,created_at:created,updated_at:updated,handlers:st==='ready_to_assign'?[]:handlers,handler_index:1,handler_log:history,folder_id:personalRoots[i],schedule_date:['accepted','in_progress'].includes(st)?day(j===2?-2:j===3?0:j===5?1:j===9?-1:2):null,schedule_start:['accepted','in_progress'].includes(st)?`${String(9+(j%4)*2).padStart(2,'0')}:00`:null,schedule_end:['accepted','in_progress'].includes(st)?`${String(10+(j%4)*2).padStart(2,'0')}:30`:null,estimate_min:90,schedule_note:'按验收节点预留专注处理时间',task_type:['调研','需求','设计','研发'][i]});
  taskIds.push(taskId);
  // Normalize only our deterministic fixture rows on reruns; never edit existing user tasks.
  d.run('UPDATE tasks SET created_at=?,updated_at=?,handler_log=? WHERE id=?',created,updated,history,taskId);
  insert('task_transitions',`transition-create-${i}-${j}`,{task_id:taskId,to_status:'ready_to_assign',actor_id:j===0||j===14?a.userId:creator.userId,action:'create',note:'明确范围、验收标准与交付节点',created_at:created});
  d.run('UPDATE task_transitions SET created_at=? WHERE id=?',created,id(`transition-create-${i}-${j}`));
  if(st!=='ready_to_assign') {
    insert('task_transitions',`transition-assign-${i}-${j}`,{task_id:taskId,from_status:'ready_to_assign',to_status:'pending_accept',actor_id:creator.userId,action:'assign',fields:{handlers,next:previous.userId},note:'按跨团队处理链安排协作',created_at:when(-10,j/20)});
    d.run('UPDATE task_transitions SET created_at=? WHERE id=?',new Date(Date.parse(created)+180000).toISOString(),id(`transition-assign-${i}-${j}`));
    insert('task_transitions',`transition-handoff-${i}-${j}`,{task_id:taskId,from_status:'in_progress',to_status:'pending_accept',actor_id:previous.userId,action:'handoff_next',fields:{next:a.userId,handlers},note:'上游资料已整理，请继续完成方案与交付核对',created_at:handedAt});
    d.run('UPDATE task_transitions SET created_at=? WHERE id=?',handedAt,id(`transition-handoff-${i}-${j}`));
    if(!['pending_accept'].includes(st)) {
      insert('task_transitions',`transition-accept-${i}-${j}`,{task_id:taskId,from_status:'pending_accept',to_status:'accepted',actor_id:a.userId,action:'accept',note:'已确认交接材料与处理范围',created_at:acceptedAt});
      d.run('UPDATE task_transitions SET created_at=? WHERE id=?',acceptedAt,id(`transition-accept-${i}-${j}`));
      insert('task_progress',`progress-${i}-${j}`,{task_id:taskId,user_id:a.userId,done_text:'已完成资料核对与核心方案梳理，验收材料同步整理中',blocked_text:j===9?'等待试点客户确认补充数据':null,progress:done||review?100:50,created_at:when(-1,3+j/16)});
      if(done) d.run('UPDATE task_progress SET created_at=? WHERE id=?',new Date(Date.parse(updated)-3600000).toISOString(),id(`progress-${i}-${j}`));
    }
  }
  if(done||review) {
    const record=personalFiles[i][2+(j%4)]; const v=record.version;
    await files.aclSet(a,{kind:'file',id:record.file.id,grants:actors.filter(x=>x.userId!==a.userId).map(x=>({principal_type:'user',principal_id:x.userId,permission:'viewer'}))});
    const submission=insert('task_submissions',`submission-${i}-${j}`,{task_id:taskId,seq:1,submitter_id:a.userId,file_version_ids:[v.id],file_snapshot:[{file_id:record.file.id,version_id:v.id,name:record.file.name,version_no:v.version_no,sha256:v.sha256}],note:'已完成本阶段交付，关键结论、验收清单与遗留事项见附件。',status:done?'approved':'pending',created_at:updated});
    d.run('UPDATE task_submissions SET created_at=? WHERE id=?',updated,submission);
    insert('task_transitions',`transition-submit-${i}-${j}`,{task_id:taskId,from_status:'in_progress',to_status:'pending_review',actor_id:a.userId,action:'submit',note:'提交交付文件并申请验收',created_at:updated});
    d.run('UPDATE task_transitions SET created_at=? WHERE id=?',updated,id(`transition-submit-${i}-${j}`));
    if(done) {
      insert('task_reviews',`review-${i}-${j}`,{task_id:taskId,submission_id:submission,reviewer_id:reviewer.userId,decision:'approve',per_criteria:criteria.map(c=>({criterion_id:c.id,pass:true,note:'符合本轮验收范围'})),note:'交付材料完整，验收通过。后续改进项已进入下一轮计划。',created_at:updated});
      insert('task_transitions',`transition-complete-${i}-${j}`,{task_id:taskId,from_status:'pending_review',to_status:'completed',actor_id:reviewer.userId,action:'approve',note:'验收通过，完成归档',created_at:updated});
      d.run('UPDATE task_reviews SET created_at=? WHERE id=?',updated,id(`review-${i}-${j}`));
      d.run('UPDATE task_transitions SET created_at=? WHERE id=?',updated,id(`transition-complete-${i}-${j}`));
    }
  }
}
console.log('Tasks ready:',taskIds.length);

const groupNames=['秋季产品发布协作群','市场进入与客户试点','营销审核平台项目组','交付质量与验收同步'];
const conversationIds=[];
for(let g=0;g<4;g++) {
  const a=actors[g];
  const cid=await tracked(`group-${g}`,()=>messages.createConversation(a,{type:'project',name:groupNames[g],member_ids:actors.map(x=>x.userId),team_id:teams[g%3].id})); conversationIds.push(cid);
  const lines=[`大家好，这个群用于同步${projects[g]}的进展、交接和验收。`,`我把需求和材料整理到项目工作台了，本轮先确认范围，再安排联调。`,`收到，重点关注数据口径、异常场景和最终交付格式。`,`我今天先核对客户资料，下午同步待确认问题。`,`本轮先覆盖 12 个试点客户，新增需求先进入后续迭代清单。`,`预算、名单和汇报提纲都已齐备，评审时可以直接对照。`,`核心流程已走通，剩余问题清单已更新，请大家认领各自的事项。`,`方案中的权限边界已经补充，等待研发确认接口异常处理。`,`验收清单建议增加文件可打开、数据可追溯两项。`,`已补充。交付材料请使用同一份验收基线，避免反复核对。`,`收到，我会把客户反馈与本轮调整一并整理成简短复盘。`,`联调进度正常，发布前还会复核监控和回滚预案。`,`需要验收的文件已发出，麻烦在明天下午前完成核对。`,`我这边已经看过，关键数据一致，可以按既定计划推进。`,`下一轮重点跟进试点回访、使用反馈和遗留问题关闭。`,`辛苦大家，本周交付有进展后直接在群里同步即可。`];
  let first=null;
  for(let n=0;n<lines.length;n++) {
    const sender=actors[(g+n)%4];
    const msg=await messages.send(sender,{conversation_id:cid,body:lines[n],client_msg_id:`${prefix}-g${g}-${n}`,...(n===3&&first?{parent_id:first}:{})});
    if(n===0)first=msg.id;
    d.run('UPDATE messages SET created_at=? WHERE id=?',when(-4+Math.floor(n/4),n%4),msg.id);
  }
  const f=personalFiles[g][0];
  await messages.shareFile(a,f.file.id,{conversation_id:cid,client_msg_id:`${prefix}-g${g}-file`});
  await messages.send(a,{conversation_id:cid,body:'这项任务的交付与验收请在任务页继续跟进。',card_type:'task',card_id:taskIds[g*15+4],client_msg_id:`${prefix}-g${g}-task`});
  d.run('UPDATE conversations SET last_message_at=? WHERE id=?',when(0,6+g/10),cid);
}
for(let i=0;i<4;i++) for(let j=i+1;j<4;j++) {
  const cid=await tracked(`dm-${i}-${j}`,()=>messages.createConversation(actors[i],{type:'dm',member_ids:[actors[j].userId]})); conversationIds.push(cid);
  const lines=[`你好，${actors[j].displayName}，想和你确认一下本周交付的衔接。`,'没问题，相关资料已经整理好了，重点是需求范围和验收口径。','我看了最新版，客户反馈中的三个问题建议单独列出。','已更新到风险清单，今天下午可以一起过一遍。','好的，我会把需要你确认的内容在文档里标注清楚。','时间安排可以，预计 30 分钟能完成重点核对。','验收附件我已经补充，交付任务也同步更新了。','收到，我们按这个版本继续推进。谢谢！'];
  for(let n=0;n<lines.length;n++) {const msg=await messages.send(actors[n%2?j:i],{conversation_id:cid,body:lines[n],client_msg_id:`${prefix}-dm${i}${j}-${n}`}); d.run('UPDATE messages SET created_at=? WHERE id=?',when(-2+Math.floor(n/4),n%4+0.1*j),msg.id);}
  await messages.shareFile(actors[i],personalFiles[i][1].file.id,{conversation_id:cid,client_msg_id:`${prefix}-dm${i}${j}-file`});
  d.run('UPDATE conversations SET last_message_at=? WHERE id=?',when(0,4+(i+j)/10),cid);
}
// Set list state only for newly created fixture groups, leaving existing DM preferences intact.
for(let i=0;i<4;i++) for(let g=0;g<4;g++) {
  d.run('UPDATE conversation_members SET pinned_at=?,muted=?,last_read_at=? WHERE conversation_id=? AND user_id=?',g===i?when(-2):null,g===(i+2)%4?1:0,when(0,5+g/10),conversationIds[g],actors[i].userId);
}
console.log('Message conversations ready:',conversationIds.length);

const officeTitles=['阶段交付报告与风险梳理','客户需求分析与验收准备','本周工作复盘与下周计划','试点材料检索与会议准备'];
const officeIds=[];
async function office(actor, key, title, folderId, pool, teamIndex=null) {
  const sid=await tracked(key,()=>teamIndex===null?sessions.createPersonal(actor,{title,folder_id:folderId,include_children:true}):sessions.createTeamSession(actor,{title,folder_id:folderId,team_id:teams[teamIndex].id,participant_ids:actors.map(x=>x.userId)}));
  officeIds.push(sid);
  const userLines=['请先梳理这个工作区的资料，给我一份本阶段工作概览。','请重点分析交付前需要确认的风险和验收事项。','把结论整理成下次周会可以直接使用的行动清单。','还需要哪些同事配合？请按责任与时间列出来。','好的，最后给我一个简短的汇报版本。'];
  const answers=[`## 本阶段工作概览\n\n当前工作区围绕${title}整理了项目资料与交付文件。\n\n- **已有材料**：${pool.slice(0,3).map(x=>x.file.name).join('、')}。\n- **主要进展**：需求基线、阶段方案和客户反馈已有明确材料。\n- **建议顺序**：先核对范围与验收标准，再明确责任与交付时间。`,
  '## 交付前重点核对\n\n1. **口径一致**：预算、客户名单与方案中的数据要相互对应。\n2. **范围明确**：试点新增需求进入后续迭代，避免影响本轮发布。\n3. **材料完整**：交付文件、验收清单和遗留事项都需要有明确负责人。\n\n建议发布前安排一次跨团队核对，优先处理影响客户试点的阻塞项。',
  `## 周会行动清单\n\n|事项|负责人|时间|\n|确认需求与验收口径|${actors[1].displayName}|下周一|\n|完善汇报与演示材料|${actors[2].displayName}|下周二|\n|核对客户数据与联调结果|${actors[3].displayName}|下周二|\n|统筹交付与验收结论|${actors[0].displayName}|下周三|\n\n所有事项建议在对应任务中更新进度与附件。`,
  '建议由产品负责范围和客户反馈，设计负责汇报与演示材料，研发负责接口、数据与发布检查；项目负责人统一确认优先级和验收节点。依赖项在周会前提前同步，减少交接等待。',
  '本阶段已完成资料汇总和核心方案梳理，交付准备进入核对与验收阶段。下一步聚焦三个方面：统一验收口径、关闭关键阻塞、完成客户试点回访。新增需求进入后续迭代，确保当前交付范围稳定。'];
  for(let n=0;n<10;n++) {
    insert('session_messages',`${key}-message-${n}`,{session_id:sid,organization_id:org,seq:n+1,sender_user_id:n%2===0?actor.userId:null,sender_label:n%2===0?actor.displayName:'FlowMate',role:n%2===0?'user':'agent',kind:'message',body:n%2===0?userLines[n/2]:answers[(n-1)/2],aux:{demo_fixture:prefix},created_at:when(-3+Math.floor(n/4),n%4)});
  }
  const rid=insert('requests',`${key}-request`,{organization_id:org,session_id:sid,creator_id:actor.userId,goal:userLines[2],output_kind:'draft',write_scope:[folderId],risk:'low',status:'completed',plan:[{id:'read',name:'核对项目资料'},{id:'summary',name:'形成行动清单'}],created_at:when(-1),updated_at:when(-1,1),planner:'demo-seed'});
  const runid=insert('runs',`${key}-run`,{organization_id:org,request_id:rid,session_id:sid,subtask_id:'summary',subtask_name:'项目资料梳理与行动清单',status:'succeeded',read_set:pool.slice(0,3).map(x=>({file_id:x.file.id,version_id:x.version.id})),context_snapshot:{demo_fixture:prefix},started_at:when(-1),finished_at:when(-1,0.05),created_at:when(-1),updated_at:when(-1,0.05),planner:'demo-seed',output_kind:'draft'});
  insert('run_steps',`${key}-step`,{run_id:runid,step_index:1,tool_name:'fs.read',args_digest:{files:pool.slice(0,3).map(x=>x.file.name),demo_fixture:prefix},read_version_ids:pool.slice(0,3).map(x=>x.version.id),output_digest:'演示资料梳理完成',output_bytes:3000,duration_ms:1200,status:'success',created_at:when(-1),planner:'demo-seed'});
  const result=await upload(actor,folderId,`${title}_行动清单.md`,`# ${title}\n\n${answers[2]}\n\n## 汇报摘要\n${answers[4]}\n\n> 展示用合成办公产物。\n`,`${key}-artifact-file`,-1);
  const artifact=insert('artifacts',`${key}-artifact`,{organization_id:org,run_id:runid,request_id:rid,session_id:sid,creator_id:actor.userId,kind:'report',name:`${title}_行动清单`,format:'markdown',draft_file_id:result.file.id,draft_version_id:result.version.id,status:'committed',saved_file_id:result.file.id,saved_version_id:result.version.id,created_at:when(-1,0.05),updated_at:when(-1,0.05)});
  insert('session_messages',`${key}-artifact-message`,{session_id:sid,organization_id:org,seq:11,role:'agent',sender_label:'FlowMate',kind:'artifact',body:'行动清单已整理，可在右侧产物中查看。',ref_type:'artifact',ref_id:artifact,aux:{demo_fixture:prefix},created_at:when(0,1)});
  d.run('UPDATE agent_sessions SET last_message_seq=11,last_active_at=?,updated_at=?,favorite=? WHERE id=?',when(0,1),when(0,1),key.endsWith('-0')?1:0,sid);
  return sid;
}
for(let i=0;i<4;i++) {
  for(let j=0;j<4;j++) {
    const sid=await office(actors[i],`office-${i}-${j}`,`${projects[i]} · ${officeTitles[j]}`,personalRoots[i],personalFiles[i]);
    if(j===0) insert('session_shares',`office-share-${i}`,{session_id:sid,organization_id:org,grantee_user_id:actors[(i+1)%4].userId,range_type:'all',range_payload:{},aux_image_ids:[],file_snapshot:[],created_by:actors[i].userId,created_at:when(-1),expires_at:when(365)});
  }
  for(let n=0;n<14;n++) insert('usage_records',`usage-${i}-${n}`,{organization_id:org,session_id:manifest.entities[`office-${i}-${n%4}`],provider:'demo-seed',model:'展示样例（未实际调用）',input_tokens:1800+i*420+n*137,output_tokens:500+i*90+n*43,calls:1,failures:0,cost_estimate:0,user_id:actors[i].userId,created_at:when(-6+Math.floor(n/2),n%2?6:2)});
}
for(let i=0;i<3;i++) for(let j=0;j<3;j++) await office(actors[i+1],j===0?`office-team-${i}`:`office-team-${i}-${j}`,`${teams[i].name} · ${['项目交付与跨团队协作','试点问题跟进与客户反馈','发布评审与下周协作计划'][j]}`,teamRoots[i],teamFiles[i],i);
manifest.summary={tasks:taskIds.length,conversations:conversationIds.length,office_sessions:officeIds.length,files:manifest.files.length,synthetic_usage_records:56};
manifest.completed_at=new Date().toISOString(); save();
console.log(JSON.stringify({manifest:manifestPath,...manifest.summary},null,2));
await scheduler.stop();
d.close();
process.exit(0); // Event-bus maintenance timers are intentionally not started/awaited by this offline CLI.
