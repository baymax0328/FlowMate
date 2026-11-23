// FlowMate · 搜索规格实现（PRD §15）
// 分层：成员/会话/文件名 P0 元数据检索；消息正文与文档正文 P1 全文检索（中文二元组 + FTS5 倒排）。
// 权限过滤在服务端：无权对象不返回标题、摘要或计数；正文不可检索的文件必须显式标注，不得静默漏检。
import { Injectable } from '@nestjs/common';
import { getDb } from '../../core/db';
import { AppError } from '../../core/errors';
import { aclRank, resolveAcl, canRead, isOrgManager, userTeams, type Actor } from '../../core/permissions';
import { buildMatch, hasQuery, snippetFor, normalize } from '../../core/tokens';
import type { SearchService as SearchContract, Json } from '../../core/contracts';

const PAGE = 20;
const DOC_KINDS = ['markdown', 'text', 'html', 'word', 'pdf', 'excel', 'ppt'];

interface Offsets { members?: number; conversations?: number; messages?: number; files?: number; tasks?: number }

function decodeCursor(raw?: string): Offsets {
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Offsets;
  } catch {
    return {};
  }
}
function encodeCursor(o: Offsets): string | null {
  return Buffer.from(JSON.stringify(o)).toString('base64');
}

@Injectable()
export class SearchService implements SearchContract {
  private d = () => getDb();

  async search(actor: Actor, q: string, type: 'all' | 'members' | 'conversations' | 'messages' | 'files' | 'tasks',
    opts?: { cursor?: string; limit?: number; folder_id?: string; conversation_id?: string; kind?: string; status?: string; space?: string }) {
    const query = (q ?? '').trim();
    const off = decodeCursor(opts?.cursor);
    if (!query) {
      return { query: '', groups: {}, unsearchable: [], note: '输入关键词后检索' };
    }
    const want = (k: keyof Offsets) => type === 'all' || type === k;
    const groups: Json = {};

    if (want('members')) groups.members = this.members(actor, query, off.members ?? 0);
    if (want('conversations')) groups.conversations = this.conversations(actor, query, off.conversations ?? 0);
    if (want('messages')) groups.messages = this.messages(actor, query, off.messages ?? 0, opts?.conversation_id);
    if (want('files')) {
      const r = this.files(actor, query, off.files ?? 0, opts);
      // 与其它分组保持同一形状 {items, more}：之前这里返回裸数组，
      // 前端按 groups.files.items 读取，结果全局搜索与 Workspace 搜索永远显示「无命中」。
      groups.files = { items: r.items, more: r.more };
    }
    if (want('tasks')) groups.tasks = this.tasks(actor, query, off.tasks ?? 0, opts?.status);
    const unsearchable = want('files') ? this.unsearchable(actor, opts?.space) : [];
    return { query, groups, unsearchable, note: unsearchable.length ? '部分文件正文暂不可检索' : undefined };
  }

  // ---------- 成员（P0）----------
  private members(actor: Actor, q: string, offset: number) {
    const like = `%${q.toLowerCase()}%`;
    const rows = this.d().all<Json>(
      `SELECT u.id, u.display_name, u.email, u.title, m.role
       FROM users u JOIN memberships m ON m.user_id=u.id
       WHERE m.organization_id=? AND m.status='active' AND u.status='active'
         AND (lower(u.display_name) LIKE ? OR lower(u.email) LIKE ?)
       ORDER BY u.display_name LIMIT ? OFFSET ?`,
      actor.orgId, like, like, PAGE + 1, offset);
    const more = rows.length > PAGE;
    return { items: rows.slice(0, PAGE).map((r) => ({ ...r, kind: 'member' })), more };
  }

  // ---------- 会话（P0：私聊按对方成员名组合、项目群按名称）----------
  private conversations(actor: Actor, q: string, offset: number) {
    const like = `%${q.toLowerCase()}%`;
    const rows = this.d().all<Json>(
      `SELECT c.id, c.type, c.name, c.last_message_at,
        (SELECT group_concat(u.display_name, '、') FROM conversation_members cm JOIN users u ON u.id=cm.user_id
          WHERE cm.conversation_id=c.id AND cm.left_at IS NULL AND cm.user_id<>?) AS others
       FROM conversations c
       JOIN conversation_members me ON me.conversation_id=c.id AND me.user_id=? AND me.left_at IS NULL
       WHERE c.organization_id=? AND c.status='active' AND me.hidden=0
         AND (lower(IFNULL(c.name,'')) LIKE ?
              OR EXISTS (SELECT 1 FROM conversation_members cm2 JOIN users u2 ON u2.id=cm2.user_id
                         WHERE cm2.conversation_id=c.id AND cm2.user_id<>? AND lower(u2.display_name) LIKE ?))
       ORDER BY c.last_message_at DESC LIMIT ? OFFSET ?`,
      actor.userId, actor.userId, actor.orgId, like, actor.userId, like, PAGE + 1, offset);
    const more = rows.length > PAGE;
    return {
      items: rows.slice(0, PAGE).map((r) => ({
        ...r, kind: 'conversation',
        display_name: r.type === 'dm' ? String(r.others || '私聊') : String(r.name || '项目群'),
      })), more,
    };
  }

