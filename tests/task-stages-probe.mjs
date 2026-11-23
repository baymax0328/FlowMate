// FlowMate · 第4条「环节化多经手人」后端语义回归探针
// 真实调用运行中的实例（禁止默认 8080）：E2E_BASE=http://127.0.0.1:<port>/api/v1
// 覆盖：同环节多人各自接收 / 全部交接才推进 / 单人退出不打回、全部退回落回创建人 / 环节顺序
import { probeBase } from './probe-base.mjs';
const B = probeBase(['E2E_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123';
const ACC = { lead: 'baymax@xingyu.test', a: 'hy123@xingyu.test', b: 'cyx666@xingyu.test' };

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`); };

class Client {
  constructor() { this.cookie = ''; this.org = ''; }
  async login(email) {
    const res = await fetch(B + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' }, body: JSON.stringify({ email, password: PW }) });
    if (!res.ok) throw new Error(`login ${email} → ${res.status}`);
    this.cookie = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0];
    const me = await this.get('/auth/me'); this.userId = me.data.user.id; this.org = (me.data.organizations ?? [])[0]?.id ?? '';
    return this;
  }
  async req(method, path, body, q) {
    const headers = { cookie: this.cookie, 'X-FlowMate-Client': 'web' }; if (this.org) headers['X-Organization-Id'] = this.org;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const qs = q ? '?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '')).toString() : '';
    const res = await fetch(B + path + qs, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await res.json().catch(() => ({})); return { status: res.status, data: j.data, error: j.error };
  }
  get(p, q) { return this.req('GET', p, undefined, q); }
  post(p, b) { return this.req('POST', p, b ?? {}); }
}

const a = await new Client().login(ACC.a);
const b = await new Client().login(ACC.b);
const L = await new Client().login(ACC.lead);

const mk = async () => {
  const r = await L.post('/tasks', { title: '多经手人探针任务 ' + Date.now(), status: 'ready_to_assign' });
  return r.data.id;
};

// —— 场景1：同一环节两人各自接收，全部交接才推进；第二环节单人 → 验收
{
  const id = await mk();
  const assigned = await L.post(`/tasks/${id}/assign`, { stages: [[a.userId, b.userId], [a.userId]], reviewer_id: b.userId, due_at: '2026-12-31' });
  ok('S1 指派落进第1环节 pending_accept', assigned.data?.status === 'pending_accept', assigned.data?.status);
  const stageShape = await L.get(`/tasks/${id}`);
  ok('S1 stages 结构落库为两环节', Array.isArray(stageShape.data?.stages) && stageShape.data.stages.length === 2 && stageShape.data.stages[0].length === 2,
    JSON.stringify(stageShape.data?.stage_users));

  const aRecv = (await a.get('/tasks', { scope: 'mine', tab: 'receive' })).data.items.some(t => t.id === id);
  const bRecv = (await b.get('/tasks', { scope: 'mine', tab: 'receive' })).data.items.some(t => t.id === id);
  ok('S1 a、b 都能在「接收」看到', aRecv && bRecv, `a=${aRecv} b=${bRecv}`);

  // a 先接收
  const accA = await a.post(`/tasks/${id}/accept`, { estimate_min: 60 });
  ok('S1 a 接收 → 全局 accepted', accA.data?.status === 'accepted', accA.data?.status);
  const aWork = (await a.get('/tasks', { scope: 'mine', tab: 'work' })).data.items.some(t => t.id === id);
  const bRecv2 = (await b.get('/tasks', { scope: 'mine', tab: 'receive' })).data.items.some(t => t.id === id);
  ok('S1 a 转「负责」、b 仍在「接收」', aWork && bRecv2, `aWork=${aWork} bRecv=${bRecv2}`);

  // a 交接：b 未交接，环节不应推进
  await a.post(`/tasks/${id}/handoff-next`, {});
  const stillStage0 = await L.get(`/tasks/${id}`);
  ok('S1 a 交接后仍停第1环节（b 未交接）', stillStage0.data?.status === 'accepted' && Number(stillStage0.data?.handler_index) === 0,
    `${stillStage0.data?.status}/idx=${stillStage0.data?.handler_index}`);
  const aWorkAfter = (await a.get('/tasks', { scope: 'mine', tab: 'work' })).data.items.some(t => t.id === id);
  ok('S1 a 交接后离开「负责」（handed_off）', !aWorkAfter);

  // b 接收 → 交接 → 全部交接 → 推进第2环节（a 单独）
  await b.post(`/tasks/${id}/accept`, { estimate_min: 60 });
  const handB = await b.post(`/tasks/${id}/handoff-next`, {});
  ok('S1 b 交接后推进到第2环节 pending_accept', handB.data?.status === 'pending_accept' && Number(handB.data?.handler_index) === 1,
    `${handB.data?.status}/idx=${handB.data?.handler_index}`);

  // 第2环节 a 交接 → 进验收
  await a.post(`/tasks/${id}/accept`, { estimate_min: 30 });
  const toReview = await a.post(`/tasks/${id}/handoff-next`, {});
  ok('S1 末环节交接完成 → pending_review', toReview.data?.status === 'pending_review', toReview.data?.status);
  // 详情链：创建人 + 2 环节 + 交付人
  const chain = (await L.get(`/tasks/${id}`)).data.chain;
  const stagesInChain = chain.filter(c => c.role === 'stage');
  ok('S1 buildChain 环节数=2', stagesInChain.length === 2, JSON.stringify(stagesInChain.map(s => ({ i: s.index, n: s.members.length, state: s.state }))));
  void b.userId;
}

// —— 场景2：单人退出不打回创建人；全部退回才回退
{
  const id = await mk();
  await L.post(`/tasks/${id}/assign`, { stages: [[a.userId, b.userId]], reviewer_id: b.userId, due_at: '2026-12-31' });
  const rjA = await a.post(`/tasks/${id}/reject`, { note: '我这会儿没空' });
  ok('S2 a 单人退回后任务不回创建人（b 仍可接收）', rjA.data?.status === 'pending_accept', rjA.data?.status);
  const bStillRecv = (await b.get('/tasks', { scope: 'mine', tab: 'receive' })).data.items.some(t => t.id === id);
  ok('S2 b 仍能在「接收」看到', bStillRecv);
  await b.post(`/tasks/${id}/accept`, { estimate_min: 60 });
  const workAfter = await L.get(`/tasks/${id}`);
  ok('S2 b 接收后任务进入负责、不回退', ['accepted', 'in_progress'].includes(workAfter.data?.status), workAfter.data?.status);
}

// —— 场景3：全部退回才回落到创建人
{
  const id = await mk();
  await L.post(`/tasks/${id}/assign`, { stages: [[a.userId, b.userId]], reviewer_id: b.userId, due_at: '2026-12-31' });
  await a.post(`/tasks/${id}/reject`, { note: '一' });
  const back = await b.post(`/tasks/${id}/reject`, { note: '二' });
  ok('S3 全部退回 → 回落创建人 ready_to_assign + returned', back.data?.status === 'ready_to_assign' && back.data?.returned === true,
    `${back.data?.status}/returned=${back.data?.returned}`);
}

// —— 场景4：线性 handlers（老载荷）仍折算为每人一个环节
{
  const id = await mk();
  const assigned = await L.post(`/tasks/${id}/assign`, { handlers: [a.userId, b.userId], reviewer_id: b.userId, due_at: '2026-12-31' });
  ok('S4 老 handlers 兼容：两环节', assigned.data?.status === 'pending_accept' && Number(assigned.data?.handler_index) === 0 && assigned.data?.stage_users?.length === 2,
    JSON.stringify(assigned.data?.stage_users));
}

console.log('———————————— 汇总 ————————————');
console.log(JSON.stringify({ pass, fail }));
process.exit(fail ? 1 : 0);
