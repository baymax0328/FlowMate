// FlowMate · 探针/回归脚本的基址收口
//
// 为什么要有这个文件：各探针历史上各自写 `process.env.XXX_BASE || 'http://localhost:8080/api/v1'`，
// 环境变量名互不相同（PROBE_BASE / SHARE_BASE / SPACE_BASE / OPS_BASE / COVER_BASE / WORK_BASE /
// CHATMODE_BASE / E2E_BASE），只要漏传一个，就会**静默打到用户本机常驻的 8080 实例与其线上库**，
// 把测试数据写进用户真实数据里。实测已因此污染过一次线上库（见本轮更正）。
//
// 规则：默认指向验证实例 8090；任何解析结果落在 8080 都必须显式 ALLOW_8080=1 才放行。
const VERIFICATION_DEFAULT = 'http://127.0.0.1:8090/api/v1';

export function probeBase(names = []) {
  const envs = [
    ...names,
    'PROBE_BASE', // 统一覆盖变量：一次 export 就能把整套探针指向同一个实例
    'FLOWMATE_BASE',
  ];
  let base = '';
  for (const n of envs) if (process.env[n]) { base = process.env[n]; break; }
  if (!base) base = VERIFICATION_DEFAULT;
  if (process.env.ALLOW_8080 !== '1' && /[:/]8080\b/.test(base)) {
    console.error(
      `[probe-base] 已拒绝：目标 ${base} 指向用户本机常驻的 8080 实例。\n` +
      '            验证一律用独立实例（8090）+ 真实数据副本；\n' +
      '            确实要跑 8080 请显式加环境变量 ALLOW_8080=1。',
    );
    process.exit(2);
  }
  return base.replace(/\/+$/, '');
}

export const seedPassword = () => process.env.SEED_PASSWORD || 'abc123';
