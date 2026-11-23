// C11 / C12 精确验证：提醒节奏 → 超阈值挂起（绝不自动通过）→ 唤醒 / 作废 → 基准漂移后旧签名不可复用 → 重算差异才写入
const { probeBase, seedPassword } = require('./probe-base.cjs');
const B = probeBase();
const PW = seedPassword();
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (n, p, d = '') => { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  · ' + d : ''}`); if (!p) fails++; };

async function mk(email) {
  const r = await fetch(B + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' }, body: JSON.stringify({ email, password: PW }) });
  const cookie = r.headers.getSetCookie()[0].split(';')[0];
  const me = await (await fetch(B + '/auth/me', { headers: { cookie, 'X-FlowMate-Client': 'web' } })).json();
  return { cookie, org: me.data.organizations[0].id, uid: me.data.user.id };
}
async function req(c, method, p, body) {
  const headers = { cookie: c.cookie, 'X-FlowMate-Client': 'web', 'X-Organization-Id': c.org };
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(B + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data, error: j.error };
}
const withDb = (fn) => { const d = new DatabaseSync(path.resolve('data/flowmate.sqlite3')); try { return fn(d); } finally { d.close(); } };
async function waitStatus(L, id, want, ms = 110000) {
  const end = Date.now() + ms;
  let cur = null;
  while (Date.now() < end) {
    cur = (await req(L, 'GET', `/proposals/${id}`)).data;
    if (cur && want.includes(cur.status)) return cur;
    await sleep(3000);
  }
  return cur;
}

(async () => {
  const L = await mk('baymax@xingyu.test');
  const A = await mk('hy123@xingyu.test');
  const spaces = (await req(L, 'GET', '/spaces')).data;
  const orgRoot = spaces.find((s) => s.space === 'org');
  const kb = ((await req(L, 'GET', `/folders/${orgRoot.id}/children`)).data.folders || []).find((f) => f.name === '产品知识库');
  const portal = ((await req(L, 'GET', `/folders/${kb.id}/children`)).data.folders || []).find((f) => f.name === '客户门户改版');
  const teams = (await req(L, 'GET', '/teams')).data;

  async function makeProposal(tag) {
    const file = (await req(L, 'POST', '/files', { folder_id: portal.id, name: `${tag}${Date.now()}.md`, format: 'markdown', content: `# ${tag}\n\n初始内容。\n` })).data;
    const sess = (await req(L, 'POST', '/agent/sessions/team', { title: `${tag}会话${Date.now()}`, team_id: teams[0].id, folder_id: portal.id, participant_ids: [L.uid, A.uid] })).data;
    await req(A, 'POST', `/agent/sessions/${sess.id}/requests`, { goal: `在${tag}文档中补充一条可判定的验收标准`, output_kind: 'formal_change', target_file_id: file.file.id });
    for (let i = 0; i < 45; i++) {
      await sleep(700);
      const list = (await req(L, 'GET', `/proposals?session_id=${sess.id}`)).data ?? [];
      const p = list.find((x) => x.target_file_id === file.file.id);
      if (p) return { p, file, sess };
    }
    throw new Error(`${tag}：未生成提案`);
  }

  // ---------- 1. 提醒节奏：只让提醒到期，挂起阈值仍在未来 ----------
  const { p: p1, file: f1 } = await makeProposal('提醒验证');
  withDb((d) => d.prepare('UPDATE proposals SET next_reminder_at=?, suspend_deadline_at=? WHERE id=?')
    .run(new Date(Date.now() - 2000).toISOString(), new Date(Date.now() + 6 * 3600000).toISOString(), p1.id));
  // 提醒由 60 秒一轮的 tick 驱动：必须等过一轮再判定，否则读到的是提醒发生前的快照
  let afterReminder = null;
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    afterReminder = (await req(L, 'GET', `/proposals/${p1.id}`)).data;
    if (Number(afterReminder?.reminder_count ?? 0) >= 1) break;
  }
  ok('到期先提醒：reminder_count 增加且状态不变（提醒≠同意）',
    Number(afterReminder?.reminder_count ?? 0) >= 1 && afterReminder?.status === 'pending_approval',
    `reminder_count=${afterReminder?.reminder_count} · status=${afterReminder?.status}`);
  const notif1 = (await req(A, 'GET', '/notifications?limit=60')).data ?? [];
  ok('提醒以应用内通知送达相关指令人（本版不外发）', notif1.some((n) => /共同确认|待你|搁置/.test(String(n.title))), notif1[0]?.title ?? '');

  // ---------- 2. 超阈值挂起 / 唤醒 / 作废 ----------
  withDb((d) => d.prepare('UPDATE proposals SET suspend_deadline_at=? WHERE id=?').run(new Date(Date.now() - 2000).toISOString(), p1.id));
  const suspended = await waitStatus(L, p1.id, ['suspended']);
  ok('超阈值转「已搁置」，绝不自动通过', suspended?.status === 'suspended', `status=${suspended?.status}`);
  ok('挂起期间正式文件仍未写入', ((await req(L, 'GET', `/files/${f1.file.id}/versions`)).data ?? []).length === 1);
  const runs1 = (await req(L, 'GET', `/agent/sessions/${suspended.session_id}/runs`)).data ?? [];
  ok('受影响 Run 不占执行槽（挂起后无 running/waiting_approval 残留）',
    runs1.every((r) => !['running'].includes(r.status)), `共 ${runs1.length} 个 Run`);
  const wake = await req(L, 'POST', `/proposals/${p1.id}/wake`, {});
  ok('协调者可唤醒回待确认', wake.data?.status === 'pending_approval', `status=${wake.data?.status}`);
  const voided = await req(L, 'POST', `/proposals/${p1.id}/void`, { action: 'void', reason: '验证：作废提案' });
  ok('协调者可作废提案并留痕', voided.status === 201 && ['cancelled', 'voided'].includes(voided.data?.status ?? ''), `status=${voided.data?.status}`);

  // ---------- 3. 基准漂移：旧签名不可复用，重算差异后才写入 ----------
  const { p: p2, file: f2 } = await makeProposal('基准漂移验证');
  const baseV = (await req(L, 'GET', `/files/${f2.file.id}/versions`)).data?.[0];
  await req(L, 'POST', `/files/${f2.file.id}/content`, { content: '# 基准漂移验证\n\n别人先改了一版。\n', base_version_id: baseV.id, summary: '制造基准变化' });
  const drifted = await waitStatus(L, p2.id, ['stale']);
  ok('基准变化后提案自动转 stale（必须重算差异再确认）', drifted?.status === 'stale', `status=${drifted?.status}`);
  const staleApprove = await req(A, 'POST', `/proposals/${p2.id}/approve`, { reason: '用旧差异签名批准', diff_hash: p2.diff_hash });
  ok('禁止用旧签名批准新内容', staleApprove.status === 409 && staleApprove.error?.code === 'PROPOSAL_STALE',
    `HTTP ${staleApprove.status} ${staleApprove.error?.code ?? ''}`);
  await req(L, 'POST', `/proposals/${p2.id}/regenerate-diff`, {});
  const p2b = (await req(L, 'GET', `/proposals/${p2.id}`)).data;
  ok('重算差异后 revision 递增、旧确认清零', Number(p2b?.revision) > Number(p2.revision) && Number(p2b?.approval_count) === 0,
    `revision ${p2.revision}→${p2b?.revision} · 确认 ${p2b?.approval_count}/${p2b?.needed_count}`);
  const good = await req(A, 'POST', `/proposals/${p2.id}/approve`, { reason: '按新差异批准', diff_hash: p2b?.diff_hash });
  const committed = await waitStatus(L, p2.id, ['committed'], 60000);
  const vcount = ((await req(L, 'GET', `/files/${f2.file.id}/versions`)).data ?? []).length;
  ok('按新差异重新确认后才真正写入，且只写一个新版本',
    committed?.status === 'committed' && vcount === 3, `status=${committed?.status} · 版本数 ${vcount} · approve HTTP ${good.status}`);

  console.log(`\n结果：失败 ${fails} 项`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('脚本异常：', e); process.exit(1); });
