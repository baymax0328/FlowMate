// FlowMate · 路径边界与文件名净化（PRD §7.1 / §8.3）
// 服务端对路径做 canonical 解析后校验前缀，不信任任何客户端或模型给的路径。
import path from 'node:path';
import { AppError } from './errors';

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 显示名净化：去路径分隔符、..、控制字符与 Windows 保留名；与存储对象键分离 */
export function sanitizeName(raw: string): string {
  let n = String(raw ?? '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 180);
  if (RESERVED.test(n)) n = `_${n}`;
  if (!n) n = '未命名';
  return n;
}

export function extOf(name: string): string {
  const e = path.extname(name).toLowerCase();
  return e || '';
}

/**
 * 逻辑路径解析（绑定目录根之内）。
 * 返回从根开始的段数组；任何越界（../ 、绝对路径逃逸、符号链接标记）立即拒绝。
 */
export function resolveLogicalPath(p: string): string[] {
  const cleaned = String(p ?? '').replace(/\\/g, '/').trim();
  if (cleaned.includes('\0')) throw AppError.forbidden('路径含非法字符');
  const parts = cleaned.split('/').filter((s) => s.length > 0);
  const out: string[] = [];
  for (const seg of parts) {
    if (seg === '.') continue;
    if (seg === '..') {
      throw AppError.forbidden('路径越界：Agent 只能在会话绑定的工作区内读写（不允许 .. 上跳）');
    }
    if (RESERVED.test(seg)) throw AppError.forbidden(`路径含保留名：${seg}`);
    out.push(seg);
  }
  return out;
}

/** 磁盘对象键边界（StorageAdapter 用） */
export function assertInsideDir(rootDir: string, target: string) {
  const r = path.resolve(rootDir);
  const t = path.resolve(target);
  if (t !== r && !t.startsWith(r + path.sep)) {
    throw AppError.forbidden('存储路径越界');
  }
  return t;
}

/**
 * 目录树循环检查（§17：parent 循环检查）。
 * 把 nodeToMove 挂到 parentId 之下会成环 ⟺ parentId 本身就是 nodeToMove，或位于 nodeToMove 的子树内。
 * 早期实现把方向写反（在 parentId 的子树里找 nodeToMove），那样会放过「把父目录移进自己的子目录」，
 * 一旦写入就会让目录链永远走不到根、面包屑与继承鉴权全部错乱。这里按正确方向实现。
 */
export function wouldCreateCycle(parentId: string | null, nodeToMove: string, childrenOf: (id: string) => string[]): boolean {
  if (!parentId) return false;
  if (parentId === nodeToMove) return true;
  const stack = [nodeToMove];
  const seen = new Set<string>();
  let guard = 0;
  while (stack.length && guard++ < 20000) {
    const cur = stack.pop()!;
    if (cur === parentId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const c of childrenOf(cur)) stack.push(c);
  }
  return false;
}
