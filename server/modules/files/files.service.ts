import path from 'node:path';
// FlowMate · Files 模块（PRD §06 Workspace / §07 类型允许列表 / §17 数据对象 / §19 API 契约 / §20 权限）
// 本文件是全工程的地基：Agent 读文件（fs.list / fs.read / doc.extract / search.content）与任务发现
// 都复用这里的「真实落盘 + 真实落库 + 抽取一次双服务」管道。禁止 mock、禁止假成功。
import { Injectable } from '@nestjs/common';
import {
  appendEvent, getDb, j, nowIso, queueOutbox, sha256, uuid, type Db,
} from '../../core/db';
import { AppError } from '../../core/errors';
import { config, rejected, rulesFor, type TypeRule } from '../../core/config';
import { extOf, resolveLogicalPath, sanitizeName, wouldCreateCycle } from '../../core/paths';
import {
  assertCan, isOrgManager, resolveAcl, userTeams, aclRank, type Actor,
} from '../../core/permissions';
import { storage } from '../../adapters/storage.adapter';
import { scheduler } from '../../core/queue';
import { services, type FileDTO, type FileKind, type FilesService as FilesServiceContract, type TextPayload, type VersionDTO } from '../../core/contracts';

// ============================================================================
// 存储行类型
// ============================================================================
interface FileRow {
  id: string; organization_id: string; space: 'personal' | 'team' | 'org'; folder_id: string | null;
  owner_id: string | null; team_id: string | null; name: string; ext: string; mime: string;
  sniffed_mime: string | null; kind: string; size: number; current_version_id: string | null;
  status: string; trashed_at: string | null; deleted_by: string | null; created_by: string | null;
  revision: number; created_at: string; updated_at: string;
}
interface FolderRow {
  id: string; organization_id: string; space: 'personal' | 'team' | 'org'; owner_id: string | null;
  team_id: string | null; parent_id: string | null; name: string; status: string;
  trashed_at: string | null; created_by: string | null; revision: number; created_at: string; updated_at: string;
  /** 1 = 用户自建的「空间」根；0/undefined = 按成员关系派生的结构根（我的文件 / 团队根 / 组织空间） */
  is_space?: number;
}
interface VersionRow {
  id: string; file_id: string; organization_id: string; version_no: number; object_key: string;
  sha256: string; size: number; mime: string; author_id: string | null; agent_run_id: string | null;
  base_version_id: string | null; change_source: string; summary: string | null; created_at: string;
}
interface TextRow {
  file_version_id: string; status: string; reason: string | null; raw_text: string | null; tokens: string | null;
  char_count: number; unit_count: number; blocks: string; preview_kind: string | null; preview_note: string | null;
  preview_html: string | null; provider: string | null; indexed_at: string | null;
}

// ============================================================================
// 事件（§19 outbox channel 'ws'，payload 最小化）
// ============================================================================
function emitFileEvent(
  opts: {
    type: string; organization_id: string; entity_type: 'file' | 'folder'; entity_id: string;
    revision?: number; actor_id?: string | null; run_id?: string | null; payload?: Record<string, unknown>;
  },
) {
  const e = appendEvent({
    type: opts.type, organization_id: opts.organization_id, entity_type: opts.entity_type,
    entity_id: opts.entity_id, revision: opts.revision, actor_id: opts.actor_id ?? null,
    run_id: opts.run_id ?? null, payload: opts.payload ?? {},
  });
  // user_id = null：按实体订阅广播（内容最小化，不广播正文）
  queueOutbox([{ user_id: null, channel: 'ws', payload: { event_id: e.eventId, seq: e.seq, type: opts.type, entity_type: opts.entity_type, entity_id: opts.entity_id } }], e.seq);
  return e;
}

// ============================================================================
// 目录 ACL（本地实现）
// 说明：core/permissions.resolveAcl 对 folder 资源执行 `SELECT folder_id ... FROM folders`，
// 而 folders 表没有 folder_id 列（只有 parent_id），因此对 folder 的鉴权会直接抛 SQL 错误。
// 这里按与 resolveAcl 完全一致的语义为目录补一份实现；文件仍走 core（files 表列名匹配，可用）。
// 建议主控把本函数下沉为 permissions.folderAcl()，并修正 resolveAcl 的列名。
// ============================================================================
export function folderAcl(actor: Actor, folderId: string): { allow: number; denied: boolean } {
  const d = getDb();
  const chain: string[] = [];
  let cur: string | null = folderId;
  let guard = 0;
  let self: FolderRow | undefined;
  while (cur && guard++ < 64) {
    const f: FolderRow | undefined = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', cur);
    if (!f) break;
    if (!self) self = f;
    chain.push(cur);
    cur = f.parent_id;
  }
  if (!self) return { allow: 0, denied: false };
  const teams = userTeams(actor.userId, actor.orgId);
  let allow = 0;
  let denied = false;
  if (self.space === 'personal' && self.owner_id === actor.userId) allow = aclRank.manager;
  if (actor.role === 'owner' && self.space !== 'personal') allow = Math.max(allow, aclRank.manager);
  for (const id of chain) {
    const rows = d.all<{ permission: string; effect: string }>(
      `SELECT permission, effect FROM acls WHERE resource_type='folder' AND resource_id=?
       AND ((principal_type='user' AND principal_id=?)
         ${teams.length ? `OR (principal_type='team' AND principal_id IN (${teams.map(() => '?').join(',')}))` : ''}
         OR (principal_type='org' AND principal_id=?))`,
      id, actor.userId, ...teams, actor.orgId);
    for (const r of rows) {
      if (r.effect === 'deny') denied = true;
      else if (aclRank[r.permission] > allow) allow = aclRank[r.permission];
    }
  }
  if (denied && self.owner_id !== actor.userId) allow = 0;
  return { allow, denied };
}

export function assertFolderCan(actor: Actor, folderId: string, level: 'viewer' | 'editor' | 'manager', what = '该操作') {
  const r = folderAcl(actor, folderId);
  if (r.allow < aclRank[level]) {
    throw AppError.forbidden(`${what}需要该工作区的 ${level} 权限，当前授权不足`);
  }
  return r;
}

// ============================================================================
// 内容嗅探（§7.1：扩展名 + MIME + 内容嗅探三者以嗅探结果为准）
// ============================================================================
export interface SniffResult { mime: string; label: string }

/** Office 包内的标志性文件名要读 ZIP 中央目录才能得到，第一个文件很大时也不会漏。 */
function zipEntryNames(buf: Buffer): Set<string> {
  for (let end = buf.length - 22; end >= Math.max(0, buf.length - 65557); end--) {
    if (buf.readUInt32LE(end) !== 0x06054b50 || end + 22 + buf.readUInt16LE(end + 20) !== buf.length) continue;
    const offset = buf.readUInt32LE(end + 16);
    const limit = offset + buf.readUInt32LE(end + 12);
    if (limit > end) break;
    const names = new Set<string>();
    for (let pos = offset; pos + 46 <= limit;) {
      if (buf.readUInt32LE(pos) !== 0x02014b50) break;
      const nameEnd = pos + 46 + buf.readUInt16LE(pos + 28);
      const next = nameEnd + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
      if (next > limit) break;
      names.add(buf.toString('utf8', pos + 46, nameEnd));
      pos = next;
    }
    return names;
  }
  return new Set();
}

/** 只看字节特征，不做解析，因此不需要任何额外依赖 */
export function sniffBuffer(buf: Buffer): SniffResult | null {
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05) && (buf[3] === 0x04 || buf[3] === 0x06)) {
    const entries = zipEntryNames(buf);
    if (entries.has('[Content_Types].xml')) {
      if (entries.has('word/document.xml')) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word（OOXML 容器）' };
      if (entries.has('xl/workbook.xml')) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel（OOXML 容器）' };
      if (entries.has('ppt/presentation.xml')) return { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint（OOXML 容器）' };
    }
    if (entries.has('META-INF/container.xml')) return { mime: 'application/epub+zip', label: '电子书压缩包' };
    return { mime: 'application/zip', label: '压缩包（ZIP 容器）' };
  }
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', label: 'PDF' };
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return { mime: 'image/png', label: 'PNG 图片' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', label: 'JPEG 图片' };
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) return { mime: 'image/gif', label: 'GIF 图片' };
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', label: 'WebP 图片' };
  if (buf.length >= 4 && buf.subarray(0, 4).toString('hex') === '4d5a9000') return { mime: 'application/x-msdownload', label: 'Windows 可执行文件' };
  if (buf.length >= 4 && buf[0] === 0x7f && buf.subarray(1, 4).toString('latin1') === 'ELF') return { mime: 'application/x-executable', label: '可执行文件' };
  const head = buf.subarray(0, Math.min(buf.length, 4096)).toString('latin1');
  if (/<\?xml[\s\S]{0,400}?<svg[\s>]/i.test(head)) return { mime: 'image/svg+xml', label: 'SVG（可含脚本）' };
  if (/<!doctype\s+html|<html[\s>]|<body[\s>]|<head[\s>]/i.test(head)) return { mime: 'text/html', label: 'HTML 文档' };
  if (buf.length >= 4 && (buf.subarray(0, 4).toString('hex') === 'd0cf11e0')) return { mime: 'application/x-olecompound', label: '旧版 Office（OLE 复合文档）' };
  // 纯文本判定：控制字符占比极低且可 UTF-8 解码
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  let bad = 0;
  for (const b of sample) if (b < 0x09 || (b > 0x0d && b < 0x20)) bad++;
  if (!sample.length || bad / sample.length < 0.02) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length });
      return { mime: 'text/plain', label: '纯文本' };
    } catch { /* The sample is not UTF-8 text. */ }
  }
  return null;
}

export interface TypeDecision {
  ok: true; kind: FileKind; ext: string; mime: string; rule: TypeRule; sniffed: string | null;
}
export interface TypeRejection {
  ok: false; code: 'UNSUPPORTED_FILE_TYPE' | 'FILE_TOO_LARGE'; status: number; message: string; max_bytes?: number;
}

