// FlowMate · 消息页交互契约探针（本轮需求 1 与 3 的根因都在这）
//
// 为什么单独立一套：这轮 4 个「看起来没实现」的消息问题，根因全在**数据形状**上，
// 而不是没写功能 ——
//   ① 后端消息 DTO 把 mentions 回成 [{user_id,display_name}] 对象数组，
//      前端按字符串数组 `includes(meId)` 判「@我」→ 永远 false，高亮/提示条一起失效；
//   ② DTO 只回 parent 摘要、**没回 parent_id**，而前端渲染引用块的条件是 parent_id 存在
//      → 回复发得出去、引用块永远不显示；
//   ③ 未读与 @我 计数是服务端算好的，前端只是把「未读 N 条」挂在行下方，几乎看不见。
// 这三条都必须有断言钉住，否则下次改 DTO 又会静默退化。
//
// 用法：node tests/message-ux-probe.mjs        # 默认打 8090；见 tests/probe-base.mjs（禁止打 8080）
import { probeBase, seedPassword } from './probe-base.mjs';

const B = probeBase(['MSGUX_BASE']);
const PW = seedPassword();
const A_EMAIL = process.env.MSGUX_A || 'baymax@xingyu.test';   // 发消息的人
const B_EMAIL = process.env.MSGUX_B || 'hy123@xingyu.test';    // 被 @ / 收未读的人

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? '  · ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const S = (v, f = '') => (v === null || v === undefined || v === '' ? String(f) : String(v));

