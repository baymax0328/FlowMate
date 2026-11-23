// FlowMate · 文档「空间」新建/删除回归
// 需求来源：文档页左侧是「空间」列，但「新建」建的却是文件/文件夹（名不副实），且没有删除空间入口。
// 关键不变量：新建一个同级 personal 根之后，「我的文件」这个结构根必须仍然指向原来那个目录
// （ensurePersonalRoot 若不排除 is_space=1，绑定与上传会悄悄漂到新空间）。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['SPACE_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080
const EMAIL = process.env.SPACE_USER || 'baymax@xingyu.test';

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? '  · ' + detail : ''}`);
};
let ck = '';
let org = '';
async function req(method, path, body, opts = {}) {
  const headers = { 'X-FlowMate-Client': 'web' };
  if (org) headers['X-Organization-Id'] = org;
  if (ck) headers.cookie = ck;
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
  const login = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  ck = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await req('GET', '/auth/me');
  org = (me.data?.organizations ?? [])[0]?.id ?? '';
  const stamp = Date.now();

  // ---- 基线：记下「我的文件」根 id，以及里面原有几个条目 ----
  const before = await req('GET', '/spaces');
  const roots = before.data ?? [];
  const mine = roots.find((s) => s.name === '我的文件');
  ok('W01', '空间列表返回派生根并带 deletable 标记', !!mine && mine.deletable === false,
    `我的文件 deletable=${mine?.deletable} · 共 ${roots.length} 项`);
  const baseKids = await req('GET', `/folders/${mine.id}/children`);
  ok('W02', '基线：我的文件可列目录', baseKids.status === 200,
    `folders=${(baseKids.data?.folders ?? []).length} files=${(baseKids.data?.files ?? []).length}`);

  // ---- 新建空间 ----
  const name = `探针空间${stamp}`;
  const created = await req('POST', '/spaces', { name });
  const sid = created.data?.id;
  ok('W03', 'POST /spaces 建出独立空间根', created.status < 300 && !!sid, `HTTP ${created.status} · ${String(sid).slice(0, 8)}`);

  const after = await req('GET', '/spaces');
  const listed = (after.data ?? []).find((s) => s.name === name);
  ok('W04', '新空间出现在空间列表且标为可删', !!listed && listed.deletable === true,
    `deletable=${listed?.deletable}`);

  // ---- 关键不变量：「我的文件」没被新根带跑 ----
  const mineAfter = (after.data ?? []).find((s) => s.name === '我的文件');
  ok('W05', '「我的文件」仍是同一个根（新建同级空间不会让它漂）',
    !!mineAfter && mineAfter.id === mine.id, `${String(mine.id).slice(0, 8)} → ${String(mineAfter?.id).slice(0, 8)}`);
  const kidsAfter = await req('GET', `/folders/${mine.id}/children`);
  ok('W06', '我的文件仍可正常列目录', kidsAfter.status === 200
    && (kidsAfter.data?.folders ?? []).length === (baseKids.data?.folders ?? []).length,
    `folders ${(baseKids.data?.folders ?? []).length} → ${(kidsAfter.data?.folders ?? []).length}`);

  // ---- 空间可用：在里面建文件夹、传文件、能被 Agent 绑定 ----
  const mk = await req('POST', '/folders', { parent_id: sid, name: '下级A' });
  ok('W07', '新空间里可以建子目录', mk.status < 300 && !!mk.data?.id, `HTTP ${mk.status}`);
  const file = await req('POST', '/files', { folder_id: sid, name: `探针文件${stamp}.md`, format: 'markdown', content: `# 探针\n\n空间功能验证。\n` });
  ok('W08', '新空间里可以直接建文件', file.status < 300 && !!(file.data?.file?.id ?? file.data?.id), `HTTP ${file.status}`);
  const s2 = await req('POST', '/agent/sessions', { title: `探针空间会话${stamp}`, folder_id: sid, include_children: true }, {});
  ok('W09', '新空间可以被会话绑定', s2.status < 300 && !!s2.data?.id, `HTTP ${s2.status}`);
  const tree = await req('GET', `/agent/sessions/${s2.data?.id}/files`, undefined, { query: { path: '/' } });
  ok('W10', '绑定后 Agent 侧能列出该空间内容', tree.status === 200 && Array.isArray(tree.data?.files),
    `folders ${(tree.data?.folders ?? []).length} files ${(tree.data?.files ?? []).length}`);

  // ---- 删除：派生根不可删 ----
  const delDerived = await req('DELETE', `/spaces/${mine.id}`);
  ok('W11', '删除派生根（我的文件）被拒', delDerived.status >= 400, `HTTP ${delDerived.status} ${delDerived.error?.code ?? ''} · ${String(delDerived.error?.message ?? '').slice(0, 34)}`);

  // ---- 删除：被会话绑定 → 423 且列出原因 ----
  const delBusy = await req('DELETE', `/spaces/${sid}`);
  ok('W12', '空间被会话绑定时删除被拒（423 并说明来源）',
    delBusy.status === 423 && /会话/.test(String(delBusy.error?.message ?? '')),
    `HTTP ${delBusy.status} ${delBusy.error?.code ?? ''}`);

  // ---- 解绑后可以删，且回收站能恢复 ----
  // 会话没有硬删除入口（PRD 里归档才是正解），所以这里按产品路径解绑再删
  await req('PUT', `/agent/sessions/${s2.data?.id}/binding`, { folder_id: null, include_children: false, acknowledge_context_visibility: true }, {});
  const del = await req('DELETE', `/spaces/${sid}`);
  ok('W13', '解绑后空间可删除（进回收站）', del.status < 300 && del.data?.restorable === true,
    `HTTP ${del.status} ${del.error?.message ?? ''} restorable=${del.data?.restorable}`);
  const gone = (await req('GET', '/spaces').then((r) => (r.data ?? []).some((s) => s.id === sid)));
  ok('W14', '删除后不再出现在空间列表', !gone);
  const trash = await req('GET', '/trash');
  const inTrash = JSON.stringify(trash.data ?? {}).includes(name);
  ok('W15', '被删空间进回收站（可恢复，不是物理删除）', inTrash, inTrash ? '在回收站列表里' : '未找到');
  if (inTrash) {
    const rid = (trash.data?.folders ?? trash.data?.items ?? trash.data ?? []).find?.((f) => f?.name === name)?.id;
    if (rid) {
      const back = await req('POST', `/folders/${rid}/restore`, {});
      ok('W16', '从回收站恢复空间', back.status < 300, `HTTP ${back.status}`);
      ok('W17', '恢复后重新出现在空间列表', (await req('GET', '/spaces')).data.some((s) => s.id === sid));
    }
  }

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
