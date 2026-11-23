// FlowMate · 一键回归：把散在各处的探针收成一个命令
//
// 用法：
//   node scripts/verify-all.mjs                 # 默认打 8090（验证实例）
//   PROBE_BASE=http://127.0.0.1:8091/api/v1 node scripts/verify-all.mjs
//
// 前置：先起一个独立实例（不要拿用户本机常驻的 8080 当靶子）：
//   node scripts/snapshot.mjs data-probe/flowmate.sqlite3      # 从线上库导一份只读一致的副本
//   cp -r storage storage-probe                                # 对象存储也隔开
//   FLOWMATE_PORT=8090 FLOWMATE_DATA_DIR=data-probe FLOWMATE_STORAGE_DIR=storage-probe node dist/server/main.js
//
// 设计口径：每套套件单独报「通过 N / 总数」，任何一套非零退出都会在汇总里显出来，
// 不做「跑不动就跳过」的静默容忍。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.PROBE_BASE || 'http://127.0.0.1:8090/api/v1';
if (process.env.ALLOW_8080 !== '1' && /[:/]8080\b/.test(base)) {
  console.error(`[verify-all] 已拒绝：目标 ${base} 是用户本机常驻实例。请另起 8090 验证，或显式 ALLOW_8080=1。`);
  process.exit(2);
}

const SUITES = [
  { name: '单元与 CSS 层叠回归', cmd: 'node', args: ['--test', 'tests/*.test.mjs'], kind: 'unit' },
  { name: 'Agent 会话崩溃与问答契约', cmd: 'node', args: ['tests/agent-chat-probe.mjs'], kind: 'probe' },
  { name: '工作模式（读文件回答，不改文件）', cmd: 'node', args: ['tests/chat-mode-probe.mjs'], kind: 'probe' },
  { name: '共享与归档（实时/快照/有效期）', cmd: 'node', args: ['tests/sharing-probe.mjs'], kind: 'probe' },
  { name: '空间与回收站（派生根/绑定/可恢复）', cmd: 'node', args: ['tests/spaces-probe.mjs'], kind: 'probe' },
  { name: '文档页操作（转移/复制/删除/恢复）', cmd: 'node', args: ['tests/workspace-ops-probe.mjs'], kind: 'probe' },
  { name: '演示数据覆盖度（不留空壳目录）', cmd: 'node', args: ['tests/docs-coverage-probe.mjs'], kind: 'probe' },
  { name: 'Agent 产出草稿与正式变更走提案', cmd: 'node', args: ['tests/agent-work-probe.mjs'], kind: 'probe' },
  { name: '消息页交互（@我/未读/回复引用）', cmd: 'node', args: ['tests/message-ux-probe.mjs'], kind: 'probe' },
  { name: '端到端全链路（§02–§19）', cmd: 'node', args: ['tests/e2e.mjs'], kind: 'e2e' },
];

// SSR 渲染回归要先用 esbuild 打包（.tsx 里有 import 类型标注，node --test 不吃 TS）
function buildSsr() {
  const out = '.probe/ssr-agent-render.mjs';
  mkdirSync(resolve(root, '.probe'), { recursive: true });
  const esbuild = resolve(root, 'node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild');
  const bin = existsSync(esbuild) ? esbuild : resolve(root, 'node_modules/esbuild/bin/esbuild');
  const r = spawnSync(process.execPath, [bin, 'tests/agent-render-ssr.tsx', '--bundle', '--platform=node',
    '--format=esm', '--packages=external', '--loader:.css=empty', '--loader:.svg=dataurl', '--loader:.png=dataurl', `--outfile=${out}`, '--log-level=error'],
  { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); return null; }
  return out;
}

const countOf = (text, kind) => {
  if (kind === 'unit') {
    const pass = /ℹ pass (\d+)/.exec(text); const fail = /ℹ fail (\d+)/.exec(text);
    return { pass: +pass?.[1] || 0, fail: +fail?.[1] || 0 };
  }
  if (kind === 'e2e') {
    const m = /通过 (\d+) \/ (\d+)；失败 (\d+)/.exec(text);
    return m ? { pass: +m[1], total: +m[2], fail: +m[3] } : { pass: 0, fail: 1 };
  }
  // 探针自己会打印一行汇总（「FAIL 1 项 · base=…」），不能把它当成第 2 个失败断言数进去：
  // 断言行永远是 PASS/FAIL + 以字母开头的编号（A01 / L08 / C04a / W01 / M00 / S1a2b3…）。
  const lines = text.split('\n').filter((l) => /^(PASS|FAIL)\s+[A-Za-z]\S*\s/.test(l));
  return { pass: lines.filter((l) => l.startsWith('PASS')).length, fail: lines.filter((l) => l.startsWith('FAIL')).length };
};

const results = [];
const started = Date.now();
let totalFail = 0;

for (const suite of SUITES) {
  const label = suite.name;
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(suite.cmd, suite.args, { cwd: root, encoding: 'utf8', env: { ...process.env, PROBE_BASE: base }, maxBuffer: 40 * 1024 * 1024 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const c = countOf(text, suite.kind);
  const failed = c.fail > 0 || (r.status ?? 1) !== 0;
  if (failed) {
    totalFail += c.fail || 1;
    text.split('\n').filter((l) => /^FAIL|^ℹ fail [1-9]|探针自身出错|Error:/.test(l)).slice(0, 12).forEach((l) => console.log('   ' + l));
  }
  results.push({ label, pass: c.pass, fail: c.fail, exit: r.status ?? 1, ok: !failed });
  console.log(`   ${failed ? '✗' : '✓'} 通过 ${c.pass} · 失败 ${c.fail} · exit ${r.status}`);
}

const ssrFile = buildSsr();
if (ssrFile) {
  process.stdout.write('\n▶ SSR 渲染回归（真实数据形状渲染成 HTML）\n');
  const r = spawnSync(process.execPath, [ssrFile], { cwd: root, encoding: 'utf8', env: { ...process.env, PROBE_BASE: base }, maxBuffer: 40 * 1024 * 1024 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const c = countOf(text, 'probe');
  const failed = c.fail > 0 || (r.status ?? 1) !== 0;
  if (failed) { totalFail += c.fail || 1; text.split('\n').filter((l) => /^FAIL|Error:/.test(l)).slice(0, 12).forEach((l) => console.log('   ' + l)); }
  results.push({ label: 'SSR 渲染回归', pass: c.pass, fail: c.fail, exit: r.status ?? 1, ok: !failed });
  console.log(`   ${failed ? '✗' : '✓'} 通过 ${c.pass} · 失败 ${c.fail} · exit ${r.status}`);
} else {
  results.push({ label: 'SSR 渲染回归', pass: 0, fail: 1, exit: 1, ok: false });
  totalFail++;
  console.log('\n▶ SSR 渲染回归\n   ✗ 打包失败（整套没跑起来，按失败计）');
}

console.log('\n———————————— 回归汇总 ————————————');
for (const x of results) console.log(`  ${x.ok ? '✓' : '✗'} ${x.label.padEnd(28, ' ')} 通过 ${String(x.pass).padStart(3)} · 失败 ${x.fail}`);
const totalPass = results.reduce((a, b) => a + b.pass, 0);
console.log(`\n合计：通过 ${totalPass} · 失败 ${totalFail} · 用时 ${((Date.now() - started) / 1000).toFixed(0)}s · 靶实例 ${base}`);
writeFileSync(resolve(root, '.probe/verify-last.json'), JSON.stringify({ base, totalPass, totalFail, results }, null, 2));
process.exit(totalFail ? 1 : 0);