  // ---------- 消息正文（P1：会话内定位 + 跨会话检索）----------
  private messages(actor: Actor, q: string, offset: number, conversationId?: string) {
    const match = buildMatch(q);
    if (!match) return { items: [], more: false };
    let rows: { message_id: string; conversation_id: string; rank: number }[] = [];
    try {
      rows = conversationId
        ? this.d().all(`SELECT f.message_id, f.conversation_id, bm25(message_text_fts) AS rank
            FROM message_text_fts f JOIN messages m ON m.id=f.message_id
            WHERE message_text_fts MATCH ? AND f.conversation_id=? AND f.organization_id=?
              AND m.retracted_at IS NULL
              AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=f.conversation_id AND cm.user_id=? AND cm.left_at IS NULL AND m.history_seq>cm.history_cutoff)
            ORDER BY rank LIMIT ? OFFSET ?`, match, conversationId, actor.orgId, actor.userId, PAGE + 1, offset)
        : this.d().all(`SELECT f.message_id, f.conversation_id, bm25(message_text_fts) AS rank
            FROM message_text_fts f JOIN messages m ON m.id=f.message_id
            WHERE message_text_fts MATCH ? AND f.organization_id=? AND m.retracted_at IS NULL
              AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=f.conversation_id AND cm.user_id=? AND cm.left_at IS NULL AND m.history_seq>cm.history_cutoff)
            ORDER BY rank LIMIT ? OFFSET ?`, match, actor.orgId, actor.userId, PAGE + 1, offset);
    } catch {
      // FTS 表达式异常时退回 LIKE（不因索引语法问题而静默返回空）
      const like = `%${normalize(q)}%`;
      rows = this.d().all(`SELECT m.id AS message_id, m.conversation_id, 0 AS rank FROM messages m
        WHERE m.organization_id=? AND lower(m.body) LIKE ? AND m.retracted_at IS NULL
          AND EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id=m.conversation_id AND cm.user_id=? AND cm.left_at IS NULL AND m.history_seq>cm.history_cutoff)
        ORDER BY m.created_at DESC LIMIT ? OFFSET ?`, actor.orgId, like, actor.userId, PAGE + 1, offset);
    }
    const more = rows.length > PAGE;
    const items = rows.slice(0, PAGE).map((r) => {
      const m = this.d().get<Json>('SELECT m.*, u.display_name AS sender_name, c.name AS conversation_name, c.type AS conversation_type FROM messages m JOIN users u ON u.id=m.sender_id JOIN conversations c ON c.id=m.conversation_id WHERE m.id=?', r.message_id);
      if (!m) return null;
      const snip = snippetFor(String(m.body), q);
      return {
        kind: 'message', message_id: m.id, conversation_id: m.conversation_id,
        conversation_name: m.type === 'dm'
          ? (this.d().val<string>(`SELECT group_concat(u.display_name,'、') FROM conversation_members cm JOIN users u ON u.id=cm.user_id WHERE cm.conversation_id=? AND cm.user_id<>? AND cm.left_at IS NULL`, m.conversation_id, actor.userId) || '私聊')
          : m.conversation_name,
        sender_name: m.sender_name, created_at: m.created_at,
        snippet: snip?.text ?? String(m.body).slice(0, 160),
        hits: snip?.hits ?? [],
      };
    }).filter(Boolean);
    return { items, more };
  }

