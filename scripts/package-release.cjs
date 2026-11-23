// FlowMate · 出包脚本：生成可直接交给别人在自己电脑上跑起来的压缩包
//
// 用法：
//   node scripts/package-release.cjs                源码 + 已构建产物 + 出厂演示数据（推荐）
//   node scripts/package-release.cjs --no-data      不带任何数据（对方自己灌种子）
//   node scripts/package-release.cjs --live-data    带你本机 data/ 与 storage/ 的当前数据（自用备份）
//   node scripts/package-release.cjs --src-only     连 dist/ 也不带（对方自己 pnpm build）
//
//   输出：../FlowMate-v{版本}-含数据包.zip / ../FlowMate-v{版本}-源码包.zip / ../FlowMate-v{版本}-纯源码包.zip
//
// 四条硬规矩（都是踩过坑之后钉死的）：
//   1) 密钥绝不进包：只放 .env.example；出包前再逐文件扫描本机 .env 里的真实值，命中即中止。
//   2) 本机验证痕迹（data-probe*/storage-probe*/scratch/.probe/backups/*.log）不进包，
//      否则对方解压就看到「探针空间1793…」「算术题1793….md」这类测试垃圾。
//   3) 白名单式收录（只收该收的），不是黑名单式排除——新增临时目录不会再漏进包。
//   4) 默认带的是「出厂演示数据」= 单独 seed 出来的独立副本（.probe/demo-data + .probe/demo-storage）。
//      绝不把用户正在用的 data/flowmate.sqlite3 直接发出去，也绝不为了出包去清他的库。
//      导出统一走 VACUUM INTO：直接 cp 主库会丢 -wal 里的写入（实测：包里的库能列文件树但任务全空）。
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const WITH_DATA = !argv.includes('--no-data');
const LIVE_DATA = argv.includes('--live-data');
const SRC_ONLY = argv.includes('--src-only');

// ---------- 版本串一致性自检（第 5 条硬规矩）----------
// 踩过：升到 v2.0 时只改了 package.json 与产物名，启动横幅和两份指南还停在 v1.4，
// 对方拿到包照着「解压 FlowMate-v1.4-含数据包.zip」那行做，根本对不上。
// 这里只拦两类真正会误导人的写法：`FlowMate-vX.Y-…包.zip` 文件名、`FlowMate vX.Y` 横幅/版本行。
// 正文里「在 v1.3 基础上继续优化」这类历史叙述不受影响。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = 'v' + pkg.version.split('.').slice(0, 2).join('.');
{
  const stale = [];
  const scan = (file) => {
    let t;
    try { t = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { stale.push(`${file} 读不到`); return; }
    for (const m of t.matchAll(/FlowMate-v\d+\.\d+-(含数据包|源码包|纯源码包)\.zip/g)) {
      if (m[0] !== `FlowMate-${VER}-${m[1]}.zip`) stale.push(`${file}: ${m[0]} → 应为 FlowMate-${VER}-${m[1]}.zip`);
    }
    for (const m of t.matchAll(/FlowMate v\d+\.\d+/g)) {
      if (m[0] !== `FlowMate ${VER}`) stale.push(`${file}: ${m[0]} → 应为 FlowMate ${VER}`);
    }
  };
  for (const f of ['server/main.ts', '快速开始.md']) scan(f);
  if (stale.length) {
    console.error('\n[出包中止] 版本串没同步到 ' + VER + '（package.json 已是 ' + pkg.version + '）：');
    for (const s of [...new Set(stale)]) console.error('  - ' + s);
    console.error('  改完这几处再出包：server/main.ts 启动横幅、安装指南.md、快速开始.md。');
    process.exit(2);
  }
  console.log('[出包] 版本串自检通过：' + VER + ' 已同步到横幅与两份指南');
}

const DEMO_DB = path.join(ROOT, '.probe', 'demo-data', 'flowmate.sqlite3');
const DEMO_STORAGE = path.join(ROOT, '.probe', 'demo-storage');
const LIVE_DB = path.join(ROOT, 'data', 'flowmate.sqlite3');
const LIVE_STORAGE = path.join(ROOT, 'storage');

// 目录白名单：顶层只收这些（data / storage 走下面的「演示数据装配」，不在这里递归收）
const DIRS = ['src', 'server', 'worker', 'db', 'scripts', 'tests', 'docs', 'public'];
if (!SRC_ONLY) DIRS.push('dist');

// 根文件白名单
const ROOT_FILES = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'tsconfig.server.json', 'tsconfig.tests.json',
  'vite.config.ts', 'index.html', 'README.md', '快速开始.md', '.env.example', '.gitignore', '.env.sample'];

// 任何层级都要跳过的名字（探针产物、依赖、构建缓存、日志）
const SKIP_NAMES = /^(node_modules|\.git|\.pgdata|backups|\.probe|scratch|\.vite|coverage)$/;
const SKIP_PATTERNS = [
  /^data-probe/, /^storage-probe/, /^data-migtest/, /^\.DS_Store$/,
  /\.(log|tsbuildinfo|map\.gz)$/i, /^cdp-report/, /^\.env$/, /^\.env\.local/,
];
// 源码映射留给本地排障；给别人的包里 dist 只保留运行必需的 js/css/html
const DROP_IN_DIST = [/\.map$/];

