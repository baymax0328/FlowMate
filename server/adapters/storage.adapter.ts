// FlowMate · StorageAdapter（PRD §18：本地磁盘实现，按 UUID 不可变对象键存；下载走短时签名链接且先鉴权）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../core/config';
import { assertInsideDir } from '../core/paths';
import { AppError } from '../core/errors';
import { getDb, nowIso, uuid } from '../core/db';

const SECRET = process.env.FLOWMATE_LINK_SECRET || crypto.randomBytes(32).toString('hex');

export interface StoredObject {
  object_key: string;
  sha256: string;
  size: number;
}

function keyPath(objectKey: string): string {
  const safe = objectKey.replace(/[^a-f0-9-]/g, '');
  return assertInsideDir(config.storageDir, path.join(config.storageDir, safe.slice(0, 2), safe));
}

export const storage = {
  async put(buf: Buffer, _mime?: string): Promise<StoredObject> {
    const key = uuid();
    const p = keyPath(key);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, p); // 原子落盘
    return { object_key: key, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
  },
  async read(objectKey: string): Promise<Buffer> {
    const p = keyPath(objectKey);
    if (!fs.existsSync(p)) throw AppError.notFound('文件内容不存在');
    return fsp.readFile(p);
  },
  exists(objectKey: string): boolean {
    return fs.existsSync(keyPath(objectKey));
  },
  stat(objectKey: string): { size: number } | null {
    const p = keyPath(objectKey);
    if (!fs.existsSync(p)) return null;
    return { size: fs.statSync(p).size };
  },
  pathOf(objectKey: string) {
    return keyPath(objectKey);
  },
  /** 短时签名链接（先鉴权后签发） */
  signedUrl(objectKey: string, ttlSeconds = 300, meta: { userId: string; fileId: string; versionId: string } = { userId: '', fileId: '', versionId: '' }): string {
    const exp = Date.now() + ttlSeconds * 1000;
    const sig = sign(objectKey, exp, meta);
    const qs = new URLSearchParams({ key: objectKey, exp: String(exp), sig, user_id: meta.userId, file_id: meta.fileId, version_id: meta.versionId });
    return `/api/v1/files/download?${qs.toString()}`;
  },
  verify(objectKey: string, exp: number, sig: string, meta: { userId?: string; fileId?: string; versionId?: string }): boolean {
    if (!Number.isFinite(Number(exp)) || Number(exp) < Date.now() || !/^[0-9a-f]{64}$/.test(sig)) return false;
    return crypto.timingSafeEqual(Buffer.from(sign(objectKey, Number(exp), meta as never)), Buffer.from(String(sig)));
  },
  copyInto(objectKey: string, destAbs: string) {
    fs.copyFileSync(keyPath(objectKey), destAbs);
  },
};

function sign(objectKey: string, exp: number, meta: { userId?: string; fileId?: string; versionId?: string }) {
  return crypto.createHmac('sha256', SECRET)
    .update(`${objectKey}|${exp}|${meta.userId ?? ''}|${meta.fileId ?? ''}|${meta.versionId ?? ''}`)
    .digest('hex');
}

/** 备份用：磁盘用量统计 */
export function storageStats() {
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { files++; bytes += fs.statSync(p).size; }
    }
  };
  if (fs.existsSync(config.storageDir)) walk(config.storageDir);
  return { files, bytes, dir: config.storageDir, at: nowIso() };
}

export function dbStats() {
  const d = getDb();
  return {
    path: path.join(config.dataDir, 'flowmate.sqlite3'),
    pages: d.val<number>('PRAGMA page_count') ?? 0,
    freePages: d.val<number>('PRAGMA freelist_count') ?? 0,
  };
}
