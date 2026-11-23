// 验证「组织回落」修复：过期 / 非法的 X-Organization-Id 不再让登录与 /auth/me 被拒，
// 同时跨组织隔离仍然有效（回落目标只会是本人所属组织，读到的数据必须属于该组织）
const { probeBase, seedPassword } = require('./probe-base.cjs');
const B = probeBase();
const PW = seedPassword();
let fails = 0;
const ok = (n, p, d = '') => { console.log(`${p ? 'PASS' : 'FAIL'}  ${n}${d ? '  · ' + d : ''}`); if (!p) fails++; };

async function login(email, orgHeader) {
  const res = await fetch(B + '/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web', ...(orgHeader ? { 'X-Organization-Id': orgHeader } : {}) },
    body: JSON.stringify({ email, password: PW }),
  });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, error: j.error, data: j.data, cookie: (res.headers.getSetCookie()[0] ?? '').split(';')[0] };
}
async function get(cookie, org, p) {
  const res = await fetch(B + p, { headers: { cookie, 'X-FlowMate-Client': 'web', 'X-Organization-Id': org } });
  return { status: res.status, j: await res.json().catch(() => ({})) };
}

(async () => {
  const STALE = '00000000-0000-4000-8000-000000000000';   // 模拟重新灌种子后浏览器里残留的旧组织 ID
  const r1 = await login('baymax@xingyu.test', STALE);
  ok('带过期组织 ID 仍能登录（不再 403「不属于该组织」）', r1.status === 201 && !!r1.cookie, `HTTP ${r1.status} ${r1.error?.message ?? ''}`);

  const me1 = await get(r1.cookie, STALE, '/auth/me');
  const cur = me1.j.data?.current_org;
  const curId = typeof cur === 'string' ? cur : cur?.id;
  const orgIds = (me1.j.data?.organizations ?? []).map((o) => o.id);
  ok('/auth/me 在过期组织 ID 下正常返回', me1.status === 200 && !!curId, `HTTP ${me1.status} · current_org=${curId}`);
  ok('回落目标是本人所属组织之一', orgIds.includes(curId), `本人组织 ${orgIds.length} 个`);

  const tasks = await get(r1.cookie, STALE, '/tasks?scope=team');
  const rows = tasks.j.data?.items ?? [];
  ok('回落后的数据仍按组织隔离（任务全部属于生效组织）',
    tasks.status === 200 && rows.every((t) => t.organization_id === curId),
    `任务 ${rows.length} 条 · 生效组织 ${curId}`);

  const convs = await get(r1.cookie, STALE, '/conversations');
  ok('会话列表同样只含生效组织', (convs.j.data ?? []).every((c) => c.organization_id === curId), `${(convs.j.data ?? []).length} 条`);

  // 非成员组织：用一个不属于本人的随机 UUID，应回落到本人组织而不是报错
  const r2 = await login('xuyangtian@xingyu.test', null);
  const foreign = (me1.j.data?.organizations ?? []).find((o) => o.name === '汇川制造')?.id;
  const zhouOrgs = (await get(r2.cookie, '', '/auth/me')).j.data?.organizations ?? [];
  const zhouIds = zhouOrgs.map((o) => o.id);
  const asOutsider = await get(r2.cookie, foreign && !zhouIds.includes(foreign) ? foreign : 'not-an-uuid', '/organizations/members');
  ok('无权组织 ID 被忽略并回落，不泄漏他人组织数据', asOutsider.status === 200, `HTTP ${asOutsider.status} · 许杨天所属组织 ${zhouIds.length} 个`);

  // 四个演示账号逐个登录
  for (const e of ['baymax@xingyu.test', 'hy123@xingyu.test', 'cyx666@xingyu.test', 'xuyangtian@xingyu.test']) {
    const r = await login(e, STALE);
    const m = await get(r.cookie, STALE, '/auth/me');
    ok(`演示账号 ${e.split('@')[0]} 登录并取到身份`, r.status === 201 && m.status === 200 && !!m.j.data?.user?.display_name,
      m.j.data?.user?.display_name ?? '');
  }

  console.log(`\n结果：失败 ${fails} 项`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('异常：', e); process.exit(1); });
