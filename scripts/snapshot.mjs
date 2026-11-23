// FlowMate · 只读快照：把线上库安全地复制成一份可用于验证的副本
//
// 为什么不能用 cp：SQLite 开了 WAL，主库文件 + -wal 分开落盘，直接 cp 会得到
// 「主库与 WAL 不匹配」的副本，回放时整段 WAL 被丢弃，实测把 session_messages 拷成 0 条，
// 于是所有断言都变成「空集上的真」。VACUUM INTO 由 SQLite 自己一致性导出，源库只读、不改写。
//
// 用法：node scripts/snapshot.mjs <目标文件> [源库=DATA_DIR/flowmate.sqlite3]
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const [outArg, srcArg] = process.argv.slice(2);
if (!outArg) {
  console.error('用法：node scripts/snapshot.mjs <目标文件> [源库]');
  process.exit(2);
}
const src = resolve(srcArg || process.env.DB_PATH || 'data/flowmate.sqlite3');
const out = resolve(outArg);
mkdirSync(dirname(out), { recursive: true });
const size = statSync(src).size;
const db = new DatabaseSync(src, { readOnly: true });
try {
  // VACUUM INTO 要求目标不存在，因此这里不做覆盖：交给调用方用带时间戳的新文件名。
  db.exec(`VACUUM INTO '${out.replace(/\\/g, '/').replace(/'/g, "''")}'`);
} finally {
  db.close();
}
console.log(`[snapshot] ${src} (${size}B) → ${out} (${statSync(out).size}B) · 源库只读未改写`);
