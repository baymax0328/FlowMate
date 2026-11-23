// FlowMate · Outbox 投递器（PRD §17 事件/发件箱、§18 异步、§19 WebSocket）
// 语义：业务事务只写 events + outbox；本文件在事务之外把 pending 行投给 WS / 定向通知。
// 失败不吞异常：逐行记录 attempts 与 error，超限标 failed，整体抛错让 scheduler 走退避重试。
import { Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { getDb, j, nowIso } from '../../core/db';
import { live } from '../../core/live';
import { scheduler } from '../../core/queue';

const MAX_ATTEMPTS = 5;
const SWEEP_INTERVAL_MS = 15000;

interface OutboxRow {
  id: number;
  event_seq: number;
  channel: string;
  user_id: string | null;
  payload: string;
  attempts: number;
  status: string;
  organization_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  ev_seq: number | null;
  event_type: string | null;
}

export interface FlushResult {
  scanned: number;
  sent: number;
  retried: number;
  permanent: number;
  skipped: number;
  failures: { id: number; error: string }[];
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(n) ? Math.trunc(n) : min, min), max);
}

/** 投递一批 pending 行；返回统计（不抛异常，异常已在行级归类） */
export async function flushPending(opts?: { limit?: number }): Promise<FlushResult> {
  const d = getDb();
  const limit = clamp(opts?.limit ?? 200, 1, 500);
  const rows = d.all<OutboxRow>(
    `SELECT o.id, o.event_seq, o.channel, o.user_id, o.payload, o.attempts, o.status,
            e.organization_id, e.entity_type, e.entity_id, e.seq AS ev_seq, e.type AS event_type
     FROM outbox o LEFT JOIN events e ON e.seq=o.event_seq
     WHERE o.status='pending' ORDER BY o.id LIMIT ?`, limit);
  const out: FlushResult = { scanned: rows.length, sent: 0, retried: 0, permanent: 0, skipped: 0, failures: [] };
  for (const r of rows) {
    try {
      if (r.ev_seq === null || r.ev_seq === undefined) throw new Error(`事件行缺失（event_seq=${r.event_seq}）`);
      const orgId = String(r.organization_id ?? '');
      if (!orgId) throw new Error('事件缺少组织边界，拒绝广播');
      switch (r.channel) {
        case 'ws':
          // 只投实体标识与 seq，内容由客户端按订阅拉取（不全量广播私人正文）
          live.deliver(orgId, String(r.entity_type), String(r.entity_id), Number(r.ev_seq));
          break;
        case 'notification': {
          const uid = r.user_id ?? j<{ user_id?: string }>(r.payload, {}).user_id ?? null;
          if (!uid) throw new Error('通知投递缺少接收人');
          live.deliver(orgId, String(r.entity_type), String(r.entity_id), Number(r.ev_seq), [uid]);
          break;
        }
        case 'usage':
        case 'mail_disabled':
          // §24 明确不做外部推送与用量治理：无投递目标，标记完成即可（不留 pending 垃圾）
          out.skipped += 1;
          break;
        default:
          throw new Error(`未知发件箱通道：${r.channel}`);
      }
      d.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1, error=NULL WHERE id=?", nowIso(), r.id);
      out.sent += 1;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 400);
      const attempts = Number(r.attempts ?? 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        d.run("UPDATE outbox SET status='failed', attempts=?, error=? WHERE id=?", attempts, msg, r.id);
        out.permanent += 1;
      } else {
        d.run("UPDATE outbox SET attempts=?, error=? WHERE id=?", attempts, msg, r.id);
        out.retried += 1;
      }
      out.failures.push({ id: r.id, error: msg });
    }
  }
  return out;
}

/** 启动补跑 / 测试直接调用：一直清到没有 pending 或达到轮次上限 */
export async function drainPending(opts?: { limit?: number; maxRounds?: number }): Promise<FlushResult> {
  const total: FlushResult = { scanned: 0, sent: 0, retried: 0, permanent: 0, skipped: 0, failures: [] };
  const rounds = clamp(opts?.maxRounds ?? 20, 1, 200);
  for (let i = 0; i < rounds; i++) {
    const r = await flushPending(opts);
    total.scanned += r.scanned;
    total.sent += r.sent;
    total.retried += r.retried;
    total.permanent += r.permanent;
    total.skipped += r.skipped;
    total.failures.push(...r.failures);
    if (r.scanned === 0) break;
    if (r.sent === 0 && r.skipped === 0) break;   // 全失败：交给 scheduler 退避，避免热循环
  }
  return total;
}

export function outboxStats() {
  const d = getDb();
  return {
    pending: Number(d.val<number>("SELECT COUNT(*) FROM outbox WHERE status='pending'") ?? 0),
    sent: Number(d.val<number>("SELECT COUNT(*) FROM outbox WHERE status='sent'") ?? 0),
    failed: Number(d.val<number>("SELECT COUNT(*) FROM outbox WHERE status='failed'") ?? 0),
    oldest_pending_at: d.val<string>("SELECT created_at FROM outbox WHERE status='pending' ORDER BY id LIMIT 1") ?? null,
  };
}

@Injectable()
export class OutboxWorker implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger('outbox');
  private configured = false;
  private timer: NodeJS.Timeout | null = null;

  onModuleInit() {
    this.register();
  }

  onApplicationBootstrap() {
    // main.ts 可能在模块初始化之后才 define 队列，这里再挂一次 handler 保证不被覆盖成默认抛错实现
    this.register();
    void this.flushOnBoot();
    this.startSweep();
  }

  /** 注册 scheduler.onJob('outbox')；重复调用安全 */
  register() {
    if (!this.configured) {
      scheduler.define('outbox', { concurrency: 1, retryBackoffMs: [2000, 8000, 20000] });
      this.configured = true;
    }
    scheduler.onJob('outbox', async () => {
      const r = await flushPending({ limit: 200 });
      if (r.retried > 0 || r.permanent > 0) {
        throw new Error(`outbox 投递未完成：待重试 ${r.retried} 条，永久失败 ${r.permanent} 条，` +
          `首个错误「${r.failures[0]?.error ?? '未知'}」`);
      }
    });
  }

  async flushOnBoot() {
    const stats = outboxStats();
    if (!stats.pending) return;
    this.logger.log(`启动补跑发件箱：待投 ${stats.pending} 条`);
    const r = await drainPending({ limit: 200 });
    this.logger.log(`发件箱补跑完成：投递 ${r.sent} 条，跳过 ${r.skipped} 条，失败 ${r.permanent} 条`);
    if (r.permanent > 0) this.logger.warn(`存在永久失败行，可在 outbox 表按 status='failed' 查看 error 字段`);
  }

  /** 兜底扫描：主控只在事务提交后 push('outbox')，这里保证遗留行不会永久卡住 */
  startSweep() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        if (outboxStats().pending > 0) scheduler.push('outbox', { reason: 'sweep' });
      } catch (e) {
        this.logger.error(`发件箱扫描入队失败：${(e as Error).message}`);
      }
    }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stopSweep() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
