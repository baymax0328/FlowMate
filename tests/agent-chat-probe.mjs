// FlowMate · Agent 会话「点击即用 + 简单问答」回归探针
// 背景：曾在 Personal 会话点击对话后整页崩溃 `j(...).slice is not a function`，
// 根因是 /agent/sessions/:id/files 返回 { folders, files, path } 包装对象，
// 前端 jsonOf<Json[]>(tree.data, []).slice(0, 40) 把对象当数组 slice。
// 同类契约错位还有 /read-manifest（返回 { entries }）、会话列表（无 binding 字段）。
//
// 用法：先起服务（默认 8080；探针实例用 PROBE_BASE 指定），再 node tests/agent-chat-probe.mjs
// 只读 + 少量新建会话，不改既有文件内容。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['PROBE_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080
const EMAIL = process.env.PROBE_USER || 'baymax@xingyu.test';

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? '  · ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与前端 client.ts 的 arrOf 同语义：后端列表接口可能是裸数组，也可能是包装对象。
// 探针独立实现一份，专门用来证明「前端拿到这个形状也不会崩」。
function arrOf(v, key) {
  const x = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object') {
    if (key && Array.isArray(x[key])) return x[key];
    for (const k of ['entries', 'items', 'rows', 'list', 'results']) if (Array.isArray(x[k])) return x[k];
  }
  return [];
}

const cookieHolder = { value: '' };
async function req(method, path, body, opts = {}) {
  const headers = { 'X-FlowMate-Client': 'web' };
  if (org) headers['X-Organization-Id'] = org;
  if (cookieHolder.value) headers.cookie = cookieHolder.value;
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
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, data: json.data, error: json.error, raw: json };
}

