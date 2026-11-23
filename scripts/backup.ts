// FlowMate · 备份与恢复（PRD §21：一条命令产出数据库 + storage 的压缩包；不做恢复演练与 RPO/RTO 承诺）
// 用法：pnpm backup            产出 backups/<时间戳>/manifest.json 与 backup.zip
//       pnpm restore <目录>    从该目录恢复（会先自动把当前数据挪到 backups/pre-restore-<时间戳>/）
import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { config, ensureDirs } from '../server/core/config';

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

function dbFiles(): string[] {
  const base = path.join(config.dataDir, 'flowmate.sqlite3');
  return [base, `${base}-wal`, `${base}-shm`].filter((f) => fs.existsSync(f));
}

async function pack(dir: string) {
  const zip = new JSZip();
  for (const f of dbFiles()) zip.file(`db/${path.basename(f)}`, fs.readFileSync(f));
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs, `${rel}${e.name}/`);
      else zip.file(`${rel}${e.name}`, fs.readFileSync(abs));
    }
  };
  if (fs.existsSync(config.storageDir)) walk(config.storageDir, 'storage/');
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(dir, 'backup.zip'), buf);
  return buf.length;
}

async function backup() {
  ensureDirs();
  const dir = path.join(config.root, 'backups', stamp());
  fs.mkdirSync(dir, { recursive: true });
  const bytes = await pack(dir);
  const manifest = {
    at: new Date().toISOString(),
    zip_bytes: bytes,
    database: dbFiles().map((f) => path.basename(f)),
    storage_dir: config.storageDir,
    note: '恢复前请先停止 FlowMate 服务进程（避免 WAL 与打开中的文件句柄）',
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`[backup] 完成：${dir}`);
  console.log(`[backup] 压缩包 ${(bytes / 1024 / 1024).toFixed(2)} MB · 数据库文件 ${manifest.database.length} 个`);
}

async function restore(from: string) {
  const zipPath = path.resolve(from.endsWith('.zip') ? from : path.join(from, 'backup.zip'));
  if (!fs.existsSync(zipPath)) {
    console.error(`[restore] 找不到 ${zipPath}`);
    process.exit(1);
  }
  ensureDirs();
  const pre = path.join(config.root, 'backups', `pre-restore-${stamp()}`);
  fs.mkdirSync(pre, { recursive: true });
  await pack(pre);
  console.log(`[restore] 当前数据已挪到 ${pre}`);

  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const rel = name.replace(/^db\//, '').replace(/^storage\//, '');
    if (!rel) continue;
    const target = name.startsWith('storage/')
      ? path.join(config.storageDir, rel)
      : path.join(config.dataDir, rel);
    if (!target.startsWith(config.dataDir) && !target.startsWith(config.storageDir)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, await entry.async('nodebuffer'));
  }
  console.log('[restore] 完成。请重新启动服务：pnpm start');
}

const argRestore = process.argv.includes('--restore') || process.argv.includes('restore');
if (argRestore) {
  const idx = process.argv.findIndex((a) => a === '--restore' || a === 'restore');
  const from = process.argv[idx + 1] || (awaitLatestBackup());
  if (!from) {
    console.error('[restore] backups/ 下没有可恢复的存档');
    process.exit(1);
  }
  restore(from).catch((e) => { console.error('[restore] 失败：', e); process.exit(1); });
} else {
  backup().catch((e) => { console.error('[backup] 失败：', e); process.exit(1); });
}

function awaitLatestBackup(): string | null {
  const root = path.join(config.root, 'backups');
  if (!fs.existsSync(root)) return null;
  const list = fs.readdirSync(root).filter((d) => !d.startsWith('pre-restore-')).sort();
  return list.length ? path.join(root, list[list.length - 1]) : null;
}