/** 三源判定：扩展名 + 声明 MIME + 内容嗅探，以嗅探结果为准；无法归类即拒绝（不做幽灵文件通道） */
export function decideType(rawName: string, declaredMime: string | undefined, buf: Buffer): TypeDecision | TypeRejection {
  const name = sanitizeName(rawName);
  const ext = extOf(name);
  const lower = ext.toLowerCase();
  if (rejected.legacy.includes(lower)) {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `旧格式 ${lower} 不支持解析：请在 Office 中另存为 ${lower === '.doc' ? '.docx' : lower === '.xls' ? '.xlsx' : '.pptx'} 后重新上传。` };
  }
  if (rejected.executable.includes(lower)) {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `可执行与脚本类型（${lower}）不在允许列表内，直接拒绝；HTML/SVG 永不作为可信内容在同源渲染执行。` };
  }
  if (rejected.archive.includes(lower)) {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `压缩包（${lower}）首版拒绝：它会让「绑定工作区内检索与 AI 读取」的边界失控。请上传单个文件。` };
  }
  const sniffed = sniffBuffer(buf);
  // 内容嗅探优先：嗅出可执行 / 压缩包 / 旧版 OLE / SVG 一律拒绝
  if (sniffed) {
    if (sniffed.mime === 'application/x-msdownload' || sniffed.mime === 'application/x-executable') {
      return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `内容嗅探结果为${sniffed.label}，属于可执行文件，拒绝上传。` };
    }
    if (sniffed.mime === 'application/zip') {
      return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: '内容嗅探结果为普通压缩包（ZIP），首版拒绝；Office 文件请确认扩展名为 .docx/.xlsx/.pptx。' };
    }
    if (sniffed.mime === 'application/x-olecompound') {
      return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: '内容嗅探结果为旧版 Office OLE 复合文档（.doc/.xls/.ppt），请另存为 .docx/.xlsx/.pptx 后上传。' };
    }
    if (sniffed.mime === 'image/svg+xml') {
      return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: 'SVG 可携带脚本，不允许进入工作区（同源永不渲染执行）。请转成 PNG/WebP 后上传。' };
    }
  } else {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `无法归类的内容类型（${name}）：扩展名、声明 MIME 与内容嗅探三者都无法确定类型，按允许列表拒绝，不做「仅存储不可预览」的模糊通道。` };
  }

  let rule = rulesFor(lower);
  let kind = rule?.kind;
  // 扩展名不可用或与嗅探冲突 → 以嗅探结果为准
  const sniffRule = config.types.find((t) => t.mimes.includes(sniffed.mime));
  if (!rule) {
    if (!sniffRule) return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `扩展名 ${lower || '(无)'} 不在允许列表内，且内容嗅探结果（${sniffed.label}）也无对应能力，已拒绝。` };
    rule = sniffRule;
    kind = sniffRule.kind;
    const useExt = sniffRule.exts.includes(lower) ? lower : sniffRule.exts[0];
    return finish(kind, useExt, sniffRule, sniffed, buf, name);
  }
  if (rule.kind !== 'text' && rule.kind !== 'markdown' && sniffRule && sniffRule !== rule && sniffRule.kind !== rule.kind) {
    // 例如 .txt 实际是 PDF：按嗅探结果重新归类
    if (sniffRule.kind !== 'text' && sniffed.mime !== 'text/plain') {
      const useExt = sniffRule.exts.includes(lower) ? lower : sniffRule.exts[0];
      return finish(sniffRule.kind, useExt, sniffRule, sniffed, buf, name);
    }
  }
  if (!rule.mimes.includes(sniffed.mime) && sniffed.mime !== 'text/plain' && sniffed.mime !== 'text/html') {
    // 伪装扩展名（例如 .md 实为 PNG）→ 按真实内容归类
    if (sniffRule) {
      const useExt = sniffRule.exts.includes(lower) ? lower : sniffRule.exts[0];
      return finish(sniffRule.kind, useExt, sniffRule, sniffed, buf, name);
    }
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `扩展名 ${lower} 与内容不符（嗅探结果：${sniffed.label}），按嗅探结果无法归类，已拒绝。` };
  }
  const textual = rule.kind === 'markdown' || rule.kind === 'text' || rule.kind === 'html' || lower === '.csv';
  if (!textual && !rule.mimes.includes(sniffed.mime)) {
    return { ok: false, code: 'UNSUPPORTED_FILE_TYPE', status: 415, message: `扩展名 ${lower} 与文件内容不符（${sniffed.label}）。` };
  }
  return finish(kind!, lower, rule, sniffed, buf, name);

  function finish(k: FileKind, useExt: string, r: TypeRule, sn: SniffResult, b: Buffer, displayName: string): TypeDecision | TypeRejection {
    if (b.length > r.maxBytes) {
      return {
        ok: false, code: 'FILE_TOO_LARGE', status: 413, max_bytes: r.maxBytes,
        message: `${displayName} 超过 ${r.kind} 类型的单文件上限 ${Math.round(r.maxBytes / 1024 / 1024)} MB（当前 ${(b.length / 1024 / 1024).toFixed(1)} MB）。`,
      };
    }
    const mime = useExt === '.csv' ? 'text/csv' : r.mimes.includes(sn.mime) ? sn.mime : r.mimes[0];
    return { ok: true, kind: k, ext: useExt, mime, rule: r, sniffed: sn.mime };
  }
}