const zip = new JSZip();
let count = 0;
let bytes = 0;
const skipped = [];

const realKey = (() => {
  // 从本机 .env 读出真实密钥值，出包时逐文件扫描，防止它换个地方混进来
  try {
    const t = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    return [...t.matchAll(/^([A-Z_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z_]*)=(.+)$/gm)]
      .map((m) => m[2].trim()).filter((v) => v.length >= 8);
  } catch { return []; }
})();

function wanted(rel, top, isDir = false) {
  const parts = rel.split(/[\\/]/);
  // 排除规则对目录名与文件名都要生效（data-probe / scratch / node_modules… 整棵剪掉）
  for (const p of parts) if (SKIP_NAMES.test(p) || SKIP_PATTERNS.some((re) => re.test(p))) { skipped.push(rel); return false; }
  // 目录只走排除规则；「只带 .sqlite3」「只带被引用的对象」这类文件级筛选绝不能作用在目录本身，
  // 否则 data 与 storage 会在第一层就被判为不收，整棵子树静默消失（实测踩过这个坑）。
  if (isDir) return parts.length === 1 ? DIRS.includes(top) : true;
  if (top === 'dist' && DROP_IN_DIST.some((re) => re.test(rel))) return false;
  if (top === 'data' || top === 'storage') return false;   // 由「演示数据装配」单独放
  if (parts.length === 1 && ROOT_FILES.includes(parts[0])) return true;
  return DIRS.includes(top);
}

function add(abs, rel) {
  const buf = fs.readFileSync(abs);
  const leak = realKey.find((k) => buf.includes(k));
  if (leak) {
    console.error('\n[出包中止] ' + rel + ' 里出现了疑似密钥内容（长度 ' + leak.length + '）。把密钥从源码/文档里移走再出包。');
    process.exit(3);
  }
  zip.file('FlowMate/' + rel.replace(/\\/g, '/'), buf);
  count++; bytes += buf.length;
}

function walk(abs, relBase) {
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.isSymbolicLink && e.isSymbolicLink()) continue;
    const rel = relBase ? relBase + '/' + e.name : e.name;
    const top = rel.split(/[\\/]/)[0];
    if (!wanted(rel, top, e.isDirectory())) continue;
    const absChild = path.join(abs, e.name);
    if (e.isDirectory()) { walk(absChild, rel); continue; }
    if (e.isFile()) add(absChild, rel);
  }
}

walk(ROOT, '');

