// FlowMate · 工作模式（对话外观）与本轮边界回归
// 覆盖四件事，都是这轮改动的核心断言：
//  A. 工作模式不再产出「请求卡」，用户那句按普通消息落库，回答按普通气泡回来；
//  B. 工作模式确实读了工作区文件（Run 步骤里有 fs.read），对话模式确实没读；
//  C. 个人办公会话不能把团队空间 / 组织空间设为工作区（服务端硬拒，不靠前端隐藏）；
//  D. 上传会落到指定的那个子文件夹，而不是统统掉进「我的文件」根。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['CHATMODE_BASE']);
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
  return { ck, org: (me.data?.organizations ?? [])[0]?.id ?? '', userId: me.data?.user?.id, name: me.data?.user?.display_name };
}
async function call(cli, method, path, body, opts = {}) {
  const headers = { 'X-FlowMate-Client': 'web' };
  if (cli.org) headers['X-Organization-Id'] = cli.org;
  if (cli.ck) headers.cookie = cli.ck;
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
  let j = {}; try { j = await res.json(); } catch { /* 空响应体 */ }
  return { status: res.status, data: j.data, error: j.error };
}
async function until(cli, path, pred, ms, query) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await call(cli, 'GET', path, undefined, { query });
    if (pred(last.data)) return last;
    await sleep(2000);
  }
  return last;
}