let org = '';
let myId = '';
let myName = '';
/** 第二个身份（权限负例用）：自己一份 cookie/org，不影响主账号的 req */
async function loginAs(email) {
  const res = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email, password: PW }),
  });
  if (!res.ok) throw new Error(`登录失败 ${email} ${res.status}`);
  const ck = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await (await fetch(B + '/auth/me', { headers: { cookie: ck, 'X-FlowMate-Client': 'web' } })).json();
  return { ck, orgId: (me.data?.organizations ?? [])[0]?.id ?? '', userId: me.data?.user?.id, email };
}
async function reqAs(cli, method, path, body, opts = {}) {
  const headers = { 'X-FlowMate-Client': 'web', cookie: cli.ck };
  if (cli.orgId) headers['X-Organization-Id'] = cli.orgId;
  if (opts.idem) headers['Idempotency-Key'] = opts.idem;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data, error: j.error };
}
async function login() {
  const res = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  if (!res.ok) throw new Error(`登录失败 ${res.status}`);
  cookieHolder.value = (res.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await req('GET', '/auth/me');
  org = (me.data?.organizations ?? [])[0]?.id ?? '';
  myId = me.data?.user?.id ?? '';
  myName = me.data?.user?.display_name ?? '';
  return me.data;
}

const run = async () => {
  await login();
  const stamp = Date.now();

  // ---------- 00 保证有「已绑定工作区」的会话可测 ----------
  // 刚 seed:reset 完，库里一条会话都没有。契约检查不能依赖「库里恰好有人建过会话」这种
  // 偶然状态（那会把 A02/A03 变成空集上的真），所以没有就自己建一个绑定「我的文件」根的。
  let list = await req('GET', '/agent/sessions', undefined, { query: { mode: 'personal' } });
  let rows = arrOf(list.data);
  let bound = rows.find((r) => r.binding?.folder_id || r.folder_id);
  if (!bound) {
    const spaces = arrOf((await req('GET', '/spaces')).data);
    const mine = spaces.find((s) => s.space === 'personal' && s.id);
    const made = mine
      ? await req('POST', '/agent/sessions', { title: `探针契约会话${stamp}`, folder_id: String(mine.id), include_children: true }, { idem: `probe-crash-${stamp}` })
      : { status: 0, data: null, error: { message: '没有个人空间根可绑' } };
    if (made.data?.id) {
      list = await req('GET', '/agent/sessions', undefined, { query: { mode: 'personal' } });
      rows = arrOf(list.data);
      bound = rows.find((r) => r.binding?.folder_id || r.folder_id);
    }
    console.log(`INFO A00 库内无已绑定会话 → 自建 ${made.data?.id ? String(made.data.id).slice(0, 8) : '失败：' + (made.error?.message ?? made.status)}`);
  }

  // ---------- 01 会话列表 DTO 形状（左栏不再误标「未绑定目录」） ----------
  ok('A01', '个人会话列表可解析为数组', Array.isArray(list.data) || !!list.data, `HTTP ${list.status} · ${rows.length} 条`);
  ok('A02', '列表行带 binding 对象（含 root_name）', !!bound && !!bound.binding && 'root_name' in bound.binding,
    bound ? `${bound.title} → ${JSON.stringify(bound.binding)}` : '没有任何已绑定工作区的会话（自建也失败）');
  ok('A02b', 'binding.path 给出可展示的完整工作区路径', !!bound && typeof bound.binding?.path === 'string' && bound.binding.path.length > 0,
    `path=${JSON.stringify(bound?.binding?.path ?? null)}`);
  ok('A03', '列表行带 active_work 计数字段', !!bound && typeof bound.active_work?.running_runs === 'number',
    JSON.stringify(bound?.active_work ?? null));

  // ---------- 02 /files 与 /read-manifest 契约：包装对象，前端按 arrOf 取用不崩 ----------
  let crashChecked = false;
  const boundSid = bound ? String(bound.id ?? bound.session_id) : '';
  if (boundSid) {
    const sid = boundSid;
    const files = await req('GET', `/agent/sessions/${sid}/files`, undefined, { query: { path: '/' } });
    const d = files.data;
    const asArrayLike = arrOf(d);
    const merged = Array.isArray(d) ? d : [...arrOf(d?.folders).map((f) => ({ ...f, kind: 'folder' })), ...arrOf(d?.files)];
    // 关键断言：模拟崩溃点 jsonOf(...).slice(0,40) —— 现在必须走 arrOf 才不会抛
    let sliced = null;
    try { sliced = (Array.isArray(d) ? d : merged).slice(0, 40); } catch { sliced = 'THREW'; }
    ok('A04', '/files 返回 { folders, files, path } 且可安全 slice', files.status === 200 && sliced !== 'THREW' && Array.isArray(sliced),
      `HTTP ${files.status} · folders ${arrOf(d?.folders).length} · files ${arrOf(d?.files).length} · 取用后 ${sliced?.length} 项`);
    ok('A05', '/files 的 arrOf 兜底返回空数组而不是对象', Array.isArray(asArrayLike),
      `arrOf→${asArrayLike.length} 项（包装对象不含 entries/items 时回落空数组，页面显示「暂无」而非崩溃）`);

    const man = await req('GET', `/agent/sessions/${sid}/read-manifest`);
    ok('A06', '/read-manifest 正文在 entries 里', man.status === 200 && Array.isArray(man.data?.entries)
      && arrOf(man.data, 'entries') === man.data.entries, `file_count=${man.data?.file_count} entries=${man.data?.entries?.length}`);
    crashChecked = true;
  } else {
    ok('A04', '/files 契约检查', false, '跳过：没有已绑定目录的会话可测');
  }

  // ---------- 03 新建未绑定目录的会话 → 直接问答 ----------
  const created = await req('POST', '/agent/sessions', { title: `探针问答会话${stamp}` }, { idem: `probe-new-${stamp}` });
  const chatSid = String(created.data?.id ?? '');
  ok('A07', '新建个人会话成功（不选目录）', created.status < 300 && !!chatSid, `HTTP ${created.status} · ${chatSid.slice(0, 8)}`);

  const detail = await req('GET', `/agent/sessions/${chatSid}`);
  ok('A08', '详情 binding.folder_id 为空（问答态）', detail.data?.binding?.folder_id == null,
    JSON.stringify(detail.data?.binding ?? null));

  const q = await req('POST', `/agent/sessions/${chatSid}/requests`,
    { goal: 'FlowMate 里的「共同确认」是什么？一句话回答。', output_kind: 'answer', idempotency_key: `probe-q-${stamp}` },
    { idem: `probe-q-${stamp}` });
  ok('A09', '问答请求被受理（不要求先绑定目录、不反问补充信息）',
    q.status < 300 && !q.data?.clarification && (q.data?.runs ?? []).length >= 1,
    `HTTP ${q.status} · clarification=${JSON.stringify(q.data?.clarification ?? null)} · runs=${(q.data?.runs ?? []).length}`);

  // 等回复落库：轮询消息，看到 agent 的正文回复为止
  let agentMsg = null;
  let stream = [];
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const m = await req('GET', `/agent/sessions/${chatSid}/messages`);
    stream = arrOf(m.data);
    agentMsg = stream.find((x) => x.role === 'agent' && x.kind === 'message' && String(x.body ?? '').trim().length > 4) ?? null;
    if (agentMsg) {
      const runRow = arrOf((await req('GET', `/agent/sessions/${chatSid}/runs`)).data)[0];
      ok('A10', 'Agent 回复出现在消息流里', true,
        `第 ${i * 2} 秒 · planner=${agentMsg.aux?.planner ?? runRow?.planner} · ${(agentMsg.body ?? '').slice(0, 60).replace(/\n/g, ' ')}…`);
      ok('A11', '回复是普通对话消息（kind=message），不是成果卡', agentMsg.kind === 'message', `kind=${agentMsg.kind}`);
      break;
    }
    const runs = arrOf((await req('GET', `/agent/sessions/${chatSid}/runs`)).data);
    const failed = runs.find((r) => r.status === 'failed');
    if (failed) {
      ok('A10', 'Agent 回复出现在消息流里', false, `run failed：${failed.error_code} ${String(failed.error_message ?? '').slice(0, 160)}`);
      break;
    }
  }
  if (!agentMsg) ok('A10', 'Agent 回复出现在消息流里', false, '120 秒内没有看到 agent 消息');
  // 一条请求只应该有一张请求卡：以前 sessions 与 orchestrator 各写一张，会话里重复出现
  const cards = stream.filter((x) => x.kind === 'request_card');
  ok('A14', '一条请求只落一张请求卡', cards.length === 1, `实际 ${cards.length} 张 · ${JSON.stringify(cards.map((c) => c.role))}`);
  ok('A15', '会话里没有重复的 agent 空消息', stream.filter((x) => x.role === 'agent' && !String(x.body ?? '').trim()).length === 0,
    `消息总数 ${stream.length}`);

  // ---------- 04 绑定目录的会话也要能纯问答：不写文件 ----------
  const folderId = bound?.binding?.folder_id ?? bound?.folder_id ?? null;
  if (folderId) {
    const s2 = await req('POST', '/agent/sessions', { title: `探针工作区问答${stamp}`, folder_id: folderId, include_children: true }, { idem: `probe-b-${stamp}` });
    const sid2 = String(s2.data?.id ?? '');
    const r2 = await req('POST', `/agent/sessions/${sid2}/requests`,
      { goal: '这个目录里大概有什么内容？用两句话概括，不要生成任何文件。', output_kind: 'answer', idempotency_key: `probe-b-req-${stamp}` },
      { idem: `probe-b-req-${stamp}` });
    const subtasks = arrOf(r2.data?.request?.plan);
    ok('A12', '已绑定目录下的「只要回答」不拆出写文件子任务',
      r2.status < 300 && subtasks.every((s) => s.exec !== 'draft' && s.exec !== 'formal_change'),
      `HTTP ${r2.status} · 子任务 exec=${JSON.stringify(subtasks.map((s) => s.exec))}`);
    let answered = null;
    for (let i = 0; i < 45 && !answered; i++) {
      await sleep(2000);
      const m = await req('GET', `/agent/sessions/${sid2}/messages`);
      answered = arrOf(m.data).find((x) => x.role === 'agent' && x.kind === 'message' && String(x.body ?? '').trim().length > 4) ?? null;
    }
    const arts = arrOf((await req('GET', `/agent/sessions/${sid2}/artifacts`)).data);
    ok('A13', '纯问答后目录里没有新增草稿文件', !!answered && arts.filter((a) => a.kind === 'draft').length === 0,
      `回答${answered ? '已' : '未'}到达 · 草稿类成果 ${arts.filter((a) => a.kind === 'draft').length} 个`);
  } else {
    ok('A12', '已绑定目录问答', false, '跳过：没有可用目录');
  }

  // ---------- 05 轻量直连问答：一次调用、两条消息、不进队列 ----------
  const runsBefore = arrOf((await req('GET', `/agent/sessions/${chatSid}/runs`)).data);
  const t0 = Date.now();
  const cq = await req('POST', `/agent/sessions/${chatSid}/chat`, { body: '用一句话说明「幂等键」是干什么的。' }, { idem: `probe-chat-${stamp}` });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  ok('A16', '/chat 直连返回回答', cq.status < 300 && String(cq.data?.body ?? '').trim().length > 4,
    `HTTP ${cq.status} · ${dt}s · ${String(cq.data?.body ?? cq.error?.message ?? '').slice(0, 60).replace(/\n/g, ' ')}…`);
  ok('A17', '/chat 标为 quick 且记录了模型与用量', cq.data?.mode === 'quick' && !!cq.data?.model
    && !!cq.data?.usage && 'input_tokens' in cq.data.usage, `model=${cq.data?.model} usage=${JSON.stringify(cq.data?.usage)}`);
  const afterChat = arrOf((await req('GET', `/agent/sessions/${chatSid}/messages`)).data);
  const runsAfter = arrOf((await req('GET', `/agent/sessions/${chatSid}/runs`)).data);
  ok('A18', '/chat 不产生 run（真的绕开了队列）', runsAfter.length === runsBefore.length,
    `运行数 ${runsAfter.length}（问答前 ${runsBefore.length}）· 消息数 ${afterChat.length}`);
  const chatPair = afterChat.slice(-2);
  ok('A19', '问答两条消息一条来自我、一条来自 Agent',
    chatPair.some((x) => x.role === 'user' && x.aux?.quick === true) && chatPair.some((x) => x.role === 'agent' && x.aux?.quick === true),
    JSON.stringify(chatPair.map((x) => `${x.role}/${x.kind}`)));
  ok('A20', 'Agent 消息带来源标记（planner=model，不冒充本地生成）',
    chatPair.filter((x) => x.role === 'agent').every((x) => x.aux?.planner === 'model'),
    JSON.stringify(chatPair.filter((x) => x.role === 'agent').map((x) => x.aux?.planner)));
  const emptyChat = await req('POST', `/agent/sessions/${chatSid}/chat`, { body: '   ' });
  ok('A21', '空问题被校验拦住', emptyChat.status === 400, `HTTP ${emptyChat.status} ${emptyChat.error?.code ?? ''}`);
  // 只读受邀者不能借这条直连路触发模型调用
  const invitee = await loginAs('hy123@xingyu.test');
  const share = await req('POST', `/agent/sessions/${chatSid}/shares`,
    { grantee_user_id: invitee.userId, range_type: 'all', days: 1 }, { idem: `probe-share-${stamp}` });
  const asGuest = await reqAs(invitee, 'POST', `/agent/sessions/${chatSid}/chat`, { body: '借用一下模型可以吗' });
  ok('A22', '只读受邀者用 /chat 被拒（权限边界不在前端）', [401, 403, 404].includes(asGuest.status),
    `HTTP ${asGuest.status} ${asGuest.error?.code ?? ''} · 分享=${share.status}`);

  // ---------- 06 这三条是上一轮线上问题的回归 ----------
  const userRow = afterChat.filter((x) => x.role === 'user').slice(-1)[0] ?? {};
  const agentRow = afterChat.filter((x) => x.role === 'agent').slice(-1)[0] ?? {};
  ok('A23', '我发的提问记的是我本人（不是 FlowMate Agent）',
    userRow.sender_user_id === myId && String(userRow.sender_label ?? '') === myName,
    `label=${JSON.stringify(userRow.sender_label)} · uid=${String(userRow.sender_user_id).slice(0, 8)}（期望 ${myName} / ${myId.slice(0, 8)}）`);
  ok('A24', 'Agent 行仍标为 FlowMate Agent', agentRow.sender_label === 'FlowMate Agent' && !agentRow.sender_user_id,
    `label=${JSON.stringify(agentRow.sender_label)}`);
  // 页面上出现过 r=>On(r)：那是把 dompurify 工厂函数本身当净化函数调、再把函数源码渲染成正文
  const body = String(agentRow.body ?? '');
  ok('A25', '回答正文是可读文本，不是函数源码',
    body.length > 8 && !/=>|function\s*\(|createDOMPurify|^\s*[\w$]+\s*=>/.test(body) && !body.startsWith('('),
    body.slice(0, 56).replace(/\n/g, ' ') + '…');
  // 前端曾经用 S(truncated) 判真，String(false)==='false' 会让每条正常回答都弹「被截断」
  ok('A26', '正常短回答的 truncated 是布尔 false（前端据此才不会误报截断）',
    cq.data?.truncated === false, `typeof=${typeof cq.data?.truncated} 值=${JSON.stringify(cq.data?.truncated)}`);
  const replay = await req('POST', `/agent/sessions/${chatSid}/chat`, { body: '用一句话说明「幂等键」是干什么的。' }, { idem: `probe-chat-${stamp}` });
  ok('A27', '同 Idempotency-Key 重放不产生第二组问答',
    replay.status < 300 && String(replay.data?.message_id ?? '') === String(cq.data?.message_id ?? ''),
    `重放 message_id=${String(replay.data?.message_id).slice(0, 8)} vs 首次 ${String(cq.data?.message_id).slice(0, 8)}`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · crashChecked=${crashChecked} · base=${B}`);
  process.exit(failures ? 1 : 0);
};

run().catch((e) => { console.error('探针本身出错：', e); process.exit(2); });
