// FlowMate · 启动装配（PRD §21 本地与局域网运行方式）
// 一条命令起服务：API 统一托管前端静态资源，监听 0.0.0.0，局域网用 http://<内网IP>:<端口> 访问。
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { type Request as EReq, type Response as ERes, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs, missingEnv } from './core/config';
import { existingInstance, instanceAddress } from './core/instance';
import { getDb, runMigrations, nowIso } from './core/db';
import { scheduler } from './core/queue';
import { live } from './core/live';
import { storageStats, dbStats } from './adapters/storage.adapter';
import { modelStatus } from './adapters/model.adapter';

import { registerFiles, recoverExtractions } from './modules/files';
import { registerSearch } from './modules/search';
import { registerOrgModules } from './modules/org';
import { registerNotificationsModules, flushPending, drainPending } from './modules/notifications';
import { registerMessagesModules } from './modules/messages';
import { registerSessions } from './modules/sessions';
import { registerOrchestrator, startOrchestratorWorker, recoverOrchestrator } from './modules/orchestrator';
import { registerProposals, startProposalTick } from './modules/proposals';
import { registerTasks } from './modules/tasks';
import { registerDiscovery, startDiscoveryWorker } from './modules/discovery';
import { registerCenter } from './modules/center';
import { AppModule } from './app.module';

/** 服务装配顺序（注册表在 Nest 启动前写好，跨模块调用才不会踩空） */
function assemble() {
  registerFiles();
  registerSearch();
  registerOrgModules();
  registerNotificationsModules();
  registerMessagesModules();
  registerSessions();
  registerOrchestrator();
  registerProposals();
  registerTasks();
  registerDiscovery();
  registerCenter();
}

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

/** 健康检查分开报 DB / 队列 / 存储（§21 可观测最低配） */
function healthHandler(_req: EReq, res: ERes) {
  let db = 'ok';
  try {
    getDb().val<number>('SELECT 1');
  } catch (e) {
    db = `error: ${(e as Error).message}`;
  }
  const outbox = getDb().get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status='pending'");
  const q = scheduler.stats();
  res.json({
    ok: db === 'ok',
    at: nowIso(),
    mode: 'lite',
    mode_note: 'Lite 模式：SQLite(node:sqlite) + 进程内调度器；无 PostgreSQL/Redis/Docker 依赖',
    components: {
      database: db,
      queue: { state: 'running', queues: q },
      storage: storageStats(),
      outbox_pending: outbox?.n ?? 0,
      websocket_clients: live.count,
      model: { configured: modelStatus().configured, missing: modelStatus().missing },
    },
    db_stats: dbStats(),
  });
}

/** 前端错误上报（局域网演示时用来定位渲染崩溃；不鉴权、不落库、只进日志） */
function clientLogHandler(req: EReq, res: ERes) {
  const b = (req.body ?? {}) as Record<string, unknown>;
  console.error(`[client] ${String(b.where ?? '')} ${String(b.message ?? '')}\n  ${String(b.stack ?? '').split('\n').slice(0, 6).join('\n  ')}`);
  res.json({ data: { ok: true }, request_id: 'client-log' });
}

async function bootstrap() {
  if (await existingInstance(config.host, config.port)) {
    console.log('[flowmate] FlowMate 已在运行，无需重复启动。');
    console.log(`  本机访问   ${instanceAddress(config.host, config.port)}/message`);
    if (config.host === '0.0.0.0' || config.host === '::') {
      for (const ip of lanAddresses()) console.log(`  局域网分享 http://${ip}:${config.port}/message`);
    }
    return;
  }
  ensureDirs();
  const dbFile = path.join(config.dataDir, 'flowmate.sqlite3');
  const fresh = !fs.existsSync(dbFile);
  const db = getDb();
  runMigrations(db);

  const missing = missingEnv();
  if (missing.length) {
    console.warn(`[flowmate] 未配置模型密钥（缺少 ${missing.join(' / ')}）：Agent 生成与纪要提取会明确返回 503，不会伪造结果。`);
    console.warn('[flowmate] 需要这些能力时，把 MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME 写进 .env 后重启即可。');
  }

  assemble();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });
  app.use(express.json({ limit: '8mb' }));
  app.use(express.urlencoded({ extended: true, limit: '8mb' }));
  app.use(cookieParser());
  app.enableCors({ origin: true, credentials: true, allowedHeaders: ['content-type', 'x-organization-id', 'x-flowmate-client', 'idempotency-key'] });

  // 健康检查与前端错误上报在鉴权之前（不泄漏任何业务数据）
  app.use('/api/v1/health', healthHandler as (a: EReq, b: ERes, c: NextFunction) => void);
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/v1/client-log', clientLogHandler as (a: EReq, b: ERes, c: NextFunction) => void);

  // 静态资源与 SPA 深链回退
  const clientDir = config.clientDir;
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.use((req: EReq, res: ERes, next: NextFunction) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  } else {
    app.use((req: EReq, res: ERes, next: NextFunction) => {
      if (req.path.startsWith('/api')) return next();
      res.status(200).json({
        data: { message: '前端尚未构建：运行 pnpm build 生成 dist/client，或使用 pnpm dev 通过 Vite(5173) 访问' },
        request_id: 'bootstrap',
      });
    });
  }

  const server = await app.listen(config.port, config.host);
  live.attach(server, '/api/live');

  // worker 装配（进程内，与 API 同生命周期；业务真相在库里，重启可恢复）
  scheduler.start();
  startOrchestratorWorker();
  startProposalTick();
  startDiscoveryWorker();
  const recoveredRuns = recoverOrchestrator();
  const recoveredExtracts = await recoverExtractions();
  void drainPending({ limit: 500, maxRounds: 5 }).catch(() => undefined);
  const outboxTimer = setInterval(() => { void flushPending({ limit: 200 }).catch(() => undefined); }, 1200);
  outboxTimer.unref?.();

  const ips = lanAddresses();
  console.log('----------------------------------------------------------------');
  console.log(`  FlowMate v2.5 · Lite 模式`);
  console.log(`  本机     http://localhost:${config.port}`);
  for (const ip of ips) console.log(`  局域网   http://${ip}:${config.port}`);
  console.log(`  数据库   ${dbFile}${fresh ? '（新建）' : ''}`);
  console.log(`  文件存储 ${config.storageDir}`);
  console.log(`  模型     ${modelStatus().configured ? `${modelStatus().provider} / ${modelStatus().model}` : '未配置（AI 能力将明确失败）'}`);
  if (recoveredRuns || recoveredExtracts) console.log(`  恢复     Run ${recoveredRuns} 个、正文抽取 ${recoveredExtracts} 个`);
  console.log('  提示     这是局域网测试环境（HTTP），请勿放入敏感数据');
  console.log('----------------------------------------------------------------');

  const shutdown = async () => {
    clearInterval(outboxTimer);
    await scheduler.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

bootstrap().catch((e) => {
  console.error('[flowmate] 启动失败：', e);
  process.exit(1);
});
