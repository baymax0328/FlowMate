// FlowMate · 数据库层（node:sqlite / SQLite 3.49 + FTS5）
// PRD §17：状态提交、审计事件与 outbox 在同一事务边界内。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { config } from './config';

export const uuid = () => randomUUID();
export const nowIso = () => new Date().toISOString();
export const sha256 = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');
export const token = () => randomBytes(32).toString('hex');

function norm(v: unknown): SqlParam {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v as SqlParam;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return JSON.stringify(v);
}
export type SqlParam = null | number | string | bigint | Uint8Array;
type Row = Record<string, unknown>;

export class Db {
  private raw: DatabaseSync;
  private txDepth = 0;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode=WAL');
    this.raw.exec('PRAGMA synchronous=NORMAL');
    this.raw.exec('PRAGMA foreign_keys=ON');
    this.raw.exec('PRAGMA busy_timeout=8000');
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.raw.prepare(sql).all(...params.map(norm)) as T[];
  }
  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.raw.prepare(sql).get(...params.map(norm)) as T | undefined;
  }
  run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params.map(norm));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  exec(sql: string) {
    this.raw.exec(sql);
  }
  /** 取单值 */
  val<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    const r = this.get<Row>(sql, ...params);
    if (!r) return undefined;
    return Object.values(r)[0] as T;
  }

  /** 嵌套安全事务（savepoint），保证事件 + outbox + 业务写入同边界 */
  tx<T>(fn: () => T): T {
    const name = `sp_${this.txDepth}`;
    if (this.txDepth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.txDepth--;
      if (this.txDepth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${name}`);
      throw e;
    }
  }

  close() {
    this.raw.close();
  }
}

let db: Db;
export function getDb(): Db {
  if (!db) db = new Db(path.join(config.dataDir, 'flowmate.sqlite3'));
  return db;
}
/** 测试用：指向内存/临时库 */
export function useDbFile(file: string) {
  if (db) db.close();
  db = new Db(file);
  return db;
}

export function runMigrations(d: Db, dir = path.join(config.root, 'db', 'migrations')) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const applied = new Set(d.all<{ key: string }>('SELECT key FROM schema_meta').map((r) => r.key));
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    d.tx(() => {
      d.exec(sql);
      d.run('INSERT INTO schema_meta(key,value) VALUES(?,?)', f, nowIso());
    });
    console.log(`[db] 迁移 ${f} 完成`);
  }
}

export const j = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
export const S = (v: unknown) => JSON.stringify(v ?? null);

/** 追加事件（与业务写入同事务）+ 发往 outbox，由 WS / 通知投递器消费 */
export function appendEvent(opts: {
  type: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  revision?: number;
  actor_id?: string | null;
  conversation_id?: string | null;
  session_id?: string | null;
  run_id?: string | null;
  task_id?: string | null;
  payload?: Record<string, unknown>;
}) {
  const d = getDb();
  const eventId = uuid();
  const occurredAt = nowIso();
  const r = d.run(
    `INSERT INTO events(event_id,organization_id,type,entity_type,entity_id,revision,actor_id,
      conversation_id,session_id,run_id,task_id,payload,occurred_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventId, opts.organization_id, opts.type, opts.entity_type, opts.entity_id,
    opts.revision ?? null, opts.actor_id ?? null, opts.conversation_id ?? null,
    opts.session_id ?? null, opts.run_id ?? null, opts.task_id ?? null,
    S(opts.payload ?? {}), occurredAt,
  );
  return { eventId, seq: r.lastInsertRowid, occurredAt };
}

export function queueOutbox(recipients: { user_id: string | null; channel: string; payload?: unknown }[], eventSeq: number) {
  const d = getDb();
  for (const r of recipients) {
    d.run('INSERT INTO outbox(event_seq,channel,user_id,payload,status,attempts,created_at) VALUES(?,?,?,?,?,0,?)',
      eventSeq, r.channel, r.user_id, S(r.payload ?? {}), 'pending', nowIso());
  }
}

export function notify(rec: {
  user_id: string; organization_id: string; type: string; title: string; body?: string;
  entity_type?: string; entity_id?: string; actor_id?: string | null;
  conversation_id?: string | null; session_id?: string | null; task_id?: string | null;
  proposal_id?: string | null; target_path?: string;
}) {
  const d = getDb();
  d.run(`INSERT INTO notifications(id,organization_id,user_id,type,title,body,entity_type,entity_id,actor_id,
    conversation_id,session_id,task_id,proposal_id,target_path,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    uuid(), rec.organization_id, rec.user_id, rec.type, rec.title, rec.body ?? null,
    rec.entity_type ?? null, rec.entity_id ?? null, rec.actor_id ?? null,
    rec.conversation_id ?? null, rec.session_id ?? null, rec.task_id ?? null,
    rec.proposal_id ?? null, rec.target_path ?? null, nowIso());
}
