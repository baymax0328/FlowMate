// FlowMate · 文档页「操作」列回归：转移 / 复制 / 删除（进回收站）/ 恢复
// 覆盖文件与文件夹两种对象，并钉住两条安全边界：
//  1) 删除一律先入回收站，不物理删；
//  2) 文件夹不能移进自己或自己的子目录（服务端必须拒绝，否则目录链会成环）。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['OPS_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080
const EMAIL = process.env.OPS_USER || 'baymax@xingyu.test';

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${name}${detail ? '  · ' + detail : ''}`);
};
let ck = '';
let org = '';
async function req(method, path, body) {
  const headers = { 'X-FlowMate-Client': 'web' };
  if (org) headers['X-Organization-Id'] = org;
  if (ck) headers.cookie = ck;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(B + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data, error: j.error };
}

const main = async () => {
  const login = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  ck = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  org = ((await req('GET', '/auth/me')).data?.organizations ?? [])[0]?.id ?? '';
  const t = Date.now();

  const space = await req('POST', '/spaces', { name: `操作探针空间${t}` });
  const sid = space.data?.id;
  const fa = (await req('POST', '/folders', { parent_id: sid, name: `A区${t}` })).data?.id;
  const fb = (await req('POST', '/folders', { parent_id: sid, name: `B区${t}` })).data?.id;
  const inner = (await req('POST', '/folders', { parent_id: fa, name: `A1子目录${t}` })).data?.id;
  const file = (await req('POST', '/files', { folder_id: sid, name: `探针文件${t}.md`, format: 'markdown', content: '# 探针\n\n行内操作验证。\n' })).data?.file?.id
    ?? (await req('POST', '/files', { folder_id: sid, name: `探针文件2-${t}.md`, format: 'markdown', content: '# 探针2\n' })).data?.file?.id;
  ok('O01', '准备：空间 / 两个目录 / 一个子目录 / 一个文件', !!sid && !!fa && !!fb && !!inner && !!file,
    `file=${String(file).slice(0, 8)}`);

  // ---- 文件转移 ----
  const mv = await req('POST', `/files/${file}/move`, { target_folder_id: fa, accept_scope_change: true });
  ok('O02', '文件可转移到指定目录', mv.status < 300, `HTTP ${mv.status} ${mv.error?.code ?? ''}`);
  const inA = await req('GET', `/folders/${fa}/children`);
  ok('O03', '转移后目标目录能列到该文件', (inA.data?.files ?? []).some((f) => f.id === file),
    `A区文件数 ${(inA.data?.files ?? []).length}`);

  // ---- 文件夹转移 ----
  const mvf = await req('POST', `/folders/${fa}/move`, { target_folder_id: fb, accept_scope_change: true });
  ok('O04', '文件夹可转移到另一个目录', mvf.status < 300, `HTTP ${mvf.status} ${mvf.error?.code ?? ''}`);
  const inB = await req('GET', `/folders/${fb}/children`);
  ok('O05', '转移后父目录下列出该子目录', (inB.data?.folders ?? []).some((f) => f.id === fa),
    `B区子目录 ${(inB.data?.folders ?? []).length} 个`);

  // ---- 成环防护 ----
  const cycle = await req('POST', `/folders/${fb}/move`, { target_folder_id: inner, accept_scope_change: true });
  ok('O06', '把父目录移进自己的子目录被拒（不成环）', cycle.status >= 400,
    `HTTP ${cycle.status} ${cycle.error?.code ?? ''} · ${String(cycle.error?.message ?? '').slice(0, 30)}`);
  const self = await req('POST', `/folders/${fb}/move`, { target_folder_id: fb, accept_scope_change: true });
  ok('O07', '移到自己内部被拒', self.status >= 400, `HTTP ${self.status}`);

  // ---- 删除：先回收站（文件先删，验证它从所在目录消失，再删目录） ----
  const tf = await req('POST', `/files/${file}/trash`, {});
  ok('O08', '删除文件进回收站', tf.status < 300 && tf.data?.ok !== false, `HTTP ${tf.status}`);
  const aAfterFileTrash = await req('GET', `/folders/${fa}/children`);
  ok('O09', '回收后文件不再出现在原目录列表里',
    aAfterFileTrash.status === 200 && !(aAfterFileTrash.data?.files ?? []).some((f) => f.id === file),
    `A区剩 ${(aAfterFileTrash.data?.files ?? []).length} 个文件`);
  const fd = await req('POST', `/folders/${fa}/trash`, {});
  ok('O10', '删除文件夹进回收站', fd.status < 300, `HTTP ${fd.status} ${fd.error?.message ?? ''}`);
  const tr = await req('GET', '/trash');
  const inTrashFile = (tr.data?.files ?? []).some((f) => f.id === file);
  const inTrashFolder = (tr.data?.folders ?? []).some((f) => f.id === fa);
  ok('O11', '被删的文件与文件夹都在回收站里（未物理删除）', inTrashFile && inTrashFolder,
    `回收站：${tr.data?.files?.length ?? 0} 文件 / ${tr.data?.folders?.length ?? 0} 目录 · 本次文件=${inTrashFile} 目录=${inTrashFolder}`);
  const goneRow = await req('GET', `/folders/${fb}/children`);
  ok('O12', '被回收的目录不再列在其父目录下', !(goneRow.data?.folders ?? []).some((f) => f.id === fa),
    `B区下剩 ${(goneRow.data?.folders ?? []).length} 个子目录`);

  // ---- 恢复：先恢复目录、再恢复文件，文件才会回到原目录 ----
  // （父目录还在回收站时恢复文件，服务端会把它落到「我的文件」并如实说明 —— 那是正确行为，
  //   上一版本探针把顺序搞反了，才会误判成"位置被改动"）
  const rfd = await req('POST', `/folders/${fa}/restore`, {});
  ok('O13', '文件夹可从回收站恢复', rfd.status < 300, `HTTP ${rfd.status}`);
  const rf = await req('POST', `/files/${file}/restore-from-trash`, {});
  ok('O14', '文件可从回收站恢复', rf.status < 300, `HTTP ${rf.status} ${String(rf.data?.note ?? '').slice(0, 20)}`);
  const backInA = await req('GET', `/folders/${fa}/children`);
  ok('O15', '先恢复目录再恢复文件时，文件回到原来的目录', (backInA.data?.files ?? []).some((f) => f.id === file),
    `A区 ${(backInA.data?.files ?? []).length} 个文件`);
  // 父目录仍被回收时恢复文件 → 落到「我的文件」并说明，不能把文件塞进已回收目录
  const fa2 = (await req('GET', `/folders/${fa}/children`)).data?.files ?? [];
  await req('POST', `/files/${file}/trash`, {});
  await req('POST', `/folders/${fa}/trash`, {});
  const orphan = await req('POST', `/files/${file}/restore-from-trash`, {});
  ok('O17', '父目录已回收时恢复文件，会落到「我的文件」并明确说明',
    orphan.status < 300 && /我的文件/.test(String(orphan.data?.note ?? '')), `note=${String(orphan.data?.note ?? '').slice(0, 30)} · A区残留 ${fa2.length}`);

  // 清理：把探针空间整体删掉
  await req('POST', `/folders/${fa}/trash`, {});
  await req('POST', `/folders/${fb}/trash`, {});
  await req('POST', `/folders/${inner}/trash`, {});
  const cleanup = await req('DELETE', `/spaces/${sid}`, {});
  ok('O16', '探针空间可清理（内容已回收则可删）', cleanup.status < 300, `HTTP ${cleanup.status} ${String(cleanup.error?.message ?? '').slice(0, 40)}`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
