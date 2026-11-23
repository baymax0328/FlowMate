// FlowMate · 实时事件（PRD §19 WebSocket：授权订阅、event_id、断线重连与游标补拉）
// 单实例即可（Lite 模式不引 Redis pub/sub）；事件内容最小化，不全量广播私人内容。
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'node:http';
import { getDb, nowIso } from './db';
import { buildPrincipal, COOKIE, hashToken, type Principal } from './auth';

interface Sub { entity_type: string; entity_id: string; last_seq: number }

interface Client {
  ws: WebSocket;
  userId: string;
  orgId: string;
  principal: Principal;
  subs: Map<string, Sub>;
  seen: string[];                 // event_id 去重（重复 event_id 丢弃）
  alive: boolean;
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

class LiveHub {
  private wss: WebSocketServer | null = null;
  private clients = new Map<WebSocket, Client>();
  private byKey = new Map<string, Set<WebSocket>>();
  private byUser = new Map<string, Set<WebSocket>>();

  attach(server: Server, path = '/api/live') {
    this.wss = new WebSocketServer({ server, path });
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const token = parseCookies(req.headers?.cookie)[COOKIE];
      const row = token ? getDb().get<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
        'SELECT id,user_id,expires_at,revoked_at FROM auth_sessions WHERE token_hash=?', hashToken(token)) : undefined;
      if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
        ws.close(4401, 'auth_required');
        return;
      }
      let principal: Principal;
      try {
        principal = buildPrincipal(getDb(), row.user_id, row.id);
      } catch {
        ws.close(4401, 'auth_required');
        return;
      }
      const orgId = (String(req.headers['x-organization-id'] ?? '')
        || new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('org')
        || principal.orgs[0]?.id || '');
      if (!principal.orgs.some((o) => o.id === orgId)) {
        ws.close(4403, 'forbidden');
        return;
      }
      principal.orgId = orgId;
      const client: Client = { ws, userId: row.user_id, orgId, principal, subs: new Map(), seen: [], alive: true };
      this.clients.set(ws, client);
      this.add(this.byUser, row.user_id, ws);
      this.send(ws, { type: 'connected', user_id: row.user_id, org_id: orgId, at: nowIso() });
      ws.on('message', (buf: Buffer) => this.handle(client, buf.toString('utf8')));
      ws.on('pong', () => { client.alive = true; });
      ws.on('close', () => this.remove(ws));
      ws.on('error', () => this.remove(ws));
    });
    const ping = setInterval(() => {
      for (const [ws, c] of this.clients) {
        if (!c.alive) { this.remove(ws); continue; }
        c.alive = false;
        try { ws.ping(); } catch { this.remove(ws); }
      }
    }, 25000);
    ping.unref?.();
  }

  private add(map: Map<string, Set<WebSocket>>, key: string, ws: WebSocket) {
    let s = map.get(key);
    if (!s) { s = new Set(); map.set(key, s); }
    s.add(ws);
  }

  private remove(ws: WebSocket) {
    const c = this.clients.get(ws);
    if (!c) return;
    this.clients.delete(ws);
    for (const k of c.subs.keys()) this.byKey.get(k)?.delete(ws);
    this.byUser.get(c.userId)?.delete(ws);
    try { ws.terminate(); } catch { /* noop */ }
  }

  private handle(client: Client, raw: string) {
    let msg: { action?: string; entity_type?: string; entity_id?: string | number; last_seq?: number };
    try { msg = JSON.parse(raw); } catch { return this.send(client.ws, { type: 'error', code: 'VALIDATION', message: 'JSON 解析失败' }); }
    if (msg.action === 'ping') return this.send(client.ws, { type: 'pong', at: nowIso() });

    if (msg.action === 'subscribe') {
      const type = String(msg.entity_type ?? '');
      const id = String(msg.entity_id ?? '');
      const key = `${type}:${id}`;
      if (!this.allowed(client, type, id)) {
        // 无权订阅：不返回任何对象信息，也不补拉（§15 权限过滤 / C20）
        return this.send(client.ws, { type: 'subscription_rejected', entity_type: type, entity_id: id });
      }
      const lastSeq = Number(msg.last_seq ?? 0);
      client.subs.set(key, { entity_type: type, entity_id: id, last_seq: lastSeq });
      this.add(this.byKey, key, client.ws);
      const rows = getDb().all<{ seq: number }>(
        'SELECT seq FROM events WHERE organization_id=? AND entity_type=? AND entity_id=? AND seq>? ORDER BY seq LIMIT 200',
        client.orgId, type, id, lastSeq);
      for (const r of rows) this.push(client, r.seq);
      return this.send(client.ws, { type: 'subscribed', entity_type: type, entity_id: id, replayed: rows.length, server_seq: Number(getDb().val<number>('SELECT MAX(seq) FROM events WHERE organization_id=?', client.orgId) ?? 0) });
    }

    if (msg.action === 'unsubscribe') {
      const key = `${msg.entity_type}:${msg.entity_id}`;
      client.subs.delete(key);
      this.byKey.get(key)?.delete(client.ws);
      return this.send(client.ws, { type: 'unsubscribed', entity_type: msg.entity_type, entity_id: msg.entity_id });
    }

    if (msg.action === 'resync') {
      const from = Number(msg.last_seq ?? 0);
      const rows = getDb().all<{ seq: number }>('SELECT seq FROM events WHERE organization_id=? AND seq>? ORDER BY seq LIMIT 500', client.orgId, from);
      for (const r of rows) this.push(client, r.seq);
      return this.send(client.ws, { type: 'resync_done', count: rows.length });
    }
  }

  /** 订阅授权：逐实体类型判定；Session ID 本身无授权效力（C06） */
  private allowed(c: Client, type: string, id: string): boolean {
    const d = getDb();
    const inOrg = (orgId?: string | null) => !!orgId && orgId === c.orgId;
    switch (type) {
      case 'conversation': {
        const r = d.get<{ organization_id: string }>('SELECT organization_id FROM conversations WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        return !!d.get('SELECT 1 AS x FROM conversation_members WHERE conversation_id=? AND user_id=? AND left_at IS NULL', id, c.userId);
      }
      case 'session': {
        const r = d.get<{ organization_id: string; owner_id: string }>('SELECT organization_id,owner_id FROM agent_sessions WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        if (r.owner_id === c.userId) return true;
        if (d.get('SELECT 1 AS x FROM session_participants WHERE session_id=? AND user_id=? AND left_at IS NULL', id, c.userId)) return true;
        return !!d.get('SELECT 1 AS x FROM session_shares WHERE session_id=? AND grantee_user_id=? AND revoked_at IS NULL AND expires_at>?', id, c.userId, nowIso());
      }
      case 'file': {
        const r = d.get<{ organization_id: string; owner_id: string; space: string }>('SELECT organization_id,owner_id,space FROM files WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        if (r.owner_id === c.userId) return true;
        if (r.space === 'personal') return false;
        return !!d.get("SELECT 1 AS x FROM acls WHERE resource_type='file' AND resource_id=?", id);
      }
      case 'user':
        return id === c.userId;
      case 'organization':
        return id === c.orgId;
      case 'task': {
        const r = d.get<{ organization_id: string; assignee_id: string | null; reviewer_id: string | null; creator_id: string; team_id: string | null }>(
          'SELECT organization_id,assignee_id,reviewer_id,creator_id,team_id FROM tasks WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        if ([r.assignee_id, r.reviewer_id, r.creator_id].includes(c.userId)) return true;
        return !!r.team_id && !!d.get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', r.team_id, c.userId);
      }
      case 'proposal': {
        const r = d.get<{ organization_id: string; required_approvers: string; created_by: string }>(
          'SELECT organization_id,required_approvers,created_by FROM proposals WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        const need: string[] = JSON.parse(r.required_approvers || '[]');
        return need.includes(c.userId) || r.created_by === c.userId;
      }
      case 'run': {
        const r = d.get<{ organization_id: string; session_id: string }>('SELECT organization_id,session_id FROM runs WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        return this.allowed(c, 'session', r.session_id);
      }
      case 'conflict': {
        const r = d.get<{ organization_id: string; session_id: string | null }>('SELECT organization_id,session_id FROM conflicts WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        return r.session_id ? this.allowed(c, 'session', r.session_id) : true;
      }
      case 'import': {
        const r = d.get<{ organization_id: string; uploader_id: string; team_id: string | null }>(
          'SELECT organization_id,uploader_id,team_id FROM discovery_imports WHERE id=?', id);
        if (!r || !inOrg(r.organization_id)) return false;
        if (r.uploader_id === c.userId) return true;
        return !!r.team_id && !!d.get('SELECT 1 AS x FROM team_members WHERE team_id=? AND user_id=?', r.team_id, c.userId);
      }
      default:
        return false;
    }
  }

  private push(c: Client, seq: number) {
    const row = getDb().get<{
      seq: number; event_id: string; type: string; entity_type: string; entity_id: string;
      revision: number | null; occurred_at: string; payload: string; organization_id: string;
    }>('SELECT * FROM events WHERE seq=?', seq);
    if (!row || row.organization_id !== c.orgId) return;
    if (c.seen.includes(row.event_id)) return;              // 重复 event_id 去重
    c.seen.push(row.event_id);
    if (c.seen.length > 800) c.seen.splice(0, c.seen.length - 800);
    const sub = c.subs.get(`${row.entity_type}:${row.entity_id}`);
    if (sub) sub.last_seq = row.seq;
    this.send(c.ws, {
      type: 'event', event_id: row.event_id, seq: row.seq, org_id: row.organization_id,
      entity_type: row.entity_type, entity_id: row.entity_id, event: row.type,
      revision: row.revision, occurred_at: row.occurred_at,
      payload: (() => { try { return JSON.parse(row.payload); } catch { return {}; } })(),
    });
  }

  private send(ws: WebSocket, obj: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /**
   * 业务事务提交后调用。
   * targetKeys：订阅了实体的连接；userIds：定向通知的用户；orgSubscribers：组织级订阅（Center）。
   */
  deliver(orgId: string, entityType: string, entityId: string, seq: number, userIds: string[] = []) {
    const key = `${entityType}:${entityId}`;
    for (const ws of this.byKey.get(key) ?? []) {
      const c = this.clients.get(ws);
      if (c && c.orgId === orgId) this.push(c, seq);
    }
    for (const ws of this.byKey.get(`organization:${orgId}`) ?? []) {
      const c = this.clients.get(ws);
      if (c) this.push(c, seq);
    }
    for (const u of userIds) {
      for (const ws of this.byUser.get(u) ?? []) {
        const c = this.clients.get(ws);
        if (c && c.orgId === orgId) this.push(c, seq);
      }
    }
  }

  /** 账号停用 / 权限撤销时主动断连（§19 / §20） */
  disconnectUser(userId: string) {
    for (const [ws, c] of this.clients) if (c.userId === userId) { this.send(ws, { type: 'session_revoked' }); ws.close(4401, 'revoked'); }
  }

  get count() { return this.clients.size; }
  snapshot() {
    return Array.from(this.clients.values()).map((c) => ({ user_id: c.userId, org_id: c.orgId, subscriptions: c.subs.size }));
  }
}

export const live = new LiveHub();
