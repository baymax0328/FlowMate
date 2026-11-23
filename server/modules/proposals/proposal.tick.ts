// FlowMate · 共同确认定时任务（§11.3 超时挂起：由 scheduler 'proposal-tick' 每 60s 调用 svc.tick()）
// tick 只做三件事：提醒节奏（第 1 小时 → 此后每 24h）、72h 超时挂起、失效率检测（基准变化转 stale）。
// 绝不在此做任何「超时即同意」的判定（底线1）。
//
// 自调度：startProposalTick() 注册 handler 并首推一次；每次 handler 跑完在 finally 再推一枪（delayMs 60s），
// 形成「每 60s 一次」的稳定节奏，不依赖、不修改 core/*，也不与 orchestrator 的 scheduler.runner 冲突。
import { scheduler } from '../../core/queue';
import { getProposalsService } from './proposals.service';

const TICK_MS = 60000;
let started = false;

export function startProposalTick(): void {
  if (started) return;
  started = true;
  scheduler.define('proposal-tick', { concurrency: 1, retryBackoffMs: [5000] });
  const pump = async () => {
    try {
      const result = await getProposalsService().tick();
      if (result.reminded || result.suspended) {
        console.log(`[proposals] tick：提醒 ${result.reminded} 条，挂起 ${result.suspended} 条`);
      }
    } catch (e) {
      console.error(`[proposals] tick 异常：${(e as Error).message}`);
    } finally {
      scheduler.push('proposal-tick', { at: Date.now() + TICK_MS }, { delayMs: TICK_MS });
    }
  };
  scheduler.onJob('proposal-tick', async (_job, ctx) => { ctx.heartbeat(); await pump(); });
  scheduler.push('proposal-tick', { at: Date.now() + TICK_MS }, { delayMs: TICK_MS });
}