  // ---------- 文件：名称 + 路径（P0）与正文（P1）----------
  private files(actor: Actor, q: string, offset: number, opts?: { folder_id?: string; kind?: string; space?: string }) {
    const d = this.d();
    const like = `%${q.toLowerCase()}%`;
    const meta = d.all<Json>(
      `SELECT f.*, f2.name AS folder_name FROM files f LEFT JOIN folders f2 ON f2.id=f.folder_id
       WHERE f.organization_id=? AND f.status='active'
         AND (lower(f.name) LIKE ? ${opts?.folder_id ? 'OR f.folder_id=? ' : ''})
         ${opts?.kind ? 'AND f.kind=?' : ''} ${opts?.space ? 'AND f.space=?' : ''}
       ORDER BY f.updated_at DESC LIMIT ?`,
      actor.orgId, like, ...(opts?.folder_id ? [opts.folder_id] : []),
      ...(opts?.kind ? [opts.kind] : []), ...(opts?.space ? [opts.space] : []), 120)
      .filter((f) => canRead(actor, 'file', String(f.id)));

    const match = buildMatch(q);
    let content: Json[] = [];
    if (match && hasQuery(q)) {
      let hits: { version_id: string; file_id: string; rank: number }[] = [];
      try {
        hits = d.all(`SELECT f.version_id, f.file_id, bm25(file_text_fts) AS rank FROM file_text_fts f
          JOIN files fl ON fl.id=f.file_id
          WHERE file_text_fts MATCH ? AND f.organization_id=? AND fl.status='active'
          ${opts?.folder_id ? 'AND fl.folder_id=? ' : ''}
          ORDER BY rank LIMIT ?`, match, actor.orgId, ...(opts?.folder_id ? [opts.folder_id] : []), 120);
      } catch {
        hits = [];
      }
      for (const h of hits) {
        const fl = d.get<Json>('SELECT * FROM files WHERE id=?', h.file_id);
        if (!fl || !canRead(actor, 'file', h.file_id)) continue;
        const t = d.get<{ raw_text: string; blocks: string; status: string }>(
          'SELECT raw_text, blocks, status FROM file_text WHERE file_version_id=?', h.version_id);
        if (!t || t.status !== 'ready') continue;
        const snip = snippetFor(t.raw_text ?? '', q);
        const loc = this.locate(JSON.parse(t.blocks || '[]') as { block_id: string; text: string; unit: number; kind: string; heading?: string; anchor?: Json }[], q);
        content.push({
          kind: 'file_content', file_id: h.file_id, version_id: h.version_id,
          name: fl.name, ext: fl.ext, space: fl.space, folder_id: fl.folder_id,
          updated_at: fl.updated_at, snippet: snip?.text ?? '', hits: snip?.hits ?? [],
          location: loc, file_version_id: h.version_id,
        });
        if (content.length >= 60) break;
      }
    }

    const merged = [
      ...meta.map((f) => ({ ...f, kind: 'file_name' })),
      ...content,
    ];
    // 去重：同一文件既有名称命中又有正文命中时保留正文命中（信息更多）
    const seen = new Map<string, Json>();
    for (const item of merged as Json[]) {
      const key = `${item.file_id ?? item.id}:${item.kind === 'file_content' ? 'c' : 'n'}`;
      const id = String((item as Json).file_id ?? (item as Json).id);
      if (seen.has(id) && (item as Json).kind !== 'file_content') continue;
      seen.set(id, item);
    }
    const all = Array.from(seen.values());
    return {
      items: all.slice(offset, offset + PAGE).map((item) => {
        const { allow } = resolveAcl(actor, 'file', String(item.file_id ?? item.id));
        const my_permission = allow >= aclRank.manager ? 'manager' : allow >= aclRank.editor ? 'editor' : 'viewer';
        return { ...item, my_permission };
      }),
      more: all.length > offset + PAGE,
      total: all.length,
    };
  }

  private locate(blocks: { block_id: string; text: string; unit: number; kind: string; heading?: string; anchor?: Json }[], q: string): Json | null {
    const nq = normalize(q);
    for (const b of blocks ?? []) {
      if (normalize(b.text).includes(nq) || (hasQuery(q) && buildMatch(q) && this.tokensHit(b.text, q))) {
        return { block_id: b.block_id, unit: b.unit, kind: b.kind, heading: b.heading ?? null, ...(b.anchor ?? {}) };
      }
    }
    return null;
  }

