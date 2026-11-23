// FlowMate · 进程内调度器（PRD §18「异步」的 Lite 落地，等价替换 Redis + BullMQ，已记入覆盖矩阵）
// 设计原则与规格一致：队列不是业务真相 —— 计划 / Run / 导入状态全部落库，进程重启由 recover() 重建。
// 语义保留：命名队列并发上限、租约（lease）、fencing token、重试与退避、失败可见。
import { EventEmitter } from 'node:events';

export type JobName =
  | 'extraction'      // 正文抽取与索引
  | 'agent-run'       // Run 执行（两槽并发在 orchestrator 内部再分层控制）
  | 'discovery'       // 导入分析
  | 'outbox'          // 事件投递
  | 'proposal-tick'   // 提醒与超时挂起
  | 'watch-tick';     // 目录轮询

export interface Job<T = Record<string, unknown>> {
  id: string;
  name: JobName;
  payload: T;
  attempt: number;
  runAt: number;
  enqueuedAt: number;
  leaseToken: number;
}

export type Handler<T = Record<string, unknown>> = (job: Job<T>, ctx: { leaseToken: number; heartbeat: () => void }) => Promise<void>;

interface QueueDef { concurrency: number; handler: Handler; retryBackoffMs: number[] }

export class Scheduler extends EventEmitter {
  private queues = new Map<JobName, QueueDef>();
  private pending: Job[] = [];
  private active = new Map<string, { job: Job; startedAt: number }>();
  private leaseCounter = 0;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  public recover: (push: (name: JobName, payload: Record<string, unknown>) => void) => Promise<void> = async () => {};

  define(name: JobName, def: { concurrency: number; retryBackoffMs?: number[] }) {
    this.queues.set(name, { concurrency: def.concurrency, retryBackoffMs: def.retryBackoffMs ?? [2000, 8000, 20000], handler: async () => { throw new Error(`handler for ${name} not registered`); } });
  }

  onJob(name: JobName, handler: Handler) {
    const q = this.queues.get(name) ?? { concurrency: 1, retryBackoffMs: [2000], handler };
    q.handler = handler;
    this.queues.set(name, q);
  }

  push<T>(name: JobName, payload: T, opts?: { delayMs?: number }): Job<T> {
    if (!this.queues.has(name)) this.define(name, { concurrency: 1 });
    const job: Job<T> = {
      id: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name, payload, attempt: 0,
      runAt: Date.now() + (opts?.delayMs ?? 0),
      enqueuedAt: Date.now(),
      leaseToken: ++this.leaseCounter,
    };
    this.pending.push(job as Job);
    this.kick();
    return job;
  }

  /** 当前占用情况（Center 概览与「排队原因」使用） */
  stats() {
    const out: Record<string, { running: number; queued: number; concurrency: number }> = {};
    for (const [name, def] of this.queues) {
      out[name] = {
        running: [...this.active.values()].filter((a) => a.job.name === name).length,
        queued: this.pending.filter((p) => p.name === name).length,
        concurrency: def.concurrency,
      };
    }
    return out;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), 200);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const deadline = Date.now() + 3000;
    while (this.active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  private kick() {
    setImmediate(() => this.tick());
  }

  private tick() {
    if (this.stopped) return;
    const now = Date.now();
    const ready = this.pending.filter((j) => j.runAt <= now);
    for (const job of ready) {
      const def = this.queues.get(job.name)!;
      const running = [...this.active.values()].filter((a) => a.job.name === job.name).length;
      if (running >= def.concurrency) continue;
      this.pending.splice(this.pending.indexOf(job), 1);
      job.attempt += 1;
      job.leaseToken = ++this.leaseCounter;
      this.active.set(job.id, { job, startedAt: now });
      this.runJob(job, def);
    }
  }

  private async runJob(job: Job, def: QueueDef) {
    let heartbeats = 0;
    const hb = setInterval(() => { heartbeats++; this.emit('heartbeat', job, heartbeats); }, 15000);
    hb.unref?.();
    try {
      await def.handler(job, {
        leaseToken: job.leaseToken,
        heartbeat: () => this.emit('heartbeat', job, ++heartbeats),
      });
      this.emit('succeeded', job);
    } catch (e) {
      const msg = (e as Error).message ?? 'unknown';
      this.emit('failed', job, e as Error);
      const backoff = def.retryBackoffMs[job.attempt - 1];
      if (backoff && job.attempt < def.retryBackoffMs.length + 1) {
        job.runAt = Date.now() + backoff;
        this.pending.push(job);
      } else {
        console.error(`[queue] ${job.name} 永久失败（attempt ${job.attempt}）：${msg}`);
        this.emit('exhausted', job, e as Error);
      }
    } finally {
      clearInterval(hb);
      this.active.delete(job.id);
      this.kick();
    }
  }
}

export const scheduler = new Scheduler();