/** Agent 草稿占位名：直接找一个没被占用的名字（两个执行槽可能同时创建同名草稿） */
export function uniqueDraftName(d: Db, folderId: string | null, name: string): string {
  const taken = new Set(d.all<{ name: string }>(
    "SELECT name FROM files WHERE folder_id IS ? AND status='active'", folderId).map((r) => r.name));
  const extMatch = /\.[A-Za-z0-9]+$/.exec(name);
  const ext = extMatch ? extMatch[0] : '';
  const base = ext ? name.slice(0, -ext.length) : name;
  const stamp = Date.now().toString(36).slice(-4);
  for (const cand of [`${base}-r${stamp}${ext}`, `${base} (${stamp})${ext}`, `${base}-${Math.random().toString(36).slice(2, 7)}${ext}`]) {
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 重名时的建议名（不静默覆盖） */
export function suggestName(d: Db, folderId: string | null, name: string): string {
  const taken = new Set(d.all<{ name: string }>(
    "SELECT name FROM files WHERE folder_id IS ? AND status='active'", folderId).map((r) => r.name));
  const base = name.replace(/(\.[A-Za-z0-9]+)?$/, '');
  const extMatch = /\.[A-Za-z0-9]+$/.exec(name);
  const ext = extMatch ? extMatch[0] : '';
  for (let i = 1; i <= 200; i++) {
    const cand = `${base} (${i})${ext}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}-${Date.now()}${ext}`;
}

// ============================================================================
// FilesService
// ============================================================================
@Injectable()
export class FilesService implements FilesServiceContract {
  onModuleInit() {
    services.files = this;
  }

  private d(): Db { return getDb(); }

  // ---------------- 空间根目录 ----------------
  private ensurePersonalRoot(actor: Actor): FolderRow {
    const d = this.d();
    // ifnull(is_space,0)=0 必须带着：否则用户新建一个同级 personal 空间根后，
    // 这条「无父目录的 personal 根」查询会不确定地命中自建空间，「我的文件」跟着漂，上传与 Agent 绑定都错位。
    const found = d.get<FolderRow>(
      "SELECT * FROM folders WHERE space='personal' AND owner_id=? AND parent_id IS NULL AND ifnull(is_space,0)=0", actor.userId);
    if (found) return found;
    const id = uuid();
    const t = nowIso();
    d.run(`INSERT INTO folders(id,organization_id,space,owner_id,team_id,parent_id,name,status,created_by,revision,created_at,updated_at)
      VALUES(?,?,'personal',?,NULL,NULL,'我的文件','active',?,1,?,?)`, id, actor.orgId, actor.userId, actor.userId, t, t);
    return d.get<FolderRow>('SELECT * FROM folders WHERE id=?', id)!;
  }

  /** 幂等确保三类空间根存在（团队根按用户所属团队逐个创建） */
  ensureSpaceRoots(actor: Actor) {
    const d = this.d();
    const personal = this.ensurePersonalRoot(actor);
    let orgRoot = d.get<FolderRow>("SELECT * FROM folders WHERE space='org' AND organization_id=? AND parent_id IS NULL", actor.orgId);
    if (!orgRoot) {
      const id = uuid();
      const t = nowIso();
      d.run(`INSERT INTO folders(id,organization_id,space,owner_id,team_id,parent_id,name,status,created_by,revision,created_at,updated_at)
        VALUES(?,?,'org',NULL,NULL,NULL,'组织空间','active',?,1,?,?)`, id, actor.orgId, actor.userId, t, t);
      orgRoot = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', id)!;
      // 全组织可读；组织管理员可管理
      this.grantRaw('folder', orgRoot.id, 'org', actor.orgId, 'viewer', 'allow', actor);
      if (isOrgManager(actor)) this.grantRaw('folder', orgRoot.id, 'user', actor.userId, 'manager', 'allow', actor);
    }
    const teamRoots: FolderRow[] = [];
    for (const teamId of userTeams(actor.userId, actor.orgId)) {
      let tr = d.get<FolderRow>("SELECT * FROM folders WHERE space='team' AND team_id=? AND parent_id IS NULL", teamId);
      if (!tr) {
        const team = d.get<{ name: string }>('SELECT name FROM teams WHERE id=?', teamId);
        const id = uuid();
        const t = nowIso();
        d.run(`INSERT INTO folders(id,organization_id,space,owner_id,team_id,parent_id,name,status,created_by,revision,created_at,updated_at)
          VALUES(?,?,'team',NULL,?,NULL,?,'active',?,1,?,?)`, id, actor.orgId, teamId, sanitizeName(team?.name ?? '团队空间'), actor.userId, t, t);
        tr = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', id)!;
        // 团队成员默认编辑权（个人上传的私有子目录可在其内收紧）
        this.grantRaw('folder', tr.id, 'team', teamId, 'editor', 'allow', actor);
      }
      teamRoots.push(tr);
    }
    return { personal, org: orgRoot, teamRoots };
  }

  async spaceRoots(actor: Actor): Promise<{ id: string | null; name: string; space: string; team_id?: string | null; deletable?: boolean; created_at?: string | null }[]> {
    const { personal, org, teamRoots } = this.ensureSpaceRoots(actor);
    const out: { id: string | null; name: string; space: string; team_id?: string | null; deletable?: boolean; created_at?: string | null }[] = [
      // 每个空间根带上 created_at：前端可显示建空间时间，回归脚本要靠它区分「出厂演示数据」与
      // 「用户/探针后来建的」，否则用户自己建一个空文件夹就会被判成演示数据留了空壳。
      { id: personal.id, name: '我的文件', space: 'personal', team_id: null, deletable: false, created_at: personal.created_at },
    ];
    for (const t of teamRoots) out.push({ id: t.id, name: t.name, space: 'team', team_id: t.team_id, deletable: false, created_at: t.created_at });
    out.push({ id: org.id, name: '组织空间', space: 'org', team_id: null, deletable: false, created_at: org.created_at });
    // 用户自建的空间根（可删）；派生根不可删 —— 它们随组织/团队成员关系自动生成，删了下次进来又会长回来
    for (const f of this.userSpaces(actor)) out.push({ id: f.id, name: f.name, space: 'personal', team_id: null, deletable: true, created_at: f.created_at });
    out.push({ id: null, name: '最近', space: 'recent' });
    out.push({ id: null, name: '回收站', space: 'trash' });
    return out;
  }

  /** 自建空间根：无父目录 + is_space=1，按可见性过滤 */
  private userSpaces(actor: Actor): FolderRow[] {
    return this.d().all<FolderRow>(
      `SELECT * FROM folders WHERE organization_id=? AND parent_id IS NULL AND ifnull(is_space,0)=1 AND status='active' ORDER BY created_at`,
      actor.orgId).filter((f) => folderAcl(actor, f.id).allow >= aclRank.viewer);
  }

  /** 新建一个属于自己的空间（同级于「我的文件」的独立根，不与团队/组织空间混权限） */
  async createSpace(actor: Actor, input: { name: string }): Promise<FileDTO> {
    this.ensureSpaceRoots(actor);
    const name = sanitizeName(input.name);
    if (!name || name === '未命名') throw AppError.validation('空间名不能为空');
    const d = this.d();
    const dup = d.get<FolderRow>(
      `SELECT * FROM folders WHERE parent_id IS NULL AND ifnull(is_space,0)=1 AND owner_id=? AND name=? AND status='active'`,
      actor.userId, name);
    if (dup) throw AppError.validation(`你已经有一个同名空间「${name}」，换个名字`);
    const id = uuid(); const t = nowIso();
    d.tx(() => {
      d.run(`INSERT INTO folders(id,organization_id,space,owner_id,team_id,parent_id,name,status,is_space,created_by,revision,created_at,updated_at)
             VALUES(?,?, 'personal', ?,NULL,NULL,?, 'active',1,?,1,?,?)`,
      id, actor.orgId, actor.userId, name, actor.userId, t, t);
      emitFileEvent({ type: 'folder.created', organization_id: actor.orgId, entity_type: 'folder', entity_id: id, actor_id: actor.userId, payload: { folder_id: id, name, space: 'personal', is_space: 1 } });
    });
    return this.folderDto(actor, d.get<FolderRow>('SELECT * FROM folders WHERE id=?', id)!);
  }

  /** 删除自建空间：进回收站（可恢复），派生根与会被会话绑定的根都不允许直接删 */
  async deleteSpace(actor: Actor, input: { id: string }): Promise<Record<string, unknown>> {
    const d = this.d();
    const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
    if (!f || f.organization_id !== actor.orgId) throw AppError.notFound('空间不存在或不可见');
    if (f.parent_id || !Number(f.is_space ?? 0)) {
      throw AppError.validation('「我的文件 / 团队空间 / 组织空间」按成员关系自动生成，不能在这里删除；要清理请删里面的文件夹和文件（回收站可恢复）');
    }
    // 绑定中的会话会被剪断引用：先拒绝并列出来源，让用户先改绑，而不是留下指向已回收目录的会话
    const bound = d.all<{ id: string; title: string }>(
      `SELECT id, title FROM agent_sessions WHERE folder_id=? AND status='active'`, f.id);
    if (bound.length) {
      throw AppError.busy(
        `这个空间还被 ${bound.length} 个会话绑定（${bound.slice(0, 3).map((b) => b.title).join('、')}${bound.length > 3 ? ' 等' : ''}）。先在会话里改绑其他工作区或解绑，再删空间。`,
        { session_ids: bound.map((b) => b.id) });
    }
    assertFolderCan(actor, f.id, 'manager', '删除空间');
    const r = await this.trash(actor, { kind: 'folder', id: f.id });
    return { ...(r as unknown as Record<string, unknown>), name: f.name, restorable: true, note: '空间及其中的文件夹与文件已进回收站，可在「回收站」恢复' };
  }

  // ---------------- ACL 工具 ----------------
  private grantRaw(
    resourceType: 'folder' | 'file', resourceId: string,
    principalType: 'user' | 'team' | 'org', principalId: string,
    permission: 'viewer' | 'editor' | 'manager', effect: 'allow' | 'deny', actor: Actor,
  ) {
    this.d().run(
      `INSERT INTO acls(id,organization_id,resource_type,resource_id,principal_type,principal_id,permission,effect,created_by,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(resource_type,resource_id,principal_type,principal_id,permission,effect) DO NOTHING`,
      uuid(), actor.orgId, resourceType, resourceId, principalType, principalId, permission, effect, actor.userId, nowIso());
  }

  private fileSpaceOf(folder: FolderRow | undefined, actor: Actor): { space: 'personal' | 'team' | 'org'; owner_id: string; team_id: string | null } {
    if (!folder) return { space: 'personal', owner_id: actor.userId, team_id: null };
    return { space: folder.space, owner_id: folder.owner_id ?? actor.userId, team_id: folder.team_id };
  }

  // ---------------- 读取 / 映射 ----------------
  private textStatusOf(versionId: string | null): { status: string | null; reason: string | null } {
    if (!versionId) return { status: null, reason: null };
    const r = this.d().get<{ status: string; reason: string | null }>('SELECT status, reason FROM file_text WHERE file_version_id=?', versionId);
    return { status: r?.status ?? null, reason: r?.reason ?? null };
  }

  private permFor(actor: Actor, kind: 'file' | 'folder', id: string): 'viewer' | 'editor' | 'manager' | null {
    const allow = kind === 'folder' ? folderAcl(actor, id).allow : resolveAcl(actor, 'file', id).allow;
    if (allow >= aclRank.manager) return 'manager';
    if (allow >= aclRank.editor) return 'editor';
    if (allow >= aclRank.viewer) return 'viewer';
    return null;
  }

  private versionDto(v: VersionRow | undefined): VersionDTO | null {
    if (!v) return null;
    return {
      id: v.id, file_id: v.file_id, version_no: v.version_no, size: v.size, mime: v.mime, sha256: v.sha256,
      author_id: v.author_id, agent_run_id: v.agent_run_id, base_version_id: v.base_version_id,
      change_source: v.change_source, summary: v.summary, created_at: v.created_at, object_key: v.object_key,
    };
  }

  private fileDto(actor: Actor, row: FileRow): FileDTO {
    const v = row.current_version_id ? this.d().get<VersionRow>('SELECT * FROM file_versions WHERE id=?', row.current_version_id) : undefined;
    const ts = this.textStatusOf(row.current_version_id);
    return {
      id: row.id, name: row.name, ext: row.ext, mime: row.mime, kind: row.kind as FileKind, size: row.size,
      folder_id: row.folder_id, space: row.space, owner_id: row.owner_id, team_id: row.team_id,
      current_version_id: row.current_version_id, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at,
      text_status: ts.status as FileDTO['text_status'], text_reason: ts.reason,
      my_permission: this.permFor(actor, 'file', row.id), current_version: this.versionDto(v),
    };
  }

  private folderDto(actor: Actor, row: FolderRow): FileDTO {
    const files = this.d().get<{ n: number }>('SELECT COUNT(*) AS n FROM files WHERE folder_id=? AND status=\'active\'', row.id);
    return {
      id: row.id, name: row.name, ext: '', mime: 'inode/directory', kind: 'text', size: 0,
      folder_id: row.parent_id, space: row.space, owner_id: row.owner_id, team_id: row.team_id,
      current_version_id: null, revision: row.revision, created_at: row.created_at, updated_at: row.updated_at,
      my_permission: this.permFor(actor, 'folder', row.id), current_version: null,
      text_status: null, text_reason: `${files?.n ?? 0} 个条目`,
    };
  }

  /** 目录链（含自身），自顶向下；越权或不存在返回空数组 */
  folderChainTopDown(folderId: string | null): FolderRow[] {
    const d = this.d();
    const out: FolderRow[] = [];
    let cur = folderId;
    let guard = 0;
    while (cur && guard++ < 64) {
      const f: FolderRow | undefined = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', cur);
      if (!f) break;
      out.unshift(f);
      cur = f.parent_id;
    }
    return out;
  }

  pathOf(folderId: string | null): { id: string; name: string }[] {
    return this.folderChainTopDown(folderId).map((f) => ({ id: f.id, name: f.name }));
  }

  /** 目录路径字符串（检索结果展示用）；personal 空间对无权者不拼路径 */
  pathText(folderId: string | null): string {
    const chain = this.folderChainTopDown(folderId);
    return chain.length ? '/' + chain.map((f) => f.name).join('/') : '/';
  }

  private fileRowOr404(id: string): FileRow {
    const row = this.d().get<FileRow>('SELECT * FROM files WHERE id=?', id);
    if (!row) throw AppError.notFound();
    return row;
  }

  /** 可见性判定：不在本组织或链上有回收目录 → 404（不泄漏标题） */
  private assertVisible(row: FileRow, actor: Actor) {
    if (row.organization_id !== actor.orgId) throw AppError.notFound();
    if (row.status !== 'active' && row.status !== 'trashed') throw AppError.notFound();
  }

  private assertFolderChainActive(folderId: string | null): void {
    if (!folderId) return;
    for (const f of this.folderChainTopDown(folderId)) {
      if (f.status !== 'active') throw AppError.notFound('所在文件夹已移入回收站');
    }
  }

  /** 取文件并鉴权（无权 → 404，不泄漏存在性） */
  async getFile(actor: Actor, file_id: string, opts?: { require?: 'viewer' | 'editor' | 'manager' }): Promise<FileDTO> {
    const row = this.fileRowOr404(file_id);
    this.assertVisible(row, actor);
    const level = opts?.require ?? 'viewer';
    if (row.status === 'trashed' && level === 'viewer' && !canSeeTrashed(actor, row)) throw AppError.notFound();
    assertCan(actor, 'file', row.id, level, row.status === 'trashed' ? '回收站操作' : '该操作');
    if (row.status === 'active') this.assertFolderChainActive(row.folder_id);
    this.bumpRecent(actor, row.id);
    return this.fileDto(actor, row);
  }

  /** 内部使用：不做「最近」埋点 */
  peekFile(actor: Actor, file_id: string): FileDTO {
    const row = this.fileRowOr404(file_id);
    this.assertVisible(row, actor);
    return this.fileDto(actor, row);
  }

  private bumpRecent(actor: Actor, fileId: string) {
    try {
      this.d().run(
        `INSERT INTO recent_file_views(user_id,organization_id,file_id,last_viewed_at) VALUES(?,?,?,?)
         ON CONFLICT(user_id,file_id) DO UPDATE SET last_viewed_at=excluded.last_viewed_at`,
        actor.userId, actor.orgId, fileId, nowIso());
    } catch { /* 最近视图是附加信息，不影响主流程 */ }
  }

  // ---------------- 目录列表 ----------------
  async listChildren(actor: Actor, folder_id: string | null): Promise<{ folders: FileDTO[]; files: FileDTO[]; path: { id: string; name: string }[] }> {
    const d = this.d();
    let target = folder_id;
    if (!target) target = this.ensurePersonalRoot(actor).id;
    const folder = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', target);
    if (!folder || folder.organization_id !== actor.orgId) throw AppError.notFound('文件夹不存在或不可见');
    if (folder.status !== 'active') throw AppError.notFound('文件夹已移入回收站');
    assertFolderCan(actor, folder.id, 'viewer', '浏览文件夹');
    const folders = d.all<FolderRow>(
      `SELECT * FROM folders WHERE parent_id=? AND organization_id=? AND status='active' ORDER BY name COLLATE NOCASE`, folder.id, actor.orgId)
      .filter((f) => folderAcl(actor, f.id).allow >= aclRank.viewer)
      .map((f) => this.folderDto(actor, f));
    const files = d.all<FileRow>(
      `SELECT * FROM files WHERE folder_id=? AND organization_id=? AND status='active' ORDER BY updated_at DESC`, folder.id, actor.orgId)
      .filter((f) => resolveAcl(actor, 'file', f.id).allow >= aclRank.viewer)
      .map((f) => this.fileDto(actor, f));
    return { folders, files, path: this.pathText2(folder.id) };
  }

  private pathText2(folderId: string): { id: string; name: string }[] {
    return this.folderChainTopDown(folderId).map((f) => ({ id: f.id, name: f.name }));
  }

  async recent(actor: Actor, limit = 50): Promise<FileDTO[]> {
    const rows = this.d().all<{ file_id: string }>(
      `SELECT file_id FROM recent_file_views WHERE user_id=? AND organization_id=?
       ORDER BY last_viewed_at DESC LIMIT ?`, actor.userId, actor.orgId, limit * 3);
    const out: FileDTO[] = [];
    for (const r of rows) {
      const f = this.d().get<FileRow>('SELECT * FROM files WHERE id=? AND status=\'active\'', r.file_id);
      if (!f || f.organization_id !== actor.orgId) continue;
      if (resolveAcl(actor, 'file', f.id).allow < aclRank.viewer) continue;
      try { this.assertFolderChainActive(f.folder_id); } catch { continue; }
      out.push(this.fileDto(actor, f));
      if (out.length >= limit) break;
    }
    return out;
  }

  async trashList(actor: Actor): Promise<{ folders: FileDTO[]; files: FileDTO[]; notes: string[] }> {
    const d = this.d();
    const files = d.all<FileRow>(
      `SELECT * FROM files WHERE organization_id=? AND status='trashed' AND space IN ('personal','team','org') ORDER BY trashed_at DESC LIMIT 200`, actor.orgId)
      .filter((f) => (f.space === 'personal' ? f.owner_id === actor.userId : resolveAcl(actor, 'file', f.id).allow >= aclRank.editor || f.created_by === actor.userId));
    const folders = d.all<FolderRow>(
      `SELECT * FROM folders WHERE organization_id=? AND status='trashed' AND permanently_deleted_at IS NULL ORDER BY trashed_at DESC LIMIT 200`, actor.orgId)
      .filter((f) => (f.space === 'personal' ? f.owner_id === actor.userId : folderAcl(actor, f.id).allow >= aclRank.editor || f.created_by === actor.userId));
    return {
      files: files.map((f) => this.fileDto(actor, f)),
      folders: folders.map((f) => this.folderDto(actor, f)),
      notes: ['恢复后回到原目录，若原文件夹已回收，将回到「最近」空间中'],
    };
  }

  // ---------------- 目录创建 / 重命名 ----------------
  async createFolder(actor: Actor, input: { parent_id: string | null; name: string; space?: 'personal' | 'team' | 'org'; team_id?: string | null }): Promise<FileDTO> {
    const d = this.d();
    this.ensureSpaceRoots(actor);
    let parent = input.parent_id ?? null;
    if (!parent) {
      if (input.space === 'team' && input.team_id) {
        parent = d.get<FolderRow>("SELECT * FROM folders WHERE space='team' AND team_id=? AND parent_id IS NULL", input.team_id)?.id ?? this.ensurePersonalRoot(actor).id;
      } else if (input.space === 'org') {
        parent = d.get<FolderRow>("SELECT * FROM folders WHERE space='org' AND organization_id=? AND parent_id IS NULL", actor.orgId)?.id ?? this.ensurePersonalRoot(actor).id;
      } else parent = this.ensurePersonalRoot(actor).id;
    }
    const parentRow = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', parent);
    if (!parentRow || parentRow.organization_id !== actor.orgId) throw AppError.notFound('上级文件夹不存在或不可见');
    if (parentRow.status !== 'active') throw AppError.notFound('上级文件夹已回收');
    assertFolderCan(actor, parentRow.id, 'editor', '新建文件夹');
    const name = sanitizeName(input.name);
    const dup = d.get<FolderRow>("SELECT * FROM folders WHERE parent_id IS ? AND name=? AND status='active'", parentRow.id, name);
    if (dup) {
      throw new AppError('VALIDATION', `同一位置已有同名文件夹「${name}」，未做覆盖`, 400, { name: `建议改为「${this.suggestFolderName(parentRow.id, name)}」` },
        { suggested_name: this.suggestFolderName(parentRow.id, name) });
    }
    const id = uuid();
    const t = nowIso();
    d.tx(() => {
      d.run(`INSERT INTO folders(id,organization_id,space,owner_id,team_id,parent_id,name,status,created_by,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'active',?,1,?,?)`,
      id, actor.orgId, parentRow.space, parentRow.owner_id, parentRow.team_id, parentRow.id, name, actor.userId, t, t);
      emitFileEvent({ type: 'folder.created', organization_id: actor.orgId, entity_type: 'folder', entity_id: id, actor_id: actor.userId, payload: { folder_id: id, name, parent_id: parentRow.id } });
    });
    const row = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', id)!;
    return this.folderDto(actor, row);
  }

  private suggestFolderName(parentId: string, name: string): string {
    const taken = new Set(this.d().all<{ name: string }>("SELECT name FROM folders WHERE parent_id=? AND status='active'", parentId).map((r) => r.name));
    for (let i = 1; i <= 200; i++) {
      const cand = `${name} (${i})`;
      if (!taken.has(cand)) return cand;
    }
    return `${name}-${Date.now()}`;
  }

  async rename(actor: Actor, input: { kind: 'folder' | 'file'; id: string; name: string }): Promise<void> {
    const d = this.d();
    const name = sanitizeName(input.name);
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
      if (!f || f.organization_id !== actor.orgId || f.status !== 'active') throw AppError.notFound('文件夹不存在或不可见');
      assertFolderCan(actor, f.id, 'editor', '重命名文件夹');
      const dup = d.get("SELECT id FROM folders WHERE parent_id IS ? AND name=? AND id<>? AND status='active'", f.parent_id, name, f.id);
      if (dup) throw new AppError('VALIDATION', `同一位置已有同名文件夹「${name}」`, 400, { name: `建议改为「${this.suggestFolderName(f.parent_id ?? '', name)}」` });
      d.run("UPDATE folders SET name=?, revision=revision+1, updated_at=? WHERE id=?", name, nowIso(), f.id);
      emitFileEvent({ type: 'folder.updated', organization_id: actor.orgId, entity_type: 'folder', entity_id: f.id, actor_id: actor.userId, payload: { name } });
      return;
    }
    const row = this.fileRowOr404(input.id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'editor', '重命名文件');
    const dup = d.get("SELECT id FROM files WHERE folder_id IS ? AND name=? AND id<>? AND status='active'", row.folder_id, name, row.id);
    if (dup) {
      const suggested = suggestName(d, row.folder_id, name);
      throw new AppError('VALIDATION', `同一文件夹内已有同名文件「${name}」，未做覆盖`, 400, { name: `建议改为「${suggested}」` }, { suggested_name: suggested });
    }
    const ext = extOf(name) || row.ext;
    d.run("UPDATE files SET name=?, ext=?, revision=revision+1, updated_at=? WHERE id=?", name, ext, nowIso(), row.id);
    emitFileEvent({ type: 'file.updated', organization_id: actor.orgId, entity_type: 'file', entity_id: row.id, actor_id: actor.userId, payload: { name } });
  }

  // ---------------- 上传 / 版本 ----------------
  /** 单文件创建（幂等：同目录同名同哈希直接返回既有对象，不产生第二条数据） */
  async createFile(actor: Actor, input: {
    folder_id: string | null; name: string; buffer: Buffer; mime?: string;
    change_source?: 'upload' | 'user_edit' | 'restore' | 'agent_draft' | 'agent_formal' | 'seed';
    author_id?: string; run_id?: string | null; summary?: string; skipExtract?: boolean;
  }): Promise<{ file: FileDTO; version: VersionDTO }> {
    const d = this.d();
    this.ensureSpaceRoots(actor);
    const targetFolderId = input.folder_id ?? this.ensurePersonalRoot(actor).id;
    const folder = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', targetFolderId);
    if (!folder || folder.organization_id !== actor.orgId || folder.status !== 'active') throw AppError.notFound('目标文件夹不存在或不可见');
    assertFolderCan(actor, folder.id, 'editor', '上传文件');
    this.assertFolderChainActive(folder.id);

    const decision = decideType(input.name, input.mime, input.buffer);
    if (!decision.ok) throw new AppError(decision.code, decision.message, decision.status, undefined, decision.max_bytes ? { max_bytes: decision.max_bytes } : undefined);
    const name = sanitizeName(input.name);
    const hash = sha256(input.buffer);
    const existing = d.get<FileRow>(
      `SELECT f.* FROM files f JOIN file_versions v ON v.id=f.current_version_id
       WHERE f.folder_id IS ? AND f.name=? AND f.status='active' AND v.sha256=?`, folder.id, name, hash);
    if (existing) {
      const v = d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', existing.current_version_id)!;
      return { file: this.fileDto(actor, existing), version: this.versionDto(v)! };
    }
    let finalName = name;
    const taken = !!d.get("SELECT id FROM files WHERE folder_id IS ? AND name=? AND status='active'", folder.id, name);
    const agentSource = String(input.change_source ?? 'upload').startsWith('agent');
    if (taken) {
      if (agentSource) {
        // Agent 草稿：同一目录会反复产出同名草稿，且两个执行槽可能同时创建。
        // 这里直接占一个空位名字（含唯一性重试），早先只靠一次检查会在并发下撞 UNIQUE 约束，
        // 使 formal_change 子任务失败、共同确认提案根本生成不出来。
        finalName = uniqueDraftName(d, folder.id, name);
      } else {
        throw new AppError('VALIDATION', `同一文件夹内已有同名文件「${name}」，未做覆盖`, 400, { name: `建议改为「${suggestName(d, folder.id, name)}」` }, { suggested_name: suggestName(d, folder.id, name) });
      }
    } else if (agentSource) {
      finalName = name;
    }

    const stored = await storage.put(input.buffer, decision.mime);
    const space = this.fileSpaceOf(folder, actor);
    const fileId = uuid();
    const versionId = uuid();
    const t = nowIso();
    d.tx(() => {
      // files.current_version_id 外键指向 file_versions.id，而版本行此时还不存在：
      // 必须先以 NULL 建文件行 → 建版本 → 再回填 current_version_id，否则外键约束直接失败。
      d.run(`INSERT INTO files(id,organization_id,space,folder_id,owner_id,team_id,name,ext,mime,sniffed_mime,kind,size,current_version_id,status,created_by,revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,1,?,?)`,
      fileId, actor.orgId, space.space, folder.id, space.owner_id, space.team_id, finalName, decision.ext, decision.mime, decision.sniffed, decision.kind, stored.size, null, actor.userId, t, t);
      d.run(`INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,author_id,agent_run_id,base_version_id,change_source,summary,created_at)
        VALUES(?,?,?,1,?,?,?,?,?,?,?,?,?,?)`,
      versionId, fileId, actor.orgId, stored.object_key, stored.sha256, stored.size, decision.mime,
      input.author_id ?? actor.userId, input.run_id ?? null, null, input.change_source ?? 'upload', input.summary ?? '首次上传' , t);
      d.run('UPDATE files SET current_version_id=? WHERE id=?', versionId, fileId);
      if (decision.rule.extract) {
        d.run(`INSERT INTO file_text(file_version_id,status,reason,raw_text,tokens,char_count,unit_count,blocks,created_at,updated_at)
          VALUES(?,'pending',NULL,'',NULL,0,0,'[]',?,?)`, versionId, t, t);
      } else {
        d.run(`INSERT INTO file_text(file_version_id,status,reason,raw_text,tokens,char_count,unit_count,blocks,preview_kind,preview_note,provider,created_at,updated_at)
          VALUES(?,'unavailable',?,'',NULL,0,0,'[]',?,?,?, ?,?)`,
        versionId, '图片不适用正文抽取；可作为 Agent 视觉输入（需模型具备视觉能力）。', 'image', '直接展示，可点开大图', 'flowmate-extraction/0.2（未执行抽取）', t, t);
      }
      emitFileEvent({
        type: 'file.version.created', organization_id: actor.orgId, entity_type: 'file', entity_id: fileId,
        revision: 1, actor_id: input.author_id ?? actor.userId, run_id: input.run_id ?? null,
        payload: { file_id: fileId, version_id: versionId, version_no: 1, name: finalName, change_source: input.change_source ?? 'upload', size: stored.size },
      });
    });
    if (decision.rule.extract && !input.skipExtract) await this.queueExtraction(versionId);
    const file = this.fileDto(actor, this.fileRowOr404(fileId));
    const version = this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId))!;
    return { file, version };
  }

  async addVersion(actor: Actor, input: {
    file_id: string; buffer: Buffer; base_version_id?: string | null;
    change_source: 'user_edit' | 'restore' | 'agent_draft' | 'agent_formal' | 'upload';
    author_id?: string; run_id?: string | null; summary?: string;
  }): Promise<VersionDTO> {
    const d = this.d();
    const row = this.fileRowOr404(input.file_id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'editor', '保存新版本');
    if (row.status !== 'active') throw AppError.notFound('文件已回收，不能写入版本');
    if (input.base_version_id && input.base_version_id !== row.current_version_id) {
      throw AppError.versionConflict(this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', row.current_version_id)));
    }
    const decision = decideType(input.base_version_id ? row.name : row.name, row.mime, input.buffer);
    const mime = decision.ok ? decision.mime : row.mime;
    const stored = await storage.put(input.buffer, mime);
    return this.writeVersion(actor, {
      row, buffer: input.buffer, stored, mime,
      change_source: input.change_source, author_id: input.author_id ?? actor.userId,
      run_id: input.run_id ?? null, summary: input.summary ?? null,
      reextract: decision.ok ? decision.rule.extract : true,
    });
  }

  private writeVersion(actor: Actor, input: {
    row: FileRow; buffer: Buffer; stored: { object_key: string; sha256: string; size: number }; mime: string;
    change_source: string; author_id: string; run_id: string | null; summary: string | null; reextract: boolean;
  }): VersionDTO {
    const d = this.d();
    const base = input.row.current_version_id;
    const versionId = uuid();
    const t = nowIso();
    d.tx(() => {
      const current = d.get<FileRow>('SELECT * FROM files WHERE id=?', input.row.id);
      if (!current) throw AppError.notFound();
      if ((current.current_version_id ?? null) !== (base ?? null)) throw AppError.versionConflict(this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', current.current_version_id)));
      const nextNo = (d.val<number>('SELECT COALESCE(MAX(version_no),0) FROM file_versions WHERE file_id=?', input.row.id) ?? 0) + 1;
      d.run(`INSERT INTO file_versions(id,file_id,organization_id,version_no,object_key,sha256,size,mime,author_id,agent_run_id,base_version_id,change_source,summary,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      versionId, input.row.id, input.row.organization_id, nextNo, input.stored.object_key, input.stored.sha256, input.stored.size,
      input.mime, input.author_id, input.run_id, base, input.change_source, input.summary, t);
      d.run('UPDATE files SET current_version_id=?, size=?, mime=?, revision=revision+1, updated_at=? WHERE id=?',
        versionId, input.stored.size, input.mime, t, input.row.id);
      if (input.reextract) {
        d.run(`INSERT INTO file_text(file_version_id,status,reason,raw_text,tokens,char_count,unit_count,blocks,created_at,updated_at)
          VALUES(?,'pending',NULL,'',NULL,0,0,'[]',?,?)`, versionId, t, t);
      } else {
        d.run(`INSERT INTO file_text(file_version_id,status,reason,raw_text,tokens,char_count,unit_count,blocks,preview_kind,preview_note,provider,created_at,updated_at)
          VALUES(?,'unavailable',?,'',NULL,0,0,'[]',?,?,?, ?,?)`,
        versionId, '图片不适用正文抽取；可作为 Agent 视觉输入（需模型具备视觉能力）。', 'image', '直接展示，可点开大图', 'flowmate-extraction/0.2（未执行抽取）', t, t);
      }
      const newRevision = d.val<number>('SELECT revision FROM files WHERE id=?', input.row.id) ?? current.revision + 1;
      emitFileEvent({
        type: 'file.version.created', organization_id: input.row.organization_id, entity_type: 'file', entity_id: input.row.id,
        revision: newRevision, actor_id: input.author_id, run_id: input.run_id,
        payload: { file_id: input.row.id, version_id: versionId, version_no: nextNo, change_source: input.change_source, base_version_id: base },
      });
    });
    if (input.reextract) void this.queueExtraction(versionId);
    return this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId))!;
  }

  /** 正式文件原子提交（Proposals 在全部确认后调用）：重校验权限/基准/锁，失败回滚不留半成品 */
  async commitFormalVersion(input: {
    file_id: string; content: Buffer; base_version_id: string; actor: Actor; run_id?: string | null;
    lease_token: number; summary: string; proposal_id: string;
  }): Promise<VersionDTO> {
    const d = this.d();
    const actor = input.actor;
    const row = this.fileRowOr404(input.file_id);
    this.assertVisible(row, actor);
    if (row.status !== 'active') throw AppError.notFound('文件已回收');
    if (resolveAcl(actor, 'file', row.id).allow < aclRank.editor) throw AppError.forbidden('正式提交需要文件编辑权，当前授权不足');
    if (row.current_version_id !== input.base_version_id) throw AppError.versionConflict(this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', row.current_version_id)));
    const lockKey = `file:${row.id}`;
    const stored = await storage.put(input.content, row.mime);
    let versionId = '';
    d.tx(() => {
      const cur = d.get<FileRow>('SELECT * FROM files WHERE id=?', row.id);
      if (!cur) throw AppError.notFound();
      if (cur.current_version_id !== input.base_version_id) throw AppError.versionConflict(this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', cur.current_version_id)));
      if (resolveAcl(actor, 'file', cur.id).allow < aclRank.editor) throw AppError.forbidden('正式提交需要文件编辑权，当前授权不足');
      const lock = d.get<{ owner_proposal_id: string | null; lease_token: number; expires_at: string | null }>(
        'SELECT owner_proposal_id, lease_token, expires_at FROM resource_locks WHERE resource_key=?', lockKey);
      const expired = !!lock?.expires_at && new Date(lock.expires_at).getTime() < Date.now();
      if (lock && !expired && lock.owner_proposal_id !== input.proposal_id) {
        throw AppError.busy('该文件正在被其他正式提交占用，请稍后重试', { resource_key: lockKey, holder_proposal_id: lock.owner_proposal_id });
      }
      if (lock && input.lease_token < lock.lease_token) {
        throw AppError.busy('提交租约已失效（fencing token 落后），本次写入被拒绝', { resource_key: lockKey, expected: lock.lease_token, got: input.lease_token });
      }
      const token = Math.max(input.lease_token, (lock?.lease_token ?? 0) + 1);
      if (lock) {
        d.run(`UPDATE resource_locks SET owner_run_id=?, owner_proposal_id=?, lease_token=?, acquired_at=?, expires_at=? WHERE resource_key=?`,
          input.run_id ?? null, input.proposal_id, token, nowIso(), new Date(Date.now() + 120000).toISOString(), lockKey);
      } else {
        d.run(`INSERT INTO resource_locks(resource_key,owner_run_id,owner_proposal_id,lease_token,acquired_at,expires_at) VALUES(?,?,?,?,?,?)`,
          lockKey, input.run_id ?? null, input.proposal_id, token, nowIso(), new Date(Date.now() + 120000).toISOString());
      }
      const v = this.writeVersion(actor, {
        row: cur, buffer: input.content, stored, mime: cur.mime, change_source: 'agent_formal',
        author_id: actor.userId, run_id: input.run_id ?? null, summary: input.summary, reextract: true,
      });
      versionId = v.id;
      d.run('DELETE FROM resource_locks WHERE resource_key=? AND owner_proposal_id=?', lockKey, input.proposal_id);
    });
    return this.versionDto(d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId))!;
  }

  async patchContent(actor: Actor, input: { file_id: string; content: string; base_version_id: string; summary?: string }): Promise<VersionDTO> {
    const row = this.fileRowOr404(input.file_id);
    this.assertVisible(row, actor);
    const kind = row.kind as FileKind;
    if (!['markdown', 'text', 'html'].includes(kind)) {
      throw AppError.unsupported(`${kind} 首版不做在线编辑：交付方式是「提取正文 + 只读预览 + 原文件下载」，请下载原文件在本地 Office 编辑后重新上传。`);
    }
    return this.addVersion(actor, {
      file_id: row.id, buffer: Buffer.from(input.content, 'utf8'), base_version_id: input.base_version_id,
      change_source: 'user_edit', summary: input.summary ?? '在线编辑保存',
    });
  }

  async versions(actor: Actor, file_id: string): Promise<VersionDTO[]> {
    const row = this.fileRowOr404(file_id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'viewer', '查看版本历史');
    return this.d().all<VersionRow>('SELECT * FROM file_versions WHERE file_id=? ORDER BY version_no DESC', row.id).map((v) => this.versionDto(v)!);
  }

  async readVersion(version_id: string): Promise<{ buffer: Buffer; file: FileDTO; version: VersionDTO }> {
    const d = this.d();
    const v = d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', version_id);
    if (!v) throw AppError.notFound('版本不存在');
    const row = this.fileRowOr404(v.file_id);
    const buf = await storage.read(v.object_key);
    return { buffer: buf, file: this.fileDto({ userId: row.owner_id ?? '', orgId: row.organization_id, role: 'member', displayName: '' } as Actor, row), version: this.versionDto(v)! };
  }

  async text(version_id: string): Promise<TextPayload | null> {
    const r = this.d().get<TextRow>('SELECT * FROM file_text WHERE file_version_id=?', version_id);
    if (!r) return null;
    return {
      status: r.status as TextPayload['status'], reason: r.reason, raw_text: r.raw_text ?? '',
      blocks: j<TextPayload['blocks']>(r.blocks, []), preview: { kind: r.preview_kind ?? 'monospace', note: r.preview_note ?? undefined },
      preview_html: r.preview_html, unit_count: r.unit_count, char_count: r.char_count, provider: r.provider ?? '',
    };
  }

  async diff(actor: Actor, input: { file_id: string; from_version_id: string; to_version_id: string }): Promise<{ patch: string; stats: { added: number; removed: number } }> {
    const row = this.fileRowOr404(input.file_id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'viewer', '对比版本');
    const a = await this.versionText(input.from_version_id);
    const b = await this.versionText(input.to_version_id);
    const { createTwoFilesPatch } = await importDsml('diff') as typeof import('diff');
    const patch = createTwoFilesPatch(`${row.name} (旧版)`, `${row.name} (新版)`, a, b, '', '', { context: 3 });
    let added = 0;
    let removed = 0;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return { patch, stats: { added, removed } };
  }

  /** 版本正文：文本类取原件，其余取已抽取正文（抽取未完成时返回空串并说明） */
  private async versionText(versionId: string): Promise<string> {
    const d = this.d();
    const v = d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId);
    if (!v) throw AppError.notFound('版本不存在');
    const row = this.fileRowOr404(v.file_id);
    if (['markdown', 'text', 'html'].includes(row.kind)) {
      try { return (await storage.read(v.object_key)).toString('utf8'); } catch { /* 落到抽取正文 */ }
    }
    const t = d.get<{ raw_text: string | null }>('SELECT raw_text FROM file_text WHERE file_version_id=?', v.id);
    return t?.raw_text ?? '';
  }

  // ---------------- 抽取 ----------------
  async queueExtraction(version_id: string): Promise<void> {
    scheduler.push('extraction', { version_id });
  }

  async saveExtractionResult(version_id: string, payload: TextPayload): Promise<void> {
    const d = this.d();
    const v = d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', version_id);
    if (!v) return;
    const t = nowIso();
    d.tx(() => {
      d.run(`UPDATE file_text SET status=?, reason=?, raw_text=?, tokens=?, char_count=?, unit_count=?, blocks=?,
          preview_kind=?, preview_note=?, preview_html=?, provider=?, indexed_at=?, updated_at=? WHERE file_version_id=?`,
      payload.status, payload.reason ?? null, payload.raw_text ?? '', payload.raw_text ? tokensOf(payload.raw_text) : '',
      (payload.raw_text ?? '').length, payload.unit_count ?? 0, S(payload.blocks ?? []),
      payload.preview?.kind ?? 'monospace', payload.preview?.note ?? null, payload.preview_html ?? null,
      payload.provider ?? null, t, t, version_id);
      d.run('DELETE FROM file_text_fts WHERE version_id=?', version_id);
      if (payload.status === 'ready' && payload.raw_text?.trim()) {
        d.run('INSERT INTO file_text_fts(tokens,version_id,file_id,organization_id) VALUES(?,?,?,?)',
          tokensOf(payload.raw_text), version_id, v.file_id, v.organization_id);
      }
      emitFileEvent({
        type: payload.status === 'ready' ? 'file.text.ready' : 'file.text.unavailable',
        organization_id: v.organization_id, entity_type: 'file', entity_id: v.file_id,
        payload: { file_id: v.file_id, version_id, status: payload.status, reason: payload.reason ?? null, char_count: (payload.raw_text ?? '').length },
      });
    });
  }

  async extractStatus(actor: Actor, file_id: string): Promise<{ version_id: string; status: string; reason: string | null; char_count: number }> {
    const row = await this.getFile(actor, file_id, { require: 'viewer' });
    const vid = row.current_version_id;
    if (!vid) return { version_id: '', status: 'none', reason: '文件尚无版本', char_count: 0 };
    const r = this.d().get<{ status: string; reason: string | null; char_count: number }>('SELECT status, reason, char_count FROM file_text WHERE file_version_id=?', vid);
    return { version_id: vid, status: r?.status ?? 'pending', reason: r?.reason ?? null, char_count: r?.char_count ?? 0 };
  }

  /** worker 启动补跑入口（队列不是业务真相） */
  async processExtraction(version_id: string): Promise<void> {
    const mod = await import('./extract.worker');
    return mod.runExtraction(this, version_id);
  }

  async pendingExtractionVersions(limit = 500): Promise<string[]> {
    return this.d().all<{ file_version_id: string }>(
      `SELECT ft.file_version_id FROM file_text ft JOIN file_versions v ON v.id=ft.file_version_id
       WHERE ft.status='pending' ORDER BY v.created_at LIMIT ?`, limit).map((r) => r.file_version_id);
  }

  // ---------------- 移动 / 复制 / 回收 / 恢复 ----------------
  private scopeOf(entity: { space: string; team_id: string | null; owner_id: string | null }): { rank: number; label: string } {
    if (entity.space === 'personal') return { rank: 0, label: '个人（仅所有者）' };
    if (entity.space === 'team') return { rank: 1, label: '团队可见' };
    return { rank: 2, label: '组织可见' };
  }

  /** 目标目录的实际可见范围（考虑显式 ACL 广度） */
  private effectiveScope(actor: Actor, kind: 'file' | 'folder', id: string, folderId: string | null): { rank: number; label: string; detail: string[] } {
    const folder = folderId ? this.d().get<FolderRow>('SELECT * FROM folders WHERE id=?', folderId) : null;
    const base = folder ? this.scopeOf(folder) : { rank: 0, label: '个人（仅所有者）' };
    const detail: string[] = [];
    let rank = base.rank;
    const grants = this.d().all<{ principal_type: string; permission: string; effect: string }>(
      `SELECT principal_type, permission, effect FROM acls WHERE resource_type=? AND resource_id=? AND effect='allow'`, kind, id);
    for (const g of grants) {
      if (g.principal_type === 'org') { rank = Math.max(rank, 2); detail.push('该对象已授权给整个组织'); }
      if (g.principal_type === 'team') { rank = Math.max(rank, 1); detail.push('该对象已授权给团队成员'); }
    }
    return { rank, label: rank >= 2 ? '组织可见' : rank === 1 ? '团队可见' : '个人（仅所有者）', detail };
  }

  async move(actor: Actor, input: { kind: 'folder' | 'file'; id: string; target_folder_id: string | null; accept_scope_change?: boolean }): Promise<{ needs_confirm: boolean; scope_note?: string }> {
    const d = this.d();
    const targetId = input.target_folder_id ?? this.ensurePersonalRoot(actor).id;
    const target = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', targetId);
    if (!target || target.organization_id !== actor.orgId || target.status !== 'active') throw AppError.notFound('目标文件夹不存在或不可见');
    assertFolderCan(actor, target.id, 'editor', '移动到该文件夹');
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
      if (!f || f.organization_id !== actor.orgId || f.status !== 'active') throw AppError.notFound('文件夹不存在或不可见');
      assertFolderCan(actor, f.id, 'manager', '移动文件夹');
      if (f.parent_id === target.id) return { needs_confirm: false };
      const childrenOf = (id: string) => d.all<FolderRow>('SELECT * FROM folders WHERE parent_id=?', id).map((r) => r.id);
      if (wouldCreateCycle(target.id, f.id, childrenOf)) throw AppError.forbidden('不能把文件夹移动到它自己的下级里（会形成循环）');
      const from = this.effectiveScope(actor, 'folder', f.id, f.parent_id);
      const to = this.effectiveScope(actor, 'folder', f.id, target.id);
      if (to.rank > from.rank && !input.accept_scope_change) {
        return { needs_confirm: true, scope_note: `移动后可见范围将从「${from.label}」扩大为「${to.label}」${from.detail.length ? '（' + from.detail.join('；') + '）' : ''}。范围扩大需你确认后才会落库。` };
      }
      const dup = d.get("SELECT id FROM folders WHERE parent_id IS ? AND name=? AND id<>? AND status='active'", target.id, f.name, f.id);
      if (dup) throw new AppError('VALIDATION', `目标位置已有同名文件夹「${f.name}」`, 400, { name: `建议改为「${this.suggestFolderName(target.id, f.name)}」` });
      d.tx(() => {
        d.run('UPDATE folders SET parent_id=?, space=?, owner_id=?, team_id=?, revision=revision+1, updated_at=? WHERE id=?',
          target.id, target.space, target.owner_id, target.team_id, nowIso(), f.id);
        this.repointSubtree(f.id, target);
        emitFileEvent({ type: 'folder.updated', organization_id: actor.orgId, entity_type: 'folder', entity_id: f.id, actor_id: actor.userId, payload: { action: 'move', target_folder_id: target.id, scope: to.label } });
      });
      return { needs_confirm: false };
    }
    const row = this.fileRowOr404(input.id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'editor', '移动文件');
    if (row.folder_id === target.id) return { needs_confirm: false };
    const from = this.effectiveScope(actor, 'file', row.id, row.folder_id);
    const to = this.effectiveScope(actor, 'file', row.id, target.id);
    if (to.rank > from.rank && !input.accept_scope_change) {
      return {
        needs_confirm: true,
        scope_note: `移动后文件「${row.name}」可见范围将从「${from.label}」扩大为「${to.label}」（目标位置：${this.pathText(target.id)}）。跨空间移动需你确认后才会落库。`,
      };
    }
    const dup = d.get("SELECT id FROM files WHERE folder_id IS ? AND name=? AND id<>? AND status='active'", target.id, row.name, row.id);
    if (dup) {
      const suggested = suggestName(d, target.id, row.name);
      throw new AppError('VALIDATION', `目标位置已有同名文件「${row.name}」，未做覆盖`, 400, { name: `建议改为「${suggested}」` }, { suggested_name: suggested });
    }
    d.tx(() => {
      d.run('UPDATE files SET folder_id=?, space=?, owner_id=?, team_id=?, revision=revision+1, updated_at=? WHERE id=?',
        target.id, target.space, target.owner_id ?? actor.userId, target.team_id, nowIso(), row.id);
      emitFileEvent({ type: 'file.updated', organization_id: actor.orgId, entity_type: 'file', entity_id: row.id, actor_id: actor.userId, payload: { action: 'move', target_folder_id: target.id, scope: to.label } });
    });
    return { needs_confirm: false };
  }

  /** 目录移动后子树的空间归属跟随（文件 ID 保持稳定） */
  private repointSubtree(folderId: string, target: FolderRow) {
    const d = this.d();
    const stack = [folderId];
    let guard = 0;
    while (stack.length && guard++ < 2000) {
      const cur = stack.pop()!;
      d.run('UPDATE folders SET space=?, owner_id=?, team_id=?, updated_at=? WHERE id=?', target.space, target.owner_id, target.team_id, nowIso(), cur);
      d.run('UPDATE files SET space=?, owner_id=?, team_id=?, updated_at=? WHERE folder_id=?', target.space, target.owner_id ?? null, target.team_id, nowIso(), cur);
      for (const c of d.all<FolderRow>('SELECT * FROM folders WHERE parent_id=?', cur)) stack.push(c.id);
    }
  }

  async copy(actor: Actor, input: { file_id: string; target_folder_id: string | null }): Promise<FileDTO> {
    const row = this.fileRowOr404(input.file_id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'viewer', '复制文件');
    const buf = row.current_version_id ? (await this.readVersionBytes(row.current_version_id)) : Buffer.alloc(0);
    const d = this.d();
    const target = input.target_folder_id ?? row.folder_id ?? this.ensurePersonalRoot(actor).id;
    let name = row.name;
    if (d.get("SELECT id FROM files WHERE folder_id IS ? AND name=? AND status='active'", target, name)) {
      name = suggestName(d, target, deriveCopyName(row.name));
    }
    const created = await this.createFile(actor, { folder_id: target, name, buffer: buf, mime: row.mime, change_source: 'upload', summary: `复制自 ${row.name}` });
    return created.file;
  }

  private async readVersionBytes(versionId: string): Promise<Buffer> {
    const v = this.d().get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId);
    if (!v) throw AppError.notFound('版本不存在');
    return storage.read(v.object_key);
  }

  /** 引用检查：正在被 Run 读取/写入或被待确认提案引用 → 阻止删除（§06） */
  private busyRefs(kind: 'file' | 'folder', id: string): { runs: { id: string; status: string; subtask_name: string; session_id: string }[]; proposals: { id: string; status: string; target_file_id: string }[] } | null {
    const d = this.d();
    const ids = kind === 'file' ? [id] : this.subtreeFileIds(id);
    if (!ids.length) return null;
    const runs = d.all<{ id: string; status: string; subtask_name: string; session_id: string; read_set: string; write_set: string }>(
      `SELECT id, status, subtask_name, session_id, read_set, write_set FROM runs
       WHERE status IN ('running','waiting_approval','blocked','recovering','planning')`);
    const hitRuns = runs.filter((r) => {
      const set = [...j<{ file_id?: string }[]>(r.read_set, []), ...j<{ file_id?: string }[]>(r.write_set, [])];
      return set.some((x) => ids.includes(String(x?.file_id ?? '')));
    }).map((r) => ({ id: r.id, status: r.status, subtask_name: r.subtask_name, session_id: r.session_id }));
    const props = d.all<{ id: string; status: string; target_file_id: string; target_name: string }>(
      `SELECT id, status, target_file_id, target_name FROM proposals
       WHERE status IN ('draft','pending_approval','suspended','ready_to_commit','committing')`);
    const hitProps = props.filter((p) => ids.includes(p.target_file_id));
    if (!hitRuns.length && !hitProps.length) return null;
    return { runs: hitRuns, proposals: hitProps };
  }

  private subtreeFileIds(folderId: string): string[] {
    const d = this.d();
    const out: string[] = [];
    const stack = [folderId];
    let guard = 0;
    while (stack.length && guard++ < 2000) {
      const cur = stack.pop()!;
      for (const f of d.all<{ id: string }>('SELECT id FROM files WHERE folder_id=?', cur)) out.push(f.id);
      for (const c of d.all<{ id: string }>('SELECT id FROM folders WHERE parent_id=?', cur)) stack.push(c.id);
    }
    return out;
  }

  async trash(actor: Actor, input: { kind: 'folder' | 'file'; id: string }): Promise<{ ok: boolean; reason?: string; detail?: unknown }> {
    const d = this.d();
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
      if (!f || f.organization_id !== actor.orgId || f.status !== 'active') throw AppError.notFound('文件夹不存在或不可见');
      assertFolderCan(actor, f.id, 'manager', '删除文件夹');
      // 只有「派生根」不可删（我的文件 / 团队根 / 组织空间：删了下次按成员关系又会长回来）；
      // 用户自己新建的空间根 is_space=1 是允许的，删除走回收站，可恢复。
      if (!f.parent_id && !Number(f.is_space ?? 0)) {
        throw AppError.forbidden('「我的文件 / 团队空间 / 组织空间」按成员关系自动维护，不能删除；可删除的是你自己新建的空间');
      }
      const refs = this.busyRefs('folder', f.id);
      if (refs) return { ok: false, reason: '文件夹内有文件正在被 Agent 读取或被待确认提案引用，已阻止删除', detail: refs };
      d.tx(() => {
        d.run("UPDATE folders SET status='trashed', trashed_at=?, deleted_by=?, updated_at=? WHERE id=?", nowIso(), actor.userId, nowIso(), f.id);
        emitFileEvent({ type: 'folder.trashed', organization_id: actor.orgId, entity_type: 'folder', entity_id: f.id, actor_id: actor.userId, payload: { name: f.name } });
      });
      return { ok: true };
    }
    const row = this.fileRowOr404(input.id);
    this.assertVisible(row, actor);
    assertCan(actor, 'file', row.id, 'manager', '删除文件');
    if (row.status === 'trashed') return { ok: true };
    const refs = this.busyRefs('file', row.id);
    if (refs) {
      throw AppError.busy('该文件正在被运行中的 Agent 读取或被待确认提案引用，默认阻止删除；请等运行结束或先处理提案', refs);
    }
    d.tx(() => {
      d.run("UPDATE files SET status='trashed', trashed_at=?, deleted_by=?, revision=revision+1, updated_at=? WHERE id=?", nowIso(), actor.userId, nowIso(), row.id);
      emitFileEvent({ type: 'file.trashed', organization_id: actor.orgId, entity_type: 'file', entity_id: row.id, actor_id: actor.userId, payload: { name: row.name } });
    });
    return { ok: true };
  }

  /** 审计与版本引用保持不可变，但永久撤销访问权与恢复权。 */
  async permanentDelete(actor: Actor, input: { kind: 'folder' | 'file'; id: string }): Promise<{ ok: true }> {
    const d = this.d();
    const fileIds: string[] = [];
    const folderIds: string[] = [];
    if (input.kind === 'file') {
      const file = d.get<FileRow>("SELECT * FROM files WHERE id=? AND status='trashed'", input.id);
      if (!file || file.organization_id !== actor.orgId) throw AppError.notFound('回收站中没有该文件');
      assertCan(actor, 'file', file.id, 'manager', '永久删除文件');
      fileIds.push(file.id);
    } else {
      const folder = d.get<FolderRow>("SELECT * FROM folders WHERE id=? AND status='trashed' AND permanently_deleted_at IS NULL", input.id);
      if (!folder || folder.organization_id !== actor.orgId) throw AppError.notFound('回收站中没有该文件夹');
      assertFolderCan(actor, folder.id, 'manager', '永久删除文件夹');
      const pending = [folder.id];
      while (pending.length) {
        const id = pending.pop()!;
        if (folderIds.includes(id)) continue;
        if (folderIds.length >= 2000) throw AppError.validation('文件夹层级过多');
        assertFolderCan(actor, id, 'manager', '永久删除文件夹');
        folderIds.push(id);
        pending.push(...d.all<{ id: string }>('SELECT id FROM folders WHERE parent_id=? AND organization_id=?', id, actor.orgId).map(r => r.id));
        fileIds.push(...d.all<{ id: string }>("SELECT id FROM files WHERE folder_id=? AND organization_id=? AND status<>'permanently_deleted'", id, actor.orgId).map(r => r.id));
      }
      for (const id of fileIds) assertCan(actor, 'file', id, 'manager', '永久删除文件');
    }
    const refs = this.busyRefs(input.kind, input.id);
    if (refs) throw AppError.busy('文件仍在使用中，暂时无法永久删除', refs);
    d.tx(() => {
      const now = nowIso();
      for (const id of fileIds) {
        d.run("UPDATE files SET status='permanently_deleted', deleted_by=?, revision=revision+1, updated_at=? WHERE id=?", actor.userId, now, id);
        d.run('DELETE FROM recent_file_views WHERE file_id=?', id);
      }
      for (const id of folderIds) d.run("UPDATE folders SET status='trashed', permanently_deleted_at=?, deleted_by=?, updated_at=? WHERE id=?", now, actor.userId, now, id);
      emitFileEvent({ type: `${input.kind}.permanently_deleted`, organization_id: actor.orgId, entity_type: input.kind, entity_id: input.id, actor_id: actor.userId, payload: {} });
    });
    return { ok: true };
  }

  async restore(actor: Actor, input: { kind: 'folder' | 'file'; id: string }): Promise<void> {
    await this.restoreWithNote(actor, input);
  }

  /**
   * 从回收站恢复（文件与文件夹都在这里，含重名改道与原目录已回收时回落）。
   * 注意：/files/:id/restore 是「恢复到某个历史版本」，与回收站恢复不是一回事；
   * 以前只有 /folders/:id/restore 暴露了本方法，回收站弹窗对文件去调版本恢复接口必然 400，
   * 于是文件删了就再也恢复不了 —— 现在走 /files/:id/restore-from-trash。
   */
  async restoreWithNote(actor: Actor, input: { kind: 'folder' | 'file'; id: string }): Promise<{ note: string; restored_to: string | null }> {
    const d = this.d();
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>("SELECT * FROM folders WHERE id=? AND status='trashed' AND permanently_deleted_at IS NULL", input.id);
      if (!f || f.organization_id !== actor.orgId) throw AppError.notFound('回收站中没有该文件夹');
      assertFolderCan(actor, f.id, 'manager', '恢复文件夹');
      // 用户自建空间根本来就「没有父目录」。以前只按「parent_id 为空」判定原目录已回收，
      // 会把删掉的空间恢复到「我的文件」下面 —— 空间会从空间列表消失（列表只认无父目录的根），
      // 内容却悄悄躺在个人根目录里。这里先把空间根当成合法的一级根。
      const isSpaceRoot = !f.parent_id && Number(f.is_space ?? 0) === 1;
      let parent = isSpaceRoot ? null : f.parent_id;
      let note = isSpaceRoot ? '已恢复为独立空间。' : '已恢复到原位置。';
      if (!isSpaceRoot && (!parent || !this.isFolderActive(parent))) {
        parent = this.ensurePersonalRoot(actor).id;
        note = '原目录已回收，文件可在“最近”中查看。';
      }
      const dup = d.get("SELECT id FROM folders WHERE parent_id IS ? AND name=? AND id<>? AND status='active'", parent, f.name, f.id);
      const name = dup ? this.suggestFolderName(parent ?? '', f.name) : f.name;
      d.run("UPDATE folders SET status='active', parent_id=?, name=?, trashed_at=NULL, deleted_by=NULL, updated_at=? WHERE id=?", parent, name, nowIso(), f.id);
      for (const id of this.subtreeFileIds(f.id)) {
        const file = d.get<FileRow>('SELECT * FROM files WHERE id=?', id);
        if (file?.status === 'active' && this.isFolderActive(file.folder_id ?? '')) this.bumpRecent(actor, id);
      }
      emitFileEvent({ type: 'folder.restored', organization_id: actor.orgId, entity_type: 'folder', entity_id: f.id, actor_id: actor.userId, payload: { name } });
      return { note, restored_to: parent };
    }
    const row = d.get<FileRow>("SELECT * FROM files WHERE id=? AND status='trashed'", input.id);
    if (!row || row.organization_id !== actor.orgId) throw AppError.notFound('回收站中没有该文件');
    assertCan(actor, 'file', row.id, 'manager', '恢复文件');
    let folder = row.folder_id;
    let note = '已恢复到原位置。';
    if (!folder || !this.isFolderActive(folder)) {
      folder = this.ensurePersonalRoot(actor).id;
      note = '原目录已回收，文件可在“最近”中查看。';
    }
    const dup = d.get("SELECT id FROM files WHERE folder_id IS ? AND name=? AND id<>? AND status='active'", folder, row.name, row.id);
    const name = dup ? suggestName(d, folder, row.name) : row.name;
    d.run("UPDATE files SET status='active', folder_id=?, name=?, trashed_at=NULL, deleted_by=NULL, revision=revision+1, updated_at=? WHERE id=?", folder, name, nowIso(), row.id);
    this.bumpRecent(actor, row.id);
    emitFileEvent({ type: 'file.restored', organization_id: actor.orgId, entity_type: 'file', entity_id: row.id, actor_id: actor.userId, payload: { name, folder_id: folder } });
    return { note, restored_to: folder };
  }

  private isFolderActive(id: string): boolean {
    const f = this.d().get<FolderRow>('SELECT * FROM folders WHERE id=?', id);
    if (!f || f.status !== 'active') return false;
    for (const c of this.folderChainTopDown(f.id)) if (c.status !== 'active') return false;
    return true;
  }

  // ---------------- 下载 / 预览 ----------------
  async downloadUrl(actor: Actor, file_id: string, version_id?: string): Promise<string> {
    const file = await this.getFile(actor, file_id, { require: 'viewer' });
    const vid = version_id ?? file.current_version_id;
    if (!vid) throw AppError.notFound('文件尚无版本');
    const v = this.d().get<VersionRow>('SELECT * FROM file_versions WHERE id=?', vid);
    if (!v || v.file_id !== file_id) throw AppError.notFound('版本不存在');
    return storage.signedUrl(v.object_key, 300, { userId: actor.userId, fileId: file_id, versionId: vid });
  }

  /** 下载前的服务端鉴权（签名不成立时回落到当前会话权限） */
  resolveDownloadTarget(key: string, versionId?: string, fileId?: string): { version: VersionRow; file: FileRow; filename: string } {
    const d = this.d();
    const v = versionId ? d.get<VersionRow>('SELECT * FROM file_versions WHERE id=?', versionId)
      : d.get<VersionRow>('SELECT * FROM file_versions WHERE object_key=?', key);
    if (!v || v.object_key !== key) throw AppError.notFound('对象不存在或链接已失效');
    const file = this.fileRowOr404(v.file_id);
    if (file.status === 'permanently_deleted') throw AppError.notFound('文件已永久删除');
    if (fileId && fileId !== file.id) throw AppError.notFound('链接与对象不匹配');
    return { version: v, file, filename: sanitizeName(file.name) };
  }

  actorMayRead(actor: Actor, fileId: string): boolean {
    const row = this.fileRowOr404(fileId);
    if (row.organization_id !== actor.orgId) return false;
    if (row.status !== 'active') return false;
    return resolveAcl(actor, 'file', row.id).allow >= aclRank.viewer;
  }

  readObject(key: string): Promise<Buffer> { return storage.read(key); }
  objectPath(key: string): string { return storage.pathOf(key); }

  async preview(actor: Actor, file_id: string): Promise<Jsonish> {
    const file = await this.getFile(actor, file_id, { require: 'viewer' });
    const vid = file.current_version_id;
    const tp = vid ? await this.text(vid) : null;
    const dl = await this.downloadUrl(actor, file_id);
    const note = tp?.preview?.note ?? null;
    switch (file.kind) {
      case 'word':
        return { kind: 'html', html: tp?.preview_html ?? '', text: tp?.status === 'ready' ? tp.raw_text : '', pages: tp?.unit_count ?? 0, text_status: tp?.status ?? 'pending', note: note ?? '转 HTML 只读预览（保留标题层级与表格），不在线编辑', download_url: dl };
      case 'excel': {
        const sheets = (tp?.blocks ?? []).filter((b) => b.kind === 'sheet').map((b) => ({ name: b.heading ?? `工作表 ${(b.anchor as { sheet_index?: number }).sheet_index ?? b.unit}`, rows: b.rows ?? [], truncated: !!b.truncated }));
        return { kind: 'table', sheets, rows: sheets[0]?.rows ?? [], sheets_count: sheets.length, text: file.ext === '.csv' ? tp?.raw_text ?? '' : '', text_status: tp?.status ?? 'pending', note: note ?? '只读表格视图', download_url: dl };
      }
      case 'ppt': {
        const slides = (tp?.blocks ?? []).filter((b) => b.kind === 'slide' || b.kind === 'note').map((b) => ({ page: b.unit, title: b.heading ?? '', text: b.text, is_note: b.kind === 'note' }));
        return { kind: 'slides', slides, pages: tp?.unit_count ?? 0, text_status: tp?.status ?? 'pending', note: note ?? '逐页文本卡片视图（非版式还原）', download_url: dl };
      }
      case 'pdf':
        return { kind: 'pdf', pages: tp?.unit_count ?? 0, text_status: tp?.status ?? 'pending', url: dl, inline_url: `${dl}&inline=1`, download_url: dl, note: '请在浏览器内置查看器打开下载链接' };
      case 'html':
        return { kind: 'html_source', text: await this.htmlSource(file, tp), text_status: tp?.status ?? 'pending', note: '同源永不直接渲染执行 HTML（需沙箱 iframe 且禁脚本）；此处返回净化后的文本与源码摘要', download_url: dl };
      case 'image':
        return { kind: 'image', url: dl, download_url: dl, text_status: tp?.status ?? 'unavailable', note: note ?? '直接展示，可点开大图；图片作为 Agent 视觉输入需模型具备视觉能力' };
      case 'markdown':
      case 'text':
      default: {
        const src = vid ? (await this.readVersionBytesSafe(vid)).toString('utf8') : '';
        return { kind: file.kind === 'markdown' ? 'markdown' : 'text', text: src, text_status: tp?.status ?? 'pending', editable: true, note: note ?? (file.kind === 'markdown' ? '渲染视图 + 源码视图' : '等宽文本'), download_url: dl };
      }
    }
  }

  private async htmlSource(file: FileDTO, tp: TextPayload | null): Promise<string> {
    if (tp?.raw_text) return tp.raw_text.slice(0, 200000);
    const src = file.current_version_id ? (await this.readVersionBytesSafe(file.current_version_id)).toString('utf8') : '';
    return src.replace(/<script[\s\S]*?<\/script>/gi, '').slice(0, 200000);
  }

  private async readVersionBytesSafe(versionId: string): Promise<Buffer> {
    try { return await this.readVersionBytes(versionId); } catch { return Buffer.alloc(0); }
  }

  // ---------------- Agent 边界：目录树与逻辑路径 ----------------
  async treeForBinding(actor: Actor, rootFolderId: string): Promise<{ id: string; name: string; path: string; kind: 'folder' | 'file'; file_id?: string; ext?: string }[]> {
    const root = this.d().get<FolderRow>('SELECT * FROM folders WHERE id=?', rootFolderId);
    if (!root || root.organization_id !== actor.orgId) throw AppError.notFound('文件夹不存在或不可见');
    assertFolderCan(actor, root.id, 'viewer', '读取文件夹');
    const out: { id: string; name: string; path: string; kind: 'folder' | 'file'; file_id?: string; ext?: string }[] = [];
    const walk = (folderId: string, prefix: string, depth: number) => {
      if (depth > 24 || out.length > 5000) return;
      const d = this.d();
      for (const f of d.all<FolderRow>("SELECT * FROM folders WHERE parent_id=? AND status='active' ORDER BY name", folderId)) {
        if (folderAcl(actor, f.id).allow < aclRank.viewer) continue;
        out.push({ id: f.id, name: f.name, path: prefix + f.name + '/', kind: 'folder' });
        walk(f.id, prefix + f.name + '/', depth + 1);
      }
      for (const fl of d.all<FileRow>("SELECT * FROM files WHERE folder_id=? AND status='active' ORDER BY name", folderId)) {
        if (resolveAcl(actor, 'file', fl.id).allow < aclRank.viewer) continue;
        out.push({ id: fl.id, file_id: fl.id, name: fl.name, ext: fl.ext, path: prefix + fl.name, kind: 'file' });
      }
    };
    out.push({ id: root.id, name: root.name, path: '/', kind: 'folder' });
    walk(root.id, '/', 1);
    return out;
  }

  async resolveLogicalPath(actor: Actor, input: { root_folder_id: string; include_children: boolean; path: string }): Promise<{ kind: 'folder' | 'file'; id: string; rel_path: string }> {
    const d = this.d();
    const root = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.root_folder_id);
    if (!root || root.organization_id !== actor.orgId) throw AppError.notFound('绑定的工作区不存在或不可见');
    assertFolderCan(actor, root.id, 'viewer', '读取绑定的工作区');
    const segs = resolveLogicalPath(input.path);
    if (!segs.length) return { kind: 'folder', id: root.id, rel_path: '' };
    if (!input.include_children && segs.length > 1) {
      throw AppError.forbidden(`会话绑定未包含下级工作区，不能下钻「${segs[0]}/」。请在会话的工作区选择里勾选「含子工作区」。`);
    }
    let curType: 'folder' = 'folder';
    let curId = root.id;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      void curType;
      const sub = d.get<FolderRow>("SELECT * FROM folders WHERE parent_id=? AND name=? AND status='active'", curId, seg);
      if (sub) { curId = sub.id; continue; }
      const file = d.get<FileRow>("SELECT * FROM files WHERE folder_id=? AND name=? AND status='active'", curId, seg);
      if (file) {
        if (i !== segs.length - 1) throw AppError.notFound('路径不存在：中间层级不是文件夹');
        if (resolveAcl(actor, 'file', file.id).allow < aclRank.viewer) throw AppError.notFound('路径不存在或不可见');
        return { kind: 'file', id: file.id, rel_path: segs.join('/') };
      }
      // 不泄漏目录外对象的存在性：一律 404
      throw AppError.notFound('路径不存在或不可见');
    }
    if (curId === root.id) throw AppError.notFound('路径不存在或不可见');
    assertFolderCan(actor, curId, 'viewer', '读取下级文件夹');
    return { kind: 'folder', id: curId, rel_path: segs.join('/') };
  }

  // ---------------- ACL ----------------
  grantViewForShare(actor: Actor, fileId: string, recipients: string[]): string {
    const file = this.fileRowOr404(fileId);
    this.assertVisible(file, actor);
    if (file.status !== 'active' || !file.current_version_id) throw AppError.notFound('文件已不可分享');
    this.assertFolderChainActive(file.folder_id);
    assertCan(actor, 'file', fileId, 'manager', '分享文件');
    const d = this.d();
    let count = 0;
    for (const userId of new Set(recipients)) {
      if (userId === actor.userId) continue;
      const member = d.get<{ role: Actor['role']; display_name: string }>(
        `SELECT m.role, u.display_name FROM memberships m JOIN users u ON u.id=m.user_id
         WHERE m.user_id=? AND m.organization_id=? AND m.status='active' AND u.status='active'`, userId, actor.orgId);
      if (!member) continue;
      const target: Actor = { userId, orgId: actor.orgId, role: member.role, displayName: member.display_name };
      const access = resolveAcl(target, 'file', fileId);
      if (access.allow >= aclRank.viewer) continue;
      if (access.denied) throw AppError.forbidden(`「${member.display_name}」的访问已被拒绝，请先调整文件权限`);
      this.grantRaw('file', fileId, 'user', userId, 'viewer', 'allow', actor);
      count++;
    }
    if (count) emitFileEvent({
      type: 'file.acl.updated', organization_id: actor.orgId, entity_type: 'file', entity_id: fileId,
      actor_id: actor.userId, payload: { count },
    });
    return file.current_version_id;
  }

  async aclSet(actor: Actor, input: { kind: 'folder' | 'file'; id: string; grants: { principal_type: 'user' | 'team' | 'org'; principal_id: string; permission: 'viewer' | 'editor' | 'manager'; effect?: 'allow' | 'deny' }[] }): Promise<void> {
    const d = this.d();
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
      if (!f || f.organization_id !== actor.orgId) throw AppError.notFound('文件夹不存在或不可见');
      assertFolderCan(actor, f.id, 'manager', '管理共享权限');
    } else {
      const row = this.fileRowOr404(input.id);
      this.assertVisible(row, actor);
      assertCan(actor, 'file', row.id, 'manager', '管理共享权限');
    }
    d.tx(() => {
      for (const g of input.grants) {
        if (g.principal_type === 'team') {
          const inTeam = d.get('SELECT 1 AS x FROM team_members WHERE team_id=? AND organization_id=?', g.principal_id, actor.orgId);
          if (!inTeam) throw AppError.validation('团队不存在或不属于本组织');
        }
        if (g.principal_type === 'org' && g.principal_id !== actor.orgId) throw AppError.validation('不能对本组织之外的主体授权');
        if (g.principal_type === 'user') {
          const m = d.get("SELECT 1 AS x FROM memberships WHERE user_id=? AND organization_id=? AND status='active'", g.principal_id, actor.orgId);
          if (!m) throw AppError.validation('成员不存在或不属于本组织');
        }
        d.run('DELETE FROM acls WHERE resource_type=? AND resource_id=? AND principal_type=? AND principal_id=?',
          input.kind, input.id, g.principal_type, g.principal_id);
        this.grantRaw(input.kind, input.id, g.principal_type, g.principal_id, g.permission, g.effect ?? 'allow', actor);
      }
      emitFileEvent({ type: 'file.acl.updated', organization_id: actor.orgId, entity_type: input.kind, entity_id: input.id, actor_id: actor.userId, payload: { count: input.grants.length } });
    });
  }

  async aclList(actor: Actor, input: { kind: 'folder' | 'file'; id: string }): Promise<unknown[]> {
    const d = this.d();
    if (input.kind === 'folder') {
      const f = d.get<FolderRow>('SELECT * FROM folders WHERE id=?', input.id);
      if (!f || f.organization_id !== actor.orgId) throw AppError.notFound('文件夹不存在或不可见');
      assertFolderCan(actor, f.id, 'manager', '查看共享权限');
    } else {
      const row = this.fileRowOr404(input.id);
      this.assertVisible(row, actor);
      assertCan(actor, 'file', row.id, 'manager', '查看共享权限');
    }
    return d.all<{ principal_type: string; principal_id: string; permission: string; effect: string; user_name: string | null; team_name: string | null; created_at: string }>(
      `SELECT a.principal_type, a.principal_id, a.permission, a.effect, u.display_name AS user_name, t.name AS team_name, a.created_at AS created_at
       FROM acls a LEFT JOIN users u ON u.id=a.principal_id LEFT JOIN teams t ON t.id=a.principal_id
       WHERE a.resource_type=? AND a.resource_id=? ORDER BY a.created_at`, input.kind, input.id)
      .map((r) => ({
        principal_type: r.principal_type, principal_id: r.principal_id, permission: r.permission, effect: r.effect,
        principal_name: r.user_name ?? r.team_name ?? (r.principal_type === 'org' ? '本组织所有成员' : r.principal_id),
        created_at: r.created_at,
      }));
  }

  // ---------------- 批量上传（§7.1：逐项成败，部分失败不清空已成功项）----------------
  async uploadBatch(actor: Actor, folderId: string | null, files: { originalname: string; buffer: Buffer; mimetype: string }[], idemKey?: string): Promise<UploadAttempt[]> {
    if (files.length > config.batchUploadMaxFiles) {
      throw new AppError('VALIDATION', `一次最多上传 ${config.batchUploadMaxFiles} 个文件（当前 ${files.length} 个），请分批上传`, 400, { files: `上限 ${config.batchUploadMaxFiles} 个` });
    }
    const out: UploadAttempt[] = [];
    for (const f of files) {
      const label = sanitizeName(f.originalname);
      try {
        const r = await this.createFile(actor, { folder_id: folderId, name: f.originalname, buffer: f.buffer, mime: f.mimetype, change_source: 'upload', summary: '上传' });
        out.push({ ok: true, name: r.file.name, file: r.file, version: r.version });
      } catch (e) {
        const err = e as AppError;
        out.push({
          ok: false, name: label,
          code: typeof err.code === 'string' ? err.code : 'INTERNAL',
          message: err instanceof AppError ? err.message : (e as Error).message || '上传失败',
          suggested_name: err.extra?.suggested_name as string | undefined,
        });
      }
    }
    if (idemKey) console.log(`[files] 批量上传 ${files.length} 项（Idempotency-Key ${idemKey}）：成功 ${out.filter((x) => x.ok).length}，失败 ${out.filter((x) => !x.ok).length}`);
    return out;
  }

  /** 供 Controller：新建在线文本文档（§06「新建」） */
  async createTextFile(actor: Actor, input: { folder_id: string | null; name: string; format: 'markdown' | 'text'; content?: string }): Promise<{ file: FileDTO; version: VersionDTO }> {
    const ext = input.format === 'markdown' ? '.md' : '.txt';
    const name = sanitizeName(input.name).replace(/\.(md|markdown|txt)$/i, '') + ext;
    return this.createFile(actor, {
      folder_id: input.folder_id, name, buffer: Buffer.from(input.content ?? defaultContent(input.format, name), 'utf8'),
      mime: input.format === 'markdown' ? 'text/markdown' : 'text/plain', change_source: 'user_edit', summary: '新建文档',
    });
  }
}

function nextOf(_id: string): number { return 1 }
function defaultContent(format: 'markdown' | 'text', name: string): string {
  return format === 'markdown' ? `# ${name.replace(/\.[a-z]+$/i, '')}\n\n` : '';
}
function deriveCopyName(name: string): string {
  const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(name) ?? [];
  return `${m[1] ?? name} 副本${m[2] ?? ''}`;
}
function canSeeTrashed(actor: Actor, row: FileRow): boolean {
  if (row.owner_id === actor.userId || row.created_by === actor.userId) return true;
  return resolveAcl(actor, 'file', row.id).allow >= aclRank.manager;
}

// tokens 索引与 file_text_fts 内容（与 core/tokens 保持一致的分词策略）
let tokenIndex: ((s: string) => string) | null = null;
function tokensOf(s: string): string {
  if (!tokenIndex) {
    // 同步 require 以便在事务内使用（core/tokens 无 IO）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    tokenIndex = (require('../../core/tokens') as { tokensToIndex: (s: string) => string }).tokensToIndex;
  }
  return tokenIndex(s);
}
function S(v: unknown): string {
  return JSON.stringify(v ?? null);
}
async function importDsml(spec: string): Promise<unknown> {
  // tsc 的 commonjs 输出会把 import() 降级为 require()，这里保留真实动态解析
  return (new Function('s', 'return import(s)') as (s: string) => Promise<unknown>)(spec);
}

type Jsonish = Record<string, unknown>;
type Services_Files = import('../../core/contracts').FilesService;

export interface UploadAttempt {
  ok: boolean; name: string; file?: FileDTO; version?: VersionDTO; code?: string; message?: string; suggested_name?: string;
}

// ============================================================================
// 启动补跑：pending 抽取项重新入队（队列不是业务真相）
// ============================================================================
export async function requeuePendingExtractions(): Promise<number> {
  const files = services.files as FilesService | undefined;
  if (!files) return 0;
  const rows = getDb().all<{ file_version_id: string }>(
    `SELECT ft.file_version_id FROM file_text ft JOIN file_versions v ON v.id=ft.file_version_id
     WHERE ft.status IN ('pending','failed') ORDER BY v.created_at LIMIT 2000`);
  let n = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.file_version_id)) continue;
    seen.add(r.file_version_id);
    const st = getDb().get<{ status: string }>('SELECT status FROM file_text WHERE file_version_id=?', r.file_version_id);
    if (st?.status !== 'pending') continue; // failed 不自动重跑，交给用户点「重试抽取」
    void files;
    scheduler.push('extraction', { version_id: r.file_version_id });
    n++;
  }
  return n;
}

export function pathSep(): string { return path.sep }

let filesInstance: FilesService | null = null;
export function getFilesService(): FilesService {
  if (!filesInstance) filesInstance = new FilesService();
  return filesInstance;
}