  private tokensHit(text: string, q: string) {
    const n = normalize(text);
    for (const t of new Set(buildMatch(q).split(' AND ').map((x) => x.replace(/"/g, '')))) {
      if (!n.includes(t)) return false;
    }
    return true;
  }

  /** 诚实标注：正文不可检索清单（§15） */
  private unsearchable(actor: Actor, space?: string) {
    const rows = this.d().all<Json>(
      `SELECT fl.id, fl.name, fl.kind, ft.status, ft.reason FROM files fl
       LEFT JOIN file_versions fv ON fv.id=fl.current_version_id
       LEFT JOIN file_text ft ON ft.file_version_id=fv.id
       WHERE fl.organization_id=? AND fl.status='active' AND fl.kind IN (${DOC_KINDS.map(() => '?').join(',')})
         ${space ? 'AND fl.space=?' : ''}
         AND (ft.status IS NULL OR ft.status<>'ready')
       ORDER BY fl.updated_at DESC LIMIT 20`,
      actor.orgId, ...DOC_KINDS, ...(space ? [space] : []));
    return rows.filter((r) => canRead(actor, 'file', String(r.id))).map((r) => ({
      file_id: r.id, name: r.name, kind: r.kind,
      status: r.status ?? 'pending',
      reason: r.reason ?? '尚未完成正文抽取（新上传文件在队列中）',
    }));
  }

  // ---------- 任务（P0 元数据 + 状态叠加）----------
  private tasks(actor: Actor, q: string, offset: number, status?: string) {
    const like = `%${q.toLowerCase()}%`;
    const teams = userTeams(actor.userId, actor.orgId);
    const rows = this.d().all<Json>(
      `SELECT t.*, u.display_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id
       WHERE t.organization_id=?
         AND (lower(t.title) LIKE ? OR lower(IFNULL(t.description,'')) LIKE ? OR lower(IFNULL(t.project,'')) LIKE ?)
         ${status ? 'AND t.status=?' : ''}
         AND (t.creator_id=? OR t.assignee_id=? OR t.reviewer_id=? OR ?
              ${teams.length ? `OR t.team_id IN (${teams.map(() => '?').join(',')})` : ''})
       ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`,
      actor.orgId, like, like, like, ...(status ? [status] : []),
      actor.userId, actor.userId, actor.userId, isOrgManager(actor) ? 1 : 0, ...teams, PAGE + 1, offset);
    return { items: rows.slice(0, PAGE).map((r) => ({ ...r, kind: 'task' })), more: rows.length > PAGE };
  }

  /** Agent search.content：同一索引，作用域强制收窄到绑定目录（§8.1） */
  async searchWithinBinding(actor: Actor, input: { query: string; root_folder_id: string; include_children: boolean; fileTypes?: string[]; limit?: number }): Promise<Json[]> {
    const { root_folder_id, include_children, query, fileTypes } = input;
    if (!query || !hasQuery(query)) return [];
    if (!canRead(actor, 'folder', root_folder_id)) throw AppError.notFound('绑定的工作区不可读');
    const d = this.d();
    const ids = include_children ? this.descendantFileIds(root_folder_id) : this.childFileIds(root_folder_id);
    if (!ids.length) return [];
    const match = buildMatch(query);
    let hits: { version_id: string; file_id: string }[] = [];
    try {
      hits = d.all<{ version_id: string; file_id: string }>(`SELECT version_id, file_id FROM file_text_fts WHERE file_text_fts MATCH ? AND organization_id=? LIMIT 200`, match, actor.orgId)
        .filter((h) => ids.includes(String(h.file_id)));
    } catch {
      hits = [];
    }
    const out: Json[] = [];
    for (const h of hits) {
      const fl = d.get<Json>('SELECT * FROM files WHERE id=? AND status=\'active\'', h.file_id);
      if (!fl) continue;
      if (fileTypes?.length && !fileTypes.includes(String(fl.kind)) && !fileTypes.includes(String(fl.ext))) continue;
      const t = d.get<{ raw_text: string; blocks: string; status: string }>('SELECT raw_text,blocks,status FROM file_text WHERE file_version_id=?', h.version_id);
      if (!t || t.status !== 'ready') continue;
      const snip = snippetFor(t.raw_text ?? '', query);
      out.push({
        file_id: fl.id, name: fl.name, kind: fl.kind, version_id: h.version_id,
        snippet: snip?.text ?? '', hits: snip?.hits ?? [],
        location: this.locate(JSON.parse(t.blocks || '[]') as never, query),
      });
      if (out.length >= (input.limit ?? 20)) break;
    }
    return out;
  }

  private childFileIds(folderId: string): string[] {
    return this.d().all<{ id: string }>('SELECT id FROM files WHERE folder_id=? AND status=\'active\'', folderId).map((r) => r.id);
  }

  private descendantFileIds(folderId: string): string[] {
    const d = this.d();
    const out = new Set<string>();
    const stack = [folderId];
    let guard = 0;
    while (stack.length && guard++ < 2000) {
      const cur = stack.pop()!;
      for (const f of d.all<{ id: string }>('SELECT id FROM files WHERE folder_id=? AND status=\'active\'', cur)) out.add(f.id);
      for (const c of d.all<{ id: string }>('SELECT id FROM folders WHERE parent_id=? AND status=\'active\'', cur)) stack.push(c.id);
    }
    return Array.from(out);
  }
}

let searchInstance: SearchService | null = null;
export function getSearchService(): SearchService {
  if (!searchInstance) searchInstance = new SearchService();
  return searchInstance;
}
