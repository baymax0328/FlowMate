// FlowMate · 工作模式（Agent 真的能改文件）端到端回归
// 这是本轮的核心：在绑定了工作区的会话里说「把 探针目标.md 的第一行开头加上 123」，
// 要求：① 系统真的读到了那个文件；② 改动以「提案 + 共同确认」出现，确认前原文件一个字节不变；
// ③ 确认后产生新版本，第一行确实以 123 开头，其余内容逐字保留。
// 另外钉住对话模式的边界：不读工作区文件（Run 步骤里不应出现 fs.list / fs.read）。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['WORK_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080
const EMAIL = process.env.WORK_USER || 'baymax@xingyu.test';

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${detail ? '  · ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ck = '';
let org = '';
async function req(method, path, body, opts = {}) {
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
  const j = await fetch_json(res);
  return { status: res.status, data: j.data, error: j.error };
}
async function fetch_json(res) { try { return await res.json(); } catch { return {}; } }

async function until(path, pred, ms = 150000, query) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < ms) {
    last = await req('GET', path, undefined, { query });
    if (pred(last.data)) return { ...last, took: Date.now() - t0 };
    await sleep(2000);
  }
  return { ...last, timedOut: true, took: ms };
}

const main = async () => {
  const login = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  ck = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  org = ((await req('GET', '/auth/me')).data?.organizations ?? [])[0]?.id ?? '';
  const t = Date.now();
  const FILE = `探针目标${t}.md`;
  const BASE_TEXT = '# 产品口径说明\n\n首屏可交互时间不高于 2 秒。\n高频任务成功率不低于 90%。\n';

  // ---- 准备：一个可编辑的 md 文件 + 绑定它所在工作区的会话 ----
  const space = ((await req('GET', '/spaces')).data ?? []).find((s) => s.space === 'personal' && s.id);
  const created = await req('POST', '/files', { folder_id: space.id, name: FILE, format: 'markdown', content: BASE_TEXT });
  const fileId = created.data?.file?.id ?? created.data?.id;
  ok('K01', `准备好可编辑文件 ${FILE}`, !!fileId, `HTTP ${created.status}`);
  const sess = await req('POST', '/agent/sessions', { title: `工作模式探针${t}`, folder_id: space.id, include_children: true }, { idem: `wk-s-${t}` });
  const sid = sess.data?.id;
  ok('K02', '会话绑定该工作区', !!sid, `HTTP ${sess.status} 工作区=${sess.data?.binding?.root_name}`);

  const verBefore = (await req('GET', `/files/${fileId}/versions`)).data ?? [];
  const contentBefore = (await req('GET', `/files/${fileId}/preview`)).data;

  // ---- 工作模式：点名改文件 ----
  const goal = `把 ${FILE} 的第一行开头加上 123，其余内容保持不变。`;
  const rq = await req('POST', `/agent/sessions/${sid}/requests`,
    { goal, output_kind: 'draft', idempotency_key: `wk-req-${t}` }, { idem: `wk-req-${t}` });
  ok('K03', '工作模式请求被受理', rq.status < 300 && !!rq.data?.request?.id,
    `HTTP ${rq.status} 子任务=${(rq.data?.request?.plan ?? []).map((s) => s.exec).join('→')}${rq.data?.clarification ? ' · 反问：' + rq.data.clarification.slice(0, 40) : ''}`);

  const props = await until('/proposals', (d) => (d ?? []).length > 0, 180000, { session_id: sid });
  const prop = (props.data ?? [])[0];
  ok('K04', '改动以「提案」出现（不是直接写文件）', !!prop, `等待 ${Math.round(props.took / 1000)}s · ${(props.data ?? []).length} 个提案`);
  if (!prop) { console.log(`\nFAIL ${failures + 1} 项 · 提案未产生，后续断言跳过`); process.exit(1); }

  // 确认前：原文件的版本链必须一动不动。
  // 注意不能比 /preview 的响应体 —— 正文抽取是异步的，字节没变时载荷也会从 pending 变 ready，
  // 拿它当"内容没变"的证据会得出假结论（第一版探针就栽在这）。版本 ID 与版本数才是硬证据。
  const vMid = (await req('GET', `/files/${fileId}/versions`)).data ?? [];
  ok('K05', '确认前原文件版本链未变动（没有静默写入）',
    vMid.length === verBefore.length && vMid[0]?.id === verBefore[0]?.id,
    `提案状态=${prop.status} 需 ${prop.needed_count} 人确认 · 版本 ${verBefore.length} → ${vMid.length}`);
  const diff = await req('GET', `/proposals/${prop.id}/diff`);
  const diffText = typeof diff.data === 'string' ? diff.data : String(diff.data?.patch ?? '');
  ok('K06', '提案差异是「最小改动」而不是整篇替换', /\+123#|123# 产品口径说明/.test(diffText.replace(/\r/g, '')) && /@@/.test(diffText),
    diffText.split('\n').slice(0, 6).join(' ⏎ ').slice(0, 150));

  // ---- 确认 → 提交 ----
  const required = Array.isArray(prop.required_approvers) ? prop.required_approvers : JSON.parse(String(prop.required_approvers ?? '[]'));
  const meId = (await req('GET', '/auth/me')).data?.user?.id;
  const approver = required.includes(meId) ? meId : required[0] ?? meId;
  const ap = await req('POST', `/proposals/${prop.id}/approve`, { reason: '工作模式探针同意', diff_hash: prop.diff_hash });
  ok('K07', '相关指令人确认提案', [200, 201].includes(ap.status), `HTTP ${ap.status} ${ap.error?.code ?? ''} 确认人=${String(approver).slice(0, 8)}（需 ${required.length} 人）`);
  const after = await until(`/files/${fileId}/versions`, (d) => (d ?? []).length >= verBefore.length + 1, 30000);
  ok('K08', '确认后产生新版本', !after.timedOut, `版本数 ${verBefore.length} → ${(after.data ?? []).length}`);
  const newContent = (await req('GET', `/files/${fileId}/preview`)).data;
  const newText = typeof newContent === 'string' ? newContent : String(newContent?.text ?? JSON.stringify(newContent ?? ''));
  const firstLine = newText.split('\n')[0] ?? '';
  ok('K09', '新版本第一行确实以 123 开头', firstLine.startsWith('123'), `第一行=「${firstLine.slice(0, 40)}」`);
  ok('K10', '其余内容逐字保留（没被草稿整篇替换）',
    newText.includes('首屏可交互时间不高于 2 秒') && newText.includes('高频任务成功率不低于 90%'),
    `新内容 ${newText.length} 字`);

  // ---- 对话模式边界：不读工作区文件 ----
  const s2 = await req('POST', '/agent/sessions', { title: `对话模式探针${t}`, folder_id: space.id, include_children: true }, { idem: `dlg-s-${t}` });
  const rq2 = await req('POST', `/agent/sessions/${s2.data?.id}/requests`,
    { goal: `工作区里 ${FILE} 的正文写了什么？`, output_kind: 'answer', idempotency_key: `dlg-req-${t}` }, { idem: `dlg-req-${t}` });
  const runId = (rq2.data?.runs ?? [])[0]?.id;
  ok('K11', '对话模式请求受理且只排一个 answer 子任务',
    !!runId && (rq2.data?.request?.plan ?? []).every((s) => s.exec === 'answer'),
    `子任务=${(rq2.data?.request?.plan ?? []).map((s) => s.exec).join('→')}`);
  const done = await until('/agent/sessions/' + s2.data.id + '/runs', (d) => (d ?? []).some((r) => ['succeeded', 'failed'].includes(r.status)), 120000);
  const run = (done.data ?? []).find((r) => r.id === runId) ?? (done.data ?? [])[0];
  const detail = await req('GET', `/runs/${runId}`);
  const tools = (detail.data?.steps ?? []).map((s) => s.tool_name);
  ok('K12', '对话模式没有读工作区文件（无 fs.list / fs.read 步骤）',
    !tools.includes('fs.list') && !tools.includes('fs.read') && !tools.includes('search.content'),
    `步骤=${tools.join('→') || '(无)'} · 运行状态=${run?.status}`);
  const msgs = await req('GET', `/agent/sessions/${s2.data.id}/messages`);
  const ans = (msgs.data ?? []).filter((m) => m.role === 'agent').slice(-1)[0];
  ok('K13', '对话模式仍给出了回答', !!ans && String(ans.body ?? '').length > 4,
    String(ans?.body ?? '').slice(0, 60).replace(/\n/g, ' '));

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
