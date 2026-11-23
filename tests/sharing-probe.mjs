// FlowMate · 共享会话回归：实时共享 vs 快照共享，以及会话改名 / 删除(归档) / 恢复
// 关键差异点（这次需求的核心）：开启共享后发起者继续对话，对方要能同步看到；
// 而旧的「快照」语义是冻结在分享时刻。两条都要测，否则「实时」只是嘴上的。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['SHARE_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${detail ? '  · ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(email) {
  const res = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email} → ${res.status}`);
  const ck = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await call({ ck, org: '' }, 'GET', '/auth/me');
  const orgId = (me.data?.organizations ?? [])[0]?.id ?? '';
  return { ck, org: orgId, userId: me.data?.user?.id, name: me.data?.user?.display_name, email };
}
async function call(cli, method, path, body, opts = {}) {
  const ck = typeof cli === 'string' ? cli : cli.ck;
  const org = typeof cli === 'string' ? '' : cli.org;
  const headers = { 'X-FlowMate-Client': 'web' };
  if (org) headers['X-Organization-Id'] = org;
  if (ck) headers.cookie = ck;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let url = B + path;
  if (opts.query) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    const q = p.toString();
    if (q) url += (url.includes('?') ? '&' : '?') + q;
  }
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data, error: j.error };
}

const main = async () => {
  const lead = await signIn('baymax@xingyu.test');
  const peer = await signIn('hy123@xingyu.test');
  const t = Date.now();

  const s = await call(lead, 'POST', '/agent/sessions', { title: `共享探针${t}` }, { idem: `sh-new-${t}` });
  const sid = s.data?.id;
  ok('H01', '建一个个人会话（不选工作区）', !!sid, `HTTP ${s.status}`);

  // ---- 实时共享：开启后发起者继续说话，对方要能看到 ----
  await call(lead, 'POST', `/agent/sessions/${sid}/messages`, { body: `共享前的话 ${t}` });
  const on = await call(lead, 'POST', `/agent/sessions/${sid}/shares`,
    { grantee_user_id: peer.userId, range_type: 'all', range_payload: {}, days: 3, live: true }, { idem: `sh-on-${t}` });
  ok('H02', '开启共享（实时）成功', on.status < 300 && !!on.data?.id, `HTTP ${on.status} range=${on.data?.range_type}`);

  const mineList = await call(lead, 'GET', '/agent/sessions', undefined, { query: { mode: 'personal' } });
  const row = (mineList.data ?? []).find((r) => r.id === sid);
  ok('H03', '会话列表带出共享状态（头部按钮据此显示「共享中」）',
    row?.sharing === true && Number(row?.shared_count ?? 0) >= 1, `sharing=${row?.sharing} count=${row?.shared_count}`);

  const sharedWithMe = await call(peer, 'GET', '/agent/sessions/shared-with-me');
  const seen = (sharedWithMe.data ?? []).find((r) => r.id === sid);
  ok('H04', '对方「共享会话」列表里自动出现该会话', !!seen, `共 ${(sharedWithMe.data ?? []).length} 条`);

  const before = await call(peer, 'GET', `/agent/sessions/${sid}/messages`);
  ok('H05', '对方能看到共享前的历史', (before.data ?? []).some((m) => String(m.body).includes('共享前的话')),
    `${(before.data ?? []).length} 条`);

  await call(lead, 'POST', `/agent/sessions/${sid}/messages`, { body: `共享后的新消息 ${t}` });
  await sleep(400);
  const after = await call(peer, 'GET', `/agent/sessions/${sid}/messages`);
  ok('H06', '实时共享：共享后发起者新说的话，对方同步可见',
    (after.data ?? []).some((m) => String(m.body).includes('共享后的新消息')),
    `${(before.data ?? []).length} → ${(after.data ?? []).length} 条`);

  const guestPost = await call(peer, 'POST', `/agent/sessions/${sid}/messages`, { body: '受邀者试着发言' });
  ok('H07', '对方仍是只读：不能发言', [403, 404].includes(guestPost.status), `HTTP ${guestPost.status} ${guestPost.error?.code ?? ''}`);

  // ---- 快照模式必须仍然「冻结」，否则两种语义没区别 ----
  const s2 = await call(lead, 'POST', '/agent/sessions', { title: `快照探针${t}` }, { idem: `sn-new-${t}` });
  const sid2 = s2.data?.id;
  await call(lead, 'POST', `/agent/sessions/${sid2}/messages`, { body: `快照前的话 ${t}` });
  await call(lead, 'POST', `/agent/sessions/${sid2}/shares`,
    { grantee_user_id: peer.userId, range_type: 'all', range_payload: {}, days: 3, live: false }, { idem: `sn-on-${t}` });
  await call(lead, 'POST', `/agent/sessions/${sid2}/messages`, { body: `快照后的新消息 ${t}` });
  await sleep(400);
  const snap = await call(peer, 'GET', `/agent/sessions/${sid2}/messages`);
  ok('H08', '快照共享：关闭实时后，新消息不会漏出去（两种模式真的有区别）',
    (snap.data ?? []).some((m) => String(m.body).includes('快照前的话'))
    && !(snap.data ?? []).some((m) => String(m.body).includes('快照后的新消息')),
    `${(snap.data ?? []).length} 条`);

  // ---- 撤销即失效 ----
  const rev = await call(lead, 'POST', `/agent/sessions/${sid}/shares/${on.data.id}/revoke`, {});
  const gone = await call(peer, 'GET', `/agent/sessions/${sid}`);
  ok('H09', '关闭共享后对方立即不可访问', rev.status < 300 && [403, 404].includes(gone.status),
    `撤销 HTTP ${rev.status} → 访问 HTTP ${gone.status}`);
  const afterOff = await call(lead, 'GET', '/agent/sessions', undefined, { query: { mode: 'personal' } });
  const rowOff = (afterOff.data ?? []).find((r) => r.id === sid);
  ok('H10', '关闭后列表状态回到未共享（按钮不再显示「共享中」）', rowOff?.sharing === false, `sharing=${rowOff?.sharing}`);

  // ---- 改名 / 删除（归档）/ 恢复 ----
  const rn = await call(lead, 'PATCH', `/agent/sessions/${sid2}`, { title: `改名后的团队会话${t}` });
  ok('H11', '会话可改名', rn.status < 300 && String(rn.data?.title).startsWith('改名后的'), `HTTP ${rn.status}`);
  const guestRename = await call(peer, 'PATCH', `/agent/sessions/${sid2}`, { title: '外人改一下' });
  ok('H12', '非协调者不能改名', [403, 404].includes(guestRename.status), `HTTP ${guestRename.status}`);

  const del = await call(lead, 'DELETE', `/agent/sessions/${sid2}`);
  ok('H13', '删除会话 = 归档（返回可恢复标记）', del.status < 300 && del.data?.restorable === true, `HTTP ${del.status}`);
  const listAfterDel = await call(lead, 'GET', '/agent/sessions', undefined, { query: { mode: 'personal' } });
  ok('H14', '归档后从列表消失', !(listAfterDel.data ?? []).some((r) => r.id === sid2));
  const arch = await call(lead, 'GET', '/agent/sessions/archived', undefined, { query: { mode: 'personal' } });
  ok('H15', '「已删除的会话」里能列到它（有恢复入口）', (arch.data ?? []).some((r) => r.id === sid2), `${(arch.data ?? []).length} 条`);
  const msgsKept = await call(lead, 'GET', `/agent/sessions/${sid2}/messages`);
  ok('H16', '归档不丢历史：消息仍在（恢复后还能看到）', (msgsKept.data ?? []).length > 0, `${(msgsKept.data ?? []).length} 条`);
  const back = await call(lead, 'POST', `/agent/sessions/${sid2}/restore`, {});
  ok('H17', '可以恢复回列表', back.status < 300 && (await call(lead, 'GET', '/agent/sessions', undefined, { query: { mode: 'personal' } })).data.some((r) => r.id === sid2),
    `HTTP ${back.status} note=${String(back.data?.note ?? '').slice(0, 20)}`);

  // ---- 会话 ID 兜底：对方即使不在共享列表里，也能用 ID 取回（前提是有授权） ----
  const byIdNoAuth = await call(await signIn('cyx666@xingyu.test'), 'GET', '/agent/sessions/open-by-id', undefined, { query: { session_id: sid } });
  ok('H18', '没被共享的人拿会话 ID 也取不到内容（ID 不是凭证）', [403, 404].includes(byIdNoAuth.status),
    `HTTP ${byIdNoAuth.status} ${byIdNoAuth.error?.code ?? ''}`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