async function login(email) {
  const res = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email} → ${res.status}`);
  const ck = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await (await fetch(B + '/auth/me', { headers: { cookie: ck, 'X-FlowMate-Client': 'web' } })).json();
  const org = (me.data?.organizations ?? [])[0]?.id ?? '';
  return {
    email, ck, org, userId: S(me.data?.user?.id), name: S(me.data?.user?.display_name),
    async get(path, query) {
      let url = B + path;
      if (query) {
        const p = new URLSearchParams();
        for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
        const q = p.toString(); if (q) url += (url.includes('?') ? '&' : '?') + q;
      }
      const r = await fetch(url, { headers: { cookie: this.ck, 'X-Organization-Id': this.org, 'X-FlowMate-Client': 'web' } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, data: j.data, error: j.error };
    },
    async post(path, body, idem) {
      const r = await fetch(B + path, {
        method: 'POST',
        headers: { cookie: this.ck, 'X-Organization-Id': this.org, 'content-type': 'application/json', 'X-FlowMate-Client': 'web', ...(idem ? { 'Idempotency-Key': idem } : {}) },
        body: JSON.stringify(body ?? {}),
      });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, data: j.data, error: j.error };
    },
    async put(path, body) {
      const r = await fetch(B + path, { method: 'PUT', headers: { cookie: this.ck, 'X-Organization-Id': this.org, 'content-type': 'application/json', 'X-FlowMate-Client': 'web' }, body: JSON.stringify(body ?? {}) });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, data: j.data, error: j.error };
    },
    async del(path) {
      const r = await fetch(B + path, { method: 'DELETE', headers: { cookie: this.ck, 'X-Organization-Id': this.org, 'X-FlowMate-Client': 'web' } });
      const j = await r.json().catch(() => ({}));
      return { status: r.status, data: j.data, error: j.error };
    },
  };
}

const arr = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.items) ? v.items : []));

const main = async () => {
  const A = await login(A_EMAIL);
  const Bb = await login(B_EMAIL);
  const stamp = Date.now();

  // ---------- 00 建群聊：只传对方，服务端要自动把我自己算进成员 ----------
  const created = await A.post('/conversations', { type: 'project', member_ids: [Bb.userId], name: `消息契约群${stamp}` }, `msgux-c-${stamp}`);
  const cid = S(created.data?.id ?? created.data?.conversation_id);
  ok('N01', '建群只传对方 → 会话真的建成', created.status < 300 && !!cid, `HTTP ${created.status} · ${cid.slice(0, 8)}`);
  const convRow = async (cli) => arr((await cli.get('/conversations')).data).find((c) => S(c.id) === cid) ?? null;
  const aRow0 = await convRow(A);
  const memberIds = arr(aRow0?.members ?? aRow0?.member_rows).map((m) => S(m.user_id ?? m.id));
  ok('N02', '成员里自动包含发起人（所以选择列表不该再让人勾自己）', memberIds.includes(A.userId) && memberIds.includes(Bb.userId),
    `成员 ${memberIds.length} 人：${memberIds.map((x) => (x === A.userId ? '我' : '对方')).join('+')}`);

  // ---------- 01 未读数与 @我 计数（服务端算，前端负责显眼呈现） ----------
  const bRow0 = await convRow(Bb);
  ok('N03', 'B 视角：新会话还没消息时未读为 0（不是缺字段）', bRow0 && typeof bRow0.unread_count === 'number' && Number(bRow0.unread_count) === 0,
    `unread_count=${bRow0?.unread_count} · last_read_at=${S(bRow0?.last_read_at, 'null')}`);

  const sent = await A.post(`/conversations/${cid}/messages`, { body: `探针普通消息${stamp}`, client_msg_id: `msgux-m1-${stamp}` }, `msgux-m1-${stamp}`);
  ok('N04', 'A 在群里发一条消息', sent.status < 300 && !!S(sent.data?.id), `HTTP ${sent.status}`);

  await A.post(`/conversations/${cid}/messages`, { body: `探针点名${stamp}`, mentions: [Bb.userId], client_msg_id: `msgux-m2-${stamp}` }, `msgux-m2-${stamp}`);
  const bRow1 = await convRow(Bb);
  ok('N05', 'B 未读计数真的算得出来（未读 2 条）', Number(bRow1?.unread_count ?? 0) >= 2, `unread_count=${bRow1?.unread_count}`);
  ok('N06', 'B 的「@我 未读」单独计数（提示条与徽标都靠它）', Number(bRow1?.at_me_unread_count ?? 0) >= 1,
    `at_me_unread_count=${bRow1?.at_me_unread_count} · label=${S(bRow1?.at_me_unread_label)}`);
  ok('N07', 'A 自己发的消息不会给自己算未读（发送人排除自己）', Number((await convRow(A))?.unread_count ?? -1) === 0,
    `A.unread_count=${(await convRow(A))?.unread_count}`);

  // ---------- 02 消息 DTO 形状：mentions 是对象数组（本轮「@我没提示」的根因） ----------
  const msgs = arr((await A.get(`/conversations/${cid}/messages`, { limit: 60 })).data?.items);
  const atMsg = msgs.find((m) => S(m.body).includes('探针点名'));
  ok('N08', '消息 DTO 的 mentions 是 [{user_id,display_name}]（前端不能按字符串数组比）',
    Array.isArray(atMsg?.mentions) && typeof atMsg?.mentions?.[0] === 'object' && !!atMsg?.mentions?.[0]?.user_id && !!atMsg?.mentions?.[0]?.display_name,
    JSON.stringify(atMsg?.mentions ?? null).slice(0, 90));
  ok('N09', '对象里带的 display_name 就是被 @ 的人（提示条直接说「谁@你」）',
    S(atMsg?.mentions?.[0]?.display_name) === Bb.name, `${S(atMsg?.mentions?.[0]?.display_name)} vs ${Bb.name}`);

  // ---------- 03 @ 同一个人两次：只留一份、只通知一次 ----------
  await A.post(`/conversations/${cid}/messages`, { body: `重复@${stamp}`, mentions: [Bb.userId, Bb.userId, Bb.userId], client_msg_id: `msgux-m3-${stamp}` }, `msgux-m3-${stamp}`);
  const dup = arr((await A.get(`/conversations/${cid}/messages`, { limit: 60 })).data?.items).find((m) => S(m.body).includes('重复@'));
  ok('N10', '同一人被重复 @ 时 mentions 去重成一条（不重复轰炸）', (dup?.mentions ?? []).length === 1, `实际 ${ (dup?.mentions ?? []).length } 条`);

  // ---------- 04 @ 自己：服务端不发通知（提醒自己没有意义） ----------
  const selfAt = await A.post(`/conversations/${cid}/messages`, { body: `@自己${stamp}`, mentions: [A.userId], client_msg_id: `msgux-m4-${stamp}` }, `msgux-m4-${stamp}`);
  const aNoti = arr((await A.get('/notifications')).data?.items ?? (await A.get('/notifications')).data);
  const selfNoti = aNoti.filter((n) => S(n.type) === 'mention' && S(n.created_at) > S(selfAt.data?.created_at ?? ''));
  ok('N11', 'A @ 自己不会收到 mention 通知', selfAt.status < 300 && selfNoti.length === 0, `通知 ${selfNoti.length} 条`);

  // ---------- 05 回复：DTO 必须同时回 parent_id 与 parent 摘要（引用块能不能显示就看它） ----------
  const reply = await A.post(`/conversations/${cid}/messages`, { body: `探针回复${stamp}`, parent_id: S(atMsg?.id), client_msg_id: `msgux-r1-${stamp}` }, `msgux-r1-${stamp}`);
  ok('N12', '带 parent_id 的回复被受理', reply.status < 300 && !!S(reply.data?.id), `HTTP ${reply.status}`);
  const after = arr((await A.get(`/conversations/${cid}/messages`, { limit: 60 })).data?.items);
  const row = after.find((m) => S(m.id) === S(reply.data?.id));
  ok('N13', '回复消息 DTO 回带 parent_id（前端渲染引用块的条件字段）', S(row?.parent_id) === S(atMsg?.id),
    `parent_id=${S(row?.parent_id, '缺字段')}`);
  ok('N14', '回复消息 DTO 的 parent 摘要含发送人与原文摘录', row?.parent?.parent_unavailable === false && !!S(row?.parent?.sender_name) && S(row?.parent?.excerpt).includes('探针点名'),
    `parent=${JSON.stringify(row?.parent ?? null).slice(0, 120)}`);

  // ---------- 06 原消息撤回后：引用条只说不可用，不泄漏摘录 ----------
  const retracted = await A.del(`/messages/${S(atMsg?.id)}`);
  ok('N15', '原消息可撤回', retracted.status < 300, `HTTP ${retracted.status}`);
  const after2 = arr((await A.get(`/conversations/${cid}/messages`, { limit: 60 })).data?.items);
  const row2 = after2.find((m) => S(m.id) === S(reply.data?.id));
  ok('N16', '原消息撤回后引用条转为不可用且不给摘录', row2?.parent?.parent_unavailable === true && !S(row2?.parent?.excerpt),
    JSON.stringify(row2?.parent ?? null).slice(0, 110));

  // ---------- 07 B 打开会话即已读：未读归零、@我 也归零 ----------
  const read = await Bb.put(`/conversations/${cid}/read`);
  ok('N17', 'B 标已读被受理', read.status < 300 && read.data?.cleared === true, `HTTP ${read.status}`);
  const bRow2 = await convRow(Bb);
  ok('N18', 'B 的未读与 @我 计数都归零（计数与已读位点联动）', Number(bRow2?.unread_count ?? -1) === 0 && Number(bRow2?.at_me_unread_count ?? -1) === 0,
    `unread=${bRow2?.unread_count} · at_me=${bRow2?.at_me_unread_count} · last_read_at=${S(bRow2?.last_read_at, 'null')}`);
  ok('N19', '会话行回带 last_read_at（前端「有新的@」靠它区分）', S(bRow2?.last_read_at, '') !== '', `last_read_at=${S(bRow2?.last_read_at)}`);

  // ---------- 08 组织成员列表仍含自己（前端排除是有意为之，不是数据缺失） ----------
  const orgMembers = arr((await A.get('/organizations/members')).data);
  ok('N20', '组织成员列表包含我自己（新建会话弹窗负责把自己从候选里剔除并说明默认包含）',
    orgMembers.some((m) => S(m.user_id ?? m.id) === A.userId), `共 ${orgMembers.length} 人`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
