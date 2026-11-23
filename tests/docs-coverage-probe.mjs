// FlowMate · 演示数据覆盖度检查
// 起因：文档页「组织空间 / 产品知识库」里有子目录，界面却显示「这个目录还是空的」——
// 一半原因是 URL 状态把 folder 抹掉了（另见 U01—U06），另一半是种子只给一个目录灌了文件：
// 组织根、产品知识库、三个团队根、以及除许杨天外所有人的「我的文件」全是空的。
// 这个探针按空间树逐层列目录，保证每个可见目录都至少有一个条目可点。
import { probeBase } from './probe-base.mjs';
const B = probeBase(['COVER_BASE']);
const PW = process.env.SEED_PASSWORD || 'abc123'; // 见 probe-base.mjs：B 已收口，禁止默认 8080

let failures = 0;
const ok = (id, name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(5)} ${name}${detail ? '  · ' + detail : ''}`);
};
let ck = '';
let org = '';
// 探针自己造的临时目录（名字带 探针 / e2e / 操作探针 / 渲染回归）不算演示数据缺内容：
// 否则跑过 ops-probe 的库会被自己的临时产物判成「产品没内容」，是假阳性。
const SCRATCH = /(探针|e2e|操作探针|渲染回归)/;
async function req(path) {
  const res = await fetch(B + path, { headers: { 'X-FlowMate-Client': 'web', 'X-Organization-Id': org, cookie: ck } });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, data: j.data, error: j.error };
}

const main = async () => {
  const login = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: 'baymax@xingyu.test', password: PW }),
  });
  ck = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  org = ((await req('/auth/me')).data?.organizations ?? [])[0]?.id ?? '';

  const spaces = (await req('/spaces')).data ?? [];
  const named = spaces.filter((s) => s.id);
  ok('D00', '空间列有三类分组', ['personal', 'team', 'org'].every((k) => named.some((s) => s.space === k)),
    named.map((s) => `${s.space}:${s.name}`).join(' | '));

  // 这套断言判的是「出厂演示数据有没有留空壳」，所以必须先划清范围：
  // seed 用同一个时间戳批量插入所有演示行，凡 created_at 不等于这个批次的
  // 都是用户/探针后来自己建的（用户建一个空文件夹是正常操作，不该被判成演示数据缺陷）。
  const seedStamp = (named.map((s) => s.created_at).filter(Boolean).sort()[0]) ?? '';
  const isSeed = (x) => !seedStamp || String(x?.created_at ?? '') === seedStamp;
  ok('D0', '能识别演示数据批次（按 seed 时间戳划范围）', !!seedStamp, `批次时间戳=${seedStamp}`);

  let i = 0;
  for (const s of named.filter((x) => !SCRATCH.test(x.name ?? '') && isSeed(x))) {
    i++;
    const kids = await req(`/folders/${s.id}/children`);
    const foldersN = (kids.data?.folders ?? []).length;
    const filesN = (kids.data?.files ?? []).length;
    ok('D' + String(i).padStart(2, '0'), `空间「${s.name}」根目录非空`, kids.status === 200 && foldersN + filesN > 0,
      `子目录 ${foldersN} · 文件 ${filesN}`);
  }

  // 往下钻两层：每个可见子目录也要有内容（空目录留到用户自己建，演示数据不留空壳）
  const walk = async (id, label, depth, parentScratch = false) => {
    if (depth > 2) return;
    const kids = await req(`/folders/${id}/children`);
    for (const f of (kids.data?.folders ?? [])) {
      const scratch = isScratch(f.name, parentScratch);
      if (scratch || !isSeed(f)) continue;   // 用户自己新建的空夹子不算演示数据缺陷（见上面的批次划范围）
      const inner = await req(`/folders/${f.id}/children`);
      const n = (inner.data?.folders ?? []).filter(isSeed).length + (inner.data?.files ?? []).length;
      ok('S' + f.id.slice(0, 6), `${label} / ${f.name} 里有内容`, n > 0, `条目 ${n}`);
      await walk(f.id, `${label} / ${f.name}`, depth + 1);
    }
  };
  // 演示数据不留空壳，但「探针临时搭的脚手架」不算演示数据缺陷：
  // 排除要按**整条路径**生效——否则「探针空间X / 子目录A」会因为子目录A 自己不带「探针」二字被当成空壳报出来
  const isScratch = (name, parentScratch) => parentScratch || SCRATCH.test(name ?? '');
  for (const s of named) await walk(s.id, s.name, 1, SCRATCH.test(s.name ?? '') || !isSeed(s));

  // 正文可检索（Agent 读文件与搜索都依赖它）
  const hit = await req('/search?q=' + encodeURIComponent('首屏可交互时间') + '&type=files');
  const groups = hit.data?.groups ?? {};
  const fileHits = groups.files?.items ?? groups.files ?? [];
  ok('D90', '新种的 Markdown 正文可被检索命中', Array.isArray(fileHits) && fileHits.length > 0,
    `命中 ${Array.isArray(fileHits) ? fileHits.length : 0} 条`);

  console.log(`\n${failures ? `FAIL ${failures} 项` : 'ALL PASS'} · base=${B}`);
  process.exit(failures ? 1 : 0);
};
main().catch((e) => { console.error('探针自身出错：', e); process.exit(2); });
