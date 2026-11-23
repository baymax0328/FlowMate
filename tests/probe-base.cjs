// CommonJS 版基址收口，逻辑与 probe-base.mjs 一致（.cjs 手工诊断脚本用）。
const VERIFICATION_DEFAULT = 'http://127.0.0.1:8090/api/v1';

function probeBase(names = []) {
  let base = '';
  for (const n of [...names, 'PROBE_BASE', 'FLOWMATE_BASE']) {
    if (process.env[n]) { base = process.env[n]; break; }
  }
  if (!base) base = VERIFICATION_DEFAULT;
  if (process.env.ALLOW_8080 !== '1' && /[:/]8080\b/.test(base)) {
    console.error(`[probe-base] 已拒绝：目标 ${base} 指向用户本机常驻的 8080 实例。验证请用 8090 独立实例；确需 8080 请显式 ALLOW_8080=1。`);
    process.exit(2);
  }
  return base.replace(/\/+$/, '');
}

module.exports = { probeBase, seedPassword: () => process.env.SEED_PASSWORD || 'abc123' };