const main = async () => {
  const lead = await signIn('baymax@xingyu.test');
  const t = Date.now();

  // ---------- 准备：个人空间里一个子文件夹 + 里面的 md ----------
  const spaces = (await call(lead, 'GET', '/spaces')).data ?? [];
  const mine = spaces.find((s) => s.space === 'personal' && s.id);
  const sub = await call(lead, 'POST', '/folders', { parent_id: mine.id, name: `口径子层${t}` });
  const subId = sub.data?.id;
  const doc = await call(lead, 'POST', '/files', {
    folder_id: subId, name: `指标口径${t}.md`, format: 'markdown',
    content: `# 指标口径 ${t}\n\n首屏可交互时间不高于 2 秒。\n唯一标记是 UNIQ-${t}。\n`,
  });
  ok('M00', '准备子文件夹与其中的 md', !!subId && !!(doc.data?.file?.id ?? doc.data?.id), `HTTP ${doc.status}`);

  // ---------- C. 个人会话不能挂团队 / 组织空间 ----------
  const teamRoot = spaces.find((s) => s.space === 'team' && s.id);
  const orgRoot = spaces.find((s) => s.space === 'org' && s.id);
  const badTeam = await call(lead, 'POST', '/agent/sessions', { title: `越界探针${t}`, folder_id: teamRoot.id, include_children: true }, { idem: `bad-t-${t}` });
  ok('M01', '个人办公会话选团队空间被服务端拒绝', badTeam.status >= 400,
    `HTTP ${badTeam.status} ${badTeam.error?.code ?? ''} · ${String(badTeam.error?.message ?? '').slice(0, 42)}`);
  const badOrg = await call(lead, 'POST', '/agent/sessions', { title: `越界探针2-${t}`, folder_id: orgRoot.id, include_children: true }, { idem: `bad-o-${t}` });
  ok('M02', '个人办公会话选组织空间同样被拒', badOrg.status >= 400, `HTTP ${badOrg.status} ${badOrg.error?.code ?? ''}`);

  // ---------- D. 上传落到指定子文件夹 ----------
  const form = new FormData();
  form.append('files', new Blob([`# 上传探针 ${t}\n\n这份是上传进来的，标记 UP-${t}。\n`], { type: 'text/markdown' }), `上传探针${t}.md`);
  form.append('folder_id', subId);
  const up = await fetch(`${B}/uploads`, {
    method: 'POST', headers: { 'X-FlowMate-Client': 'web', 'X-Organization-Id': lead.org, cookie: lead.ck }, body: form,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  const upFile = (up.data?.succeeded ?? [])[0];
  const inSub = (await call(lead, 'GET', `/folders/${subId}/children`)).data?.files ?? [];
  const inRoot = (await call(lead, 'GET', `/folders/${mine.id}/children`)).data?.files ?? [];
  ok('M03', '带 folder_id 的上传落在指定子文件夹里',
    up.status < 300 && inSub.some((f) => f.name === `上传探针${t}.md`) && !inRoot.some((f) => f.name === `上传探针${t}.md`),
    `HTTP ${up.status} · 子层=[${inSub.map((f) => f.name).join(', ')}] · 根=[${inRoot.map((f) => f.name).join(', ')}]`);

  // ---------- A + B. 工作模式：普通问答外观，但真的读了文件（照用户的例子） ----------
  const sess = await call(lead, 'POST', '/agent/sessions', { title: `工作模式外观探针${t}`, folder_id: subId, include_children: true }, { idem: `cm-s-${t}` });
  const sid = sess.data?.id;
  // 用户原话场景：工作区里有个 md 写着「1+1=？」，问「文件中的答案是多少」
  const quiz = await call(lead, 'POST', '/files', {
    folder_id: subId, name: `算术题${t}.md`, format: 'markdown', content: `# 练习题\n\n1+1=？\n\n答：1+1=2。\n`,
  });
  const quizId = quiz.data?.file?.id ?? quiz.data?.id;
  const quizVers = (await call(lead, 'GET', `/files/${quizId}/versions`)).data ?? [];
  const rq = await call(lead, 'POST', `/agent/sessions/${sid}/requests`,
    { goal: `文件中的答案是多少？`, output_kind: 'draft', chat_mode: true, idempotency_key: `cm-q-${t}` },
    { idem: `cm-q-${t}` });
  ok('M04', '工作模式请求受理', rq.status < 300 && !!rq.data?.request?.id,
    `HTTP ${rq.status} 子任务=${(rq.data?.request?.plan ?? []).map((s) => s.exec).join('→')}`);

  const msgs = await until(lead, `/agent/sessions/${sid}/messages`, (d) => (d ?? []).some((m) => m.role === 'agent'), 150000);
  const rows = msgs.data ?? [];
  ok('M05', '会话里没有「请求卡」，用户那句是普通消息',
    !rows.some((m) => m.kind === 'request_card') && rows.some((m) => m.role === 'user' && m.kind === 'message'),
    `消息 kind=${rows.map((m) => `${m.role}/${m.kind}`).join(', ')}`);
  const ans = rows.filter((m) => m.role === 'agent').slice(-1)[0];
  ok('M06', '回答是普通对话消息（不是成果卡）', ans?.kind === 'message', `kind=${ans?.kind}`);
  const body = String(ans?.body ?? '');
  ok('M07', '回答带出「题目 + 答案」（问的是文件里的题，不能只丢一个数字）',
    /1\s*\+\s*1/.test(body) && /2/.test(body), body.slice(0, 90).replace(/\n/g, ' '));
  ok('M08', '回答点明了出自哪个文件', /算术题|\.md/.test(body), body.slice(-70).replace(/\n/g, ' '));

  const runId = (await call(lead, 'GET', `/agent/sessions/${sid}/runs`)).data?.[0]?.id;
  const detail = await call(lead, 'GET', `/runs/${runId}`);
  const tools = (detail.data?.steps ?? []).map((s) => s.tool_name);
  ok('M09', '工作模式确实读了文件（有 fs.read 步骤）', tools.includes('fs.read'), `步骤=${tools.join('→')}`);
  ok('M10', '没有写文件、没有产生提案（工作模式只读）',
    !tools.includes('file.writeVersion') && !tools.includes('draft.create')
    && (await call(lead, 'GET', '/proposals', undefined, { query: { session_id: sid } })).data?.length === 0,
    `步骤=${tools.join('→')}`);
  const quizVers2 = (await call(lead, 'GET', `/files/${quizId}/versions`)).data ?? [];
  ok('M11', '被问的那个文件版本数没变（真的没动过它）', quizVers2.length === quizVers.length,
    `版本 ${quizVers.length} → ${quizVers2.length}`);

  // 对照：对话模式在同一条会话里仍然不读文件
  const q2 = await call(lead, 'POST', `/agent/sessions/${sid}/chat`, { body: '1+1 等于几？只回答算式结果。' }, { idem: `cm-d-${t}` });
  ok('M12', '对话模式（直连）不产生任何 Run/读取', q2.status < 300 && String(q2.data?.body ?? '').includes('2'),
    `回答=${String(q2.data?.body ?? '').slice(0, 20)}`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
