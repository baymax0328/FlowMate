// FlowMate · 给「空目录」补一份说明性 Markdown（只创建，不删除、不覆盖）
// 为什么需要：种子的补全要 `pnpm seed:reset` 才生效，而那会清空你现在这个库里的真实数据。
// 这个脚本走正常接口，只遍历现有目录，给空的目录建一份 md，已有的目录一律不动，可以反复跑。
//
// 用法：node scripts/backfill-docs.mjs                 # 默认 http://localhost:8080
//       BACKFILL_BASE=http://localhost:8090/api/v1 node scripts/backfill-docs.mjs
//       BACKFILL_USER / BACKFILL_PASSWORD 换账号（默认演示负责人）
const B = process.env.BACKFILL_BASE || 'http://localhost:8080/api/v1';
const EMAIL = process.env.BACKFILL_USER || 'baymax@xingyu.test';
const PW = process.env.BACKFILL_PASSWORD || 'abc123';
const DOC = '目录说明.md';
const MAX_DEPTH = Number(process.env.BACKFILL_DEPTH || 4);

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let created = 0;
let skipped = 0;
let failed = 0;

async function fillFolder(id, label, depth) {
  const kids = await req('GET', `/folders/${id}/children`);
  if (kids.status !== 200) { console.log(`  跳过（无权或不可见）：${label}`); return; }
  const folders = kids.data?.folders ?? [];
  const files = kids.data?.files ?? [];
  if (files.length === 0) {
    const body = [
      `# ${label.split(' / ').pop()} —— 目录说明`,
      '',
      '这份文档是自动补的占位说明，用来让这个目录一眼看得出用途；可以直接改名或删掉（删除会进回收站）。',
      '',
      '## 放什么',
      '- 与本目录主题直接相关的正式文档；过程稿请放个人空间，确认后再移进来。',
      '- 跨目录引用的话，请把出处写在正文里，不要复制第二份。',
      '',
      '## 权限',
      depth <= 1 ? '- 组织空间的目录默认全组织可查看；不想公开的内容请放到个人空间或团队空间。' : '- 继承上层目录的权限；改权限在本目录的「共享与权限」里设置。',
      '',
      '## 改动约定',
      '- 正式文件的修改走「团队办公」的共同确认，全部相关指令人同意后才写入。',
      '- 直接把文件拖进来上传即可，允许类型：md / txt / html / docx / pdf / xlsx / csv / pptx 与图片。',
    ].join('\n');
    const r = await req('POST', '/files', { folder_id: id, name: DOC, format: 'markdown', content: body });
    if (r.status < 300) { created++; console.log(`  + 已补 ${DOC}：${label}`); }
    else if (/同名|already|重名/.test(String(r.error?.message ?? ''))) { skipped++; }
    else { failed++; console.log(`  ! 失败：${label} → HTTP ${r.status} ${r.error?.message ?? ''}`); }
  } else {
    skipped++;
    console.log(`  已有 ${files.length} 个文件，不动：${label}`);
  }
  for (const f of folders) {
    if (depth >= MAX_DEPTH) continue;
    await fillFolder(f.id, `${label} / ${f.name}`, depth + 1);
  }
}

const main = async () => {
  const login = await fetch(B + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  if (!login.ok) { console.error(`登录失败 HTTP ${login.status}：先确认服务在跑（pnpm start），或换 BACKFILL_USER`); process.exit(2); }
  ck = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await req('GET', '/auth/me');
  org = (me.data?.organizations ?? [])[0]?.id ?? '';
  console.log(`以 ${me.data?.user?.display_name ?? EMAIL} 的身份补齐「${me.data?.organizations?.[0]?.name ?? org}」的空目录`);

  const roots = (await req('GET', '/spaces')).data ?? [];
  for (const s of roots.filter((x) => x.id)) {
    console.log(`\n空间：${s.name}（${s.space}）`);
    await fillFolder(s.id, s.name, 0);
    await sleep(40);
  }
  console.log(`\n完成：新建 ${created} 份，跳过 ${skipped} 个已有内容的目录，失败 ${failed} 个。`);
  console.log('正文抽取是异步的，稍等几秒后搜索与 Agent 读文件就能命中这些文档。');
  process.exit(failed ? 1 : 0);
};
main().catch((e) => { console.error('脚本出错：', e); process.exit(2); });