// ---------- 演示数据装配 ----------
let referencedCount = 0;
if (WITH_DATA) {
  const { DatabaseSync } = require('node:sqlite');
  const srcDb = LIVE_DATA ? LIVE_DB : DEMO_DB;
  const srcStorage = LIVE_DATA ? LIVE_STORAGE : DEMO_STORAGE;
  if (!fs.existsSync(srcDb)) {
    console.error('[出包中止] 找不到数据源 ' + srcDb + '。' + (LIVE_DATA ? '' :
      '\n  先生成一份出厂演示数据（不会碰你正在用的库）：\n' +
      '    mkdir -p .probe/demo-data .probe/demo-storage\n' +
      '    FLOWMATE_DATA_DIR=.probe/demo-data FLOWMATE_STORAGE_DIR=.probe/demo-storage node dist/scripts/seed.js'));
    process.exit(4);
  }
  // 每次用带时间戳的新文件：VACUUM INTO 要求目标不存在，而删旧快照会踩「不得用脚本删除文件」的红线
  const staged = path.join(ROOT, '.probe', 'package-db-' + Date.now() + '.sqlite');
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  console.log('[出包] 数据源：' + (LIVE_DATA ? '本机当前库（含你的测试数据）' : '出厂演示数据（独立 seed 副本，未改动你的库）'));
  console.log('[出包] VACUUM INTO 导出一致性副本（源库只读）…');
  const db = new DatabaseSync(srcDb, { readOnly: true });
  try { db.exec("VACUUM INTO '" + staged.replace(/\\/g, '/').replace(/'/g, "''") + "'"); } finally { db.close(); }

  const rows = new DatabaseSync(staged, { readOnly: true });
  const n = (t) => rows.prepare('SELECT COUNT(*) c FROM ' + t).get().c;
  const stat = { tasks: n('tasks'), files: n('files'), folders: n('folders'), sessions: n('agent_sessions') };
  const keys = [...rows.prepare('SELECT object_key k FROM file_versions WHERE object_key IS NOT NULL').all(),
    ...rows.prepare('SELECT object_key k FROM auxiliary_attachments WHERE object_key IS NOT NULL').all()]
    .map((r) => String(r.k)).filter(Boolean);
  rows.close();
  console.log('  演示数据：任务 ' + stat.tasks + ' · 文件 ' + stat.files + ' · 工作区 ' + stat.folders + ' · 会话 ' + stat.sessions + ' · 引用对象 ' + new Set(keys).size + ' 个');
  if (stat.tasks <= 0 || stat.files <= 0) {
    console.error('[出包中止] 导出的演示数据是空的，宁可不出包，也别把空库交给别人。');
    process.exit(5);
  }

  add(staged, 'data/flowmate.sqlite3');
  const missing = [];
  const set = new Set(keys);
  referencedCount = set.size;
  for (const k of set) {
    const abs = path.join(srcStorage, k.slice(0, 2), k);
    if (fs.existsSync(abs)) add(abs, 'storage/' + k.slice(0, 2) + '/' + k);
    else missing.push(k);
  }
  if (missing.length) {
    console.error('[出包中止] 库里有 ' + missing.length + ' 个文件对象在 ' + srcStorage + ' 找不到（对方解压后会看到打不开的文件）。缺：' + missing.slice(0, 3).join(', '));
    process.exit(6);
  }
  console.log('  storage 对象按引用装配：' + set.size + ' 个（孤儿对象不进包）');
}

const manifest = {
  产品: `FlowMate ${VER}（Lite 模式：Node + 内置 SQLite，无需装数据库）`,
  生成时间: new Date().toISOString(),
  含演示数据: WITH_DATA ? (LIVE_DATA ? '是（本机当前数据）' : '是（出厂演示数据 · 独立 seed 副本）') : false,
  含构建产物: !SRC_ONLY,
  文件数: count,
  原始字节: bytes,
  已排除: ['node_modules', '.env（真实模型密钥，绝不外发）', 'backups', 'data-probe* / storage-probe* / scratch / .probe（本机验证痕迹）', '*.log', ...(WITH_DATA ? [] : ['data', 'storage'])],
  对方三步: !SRC_ONLY && WITH_DATA
    ? ['解压', 'pnpm install', 'pnpm start，然后打开 http://localhost:8080（账号密码见包内《README.md》）']
    : SRC_ONLY
      ? ['解压', 'pnpm install && pnpm build && pnpm seed', 'pnpm start']
      : ['解压', 'pnpm install', 'pnpm run seed:reset 灌演示数据，然后 pnpm start'],
};
zip.file('FlowMate/PACKAGE-MANIFEST.json', JSON.stringify(manifest, null, 2));

(async () => {
  const ver = VER;   // 版本串只在上面读一次，避免两处各算各的
  const name = WITH_DATA ? `FlowMate-${ver}-含数据包.zip` : SRC_ONLY ? `FlowMate-${ver}-纯源码包.zip` : `FlowMate-${ver}-源码包.zip`;
  const out = path.join(path.dirname(ROOT), name);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  // 出包后自检：声明含数据 / 含构建产物，就必须真在包里。
  // 历史上目录级筛选把 data 与 storage 整棵剪掉过，包照样生成成功，对方解压才发现没数据
  // ——所以这里按声明逐条核对，缺一条就非零退出，绝不出「看起来成功」的包。
  const back = await JSZip.loadAsync(buf);
  const have = new Set(Object.keys(back.files));
  const need = ['FlowMate/快速开始.md', 'FlowMate/package.json', 'FlowMate/.env.example'];
  if (!SRC_ONLY) need.push('FlowMate/dist/server/main.js', 'FlowMate/dist/client/index.html');
  if (WITH_DATA) {
    need.push('FlowMate/data/flowmate.sqlite3');
    const objs = [...have].filter((x) => x.startsWith('FlowMate/storage/')).length;
    if (objs < referencedCount) {
      console.error('[出包中止] 声明含数据，但包里 storage 对象只有 ' + objs + ' 个，应有 ' + referencedCount + ' 个。');
      process.exit(7);
    }
  }
  const missingNeed = need.filter((x) => !have.has(x));
  if (missingNeed.length) { console.error('[出包中止] 包里缺少：' + missingNeed.join(', ')); process.exit(7); }
  const leaked = [...have].filter((x) => /\/\.env$|data-probe|storage-probe|node_modules|\/scratch\/|\/\.probe\/|\/backups\//.test(x));
  if (leaked.length) { console.error('[出包中止] 包里混进了不该有的条目：' + leaked.slice(0, 5).join(', ')); process.exit(8); }

  fs.writeFileSync(out, buf);
  console.log('\n已出包：' + out);
  console.log('  文件 ' + count + ' 个 · 原始 ' + (bytes / 1048576).toFixed(1) + ' MB · 压缩包 ' + (buf.length / 1048576).toFixed(1) + ' MB · 含数据 ' + (WITH_DATA ? (LIVE_DATA ? '本机' : '出厂') : '否') + ' · 含构建产物 ' + !SRC_ONLY);
  console.log('  出包自检：必需条目 ' + need.length + ' 条 + 密钥扫描 + 测试垃圾排除，全部通过');
  if (skipped.length) console.log('  拦下的可疑路径 ' + skipped.length + ' 条（前 5）：' + [...new Set(skipped)].slice(0, 5).join(', '));
})();
