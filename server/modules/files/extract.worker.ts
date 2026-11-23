// FlowMate · 正文抽取 worker（PRD §06 / §18：解析在 Worker 中跑，带超时与大小上限）
// 抽取一次，同时服务正文检索与 Agent 的 doc.extract。
import { scheduler } from '../../core/queue';
import { getDb } from '../../core/db';
import { config } from '../../core/config';
import { AppError } from '../../core/errors';
import { extract, type ExtractResult } from '../../adapters/extraction';
import { getFilesService, type FilesService } from './files.service';

let started = false;

function payloadOf(r: ExtractResult, size: number) {
  return {
    status: r.status,
    reason: r.reason ?? null,
    raw_text: r.raw_text,
    blocks: r.blocks,
    preview: r.preview,
    preview_html: r.previewHtml ?? null,
    unit_count: r.unit_count,
    char_count: size,
    provider: r.provider,
  };
}

/** 单个版本的正文抽取：读原文件 → 解析 → 落 file_text 与 FTS 索引 */
export async function runExtraction(svc: FilesService, version_id: string): Promise<void> {
  const d = getDb();
  const v = d.get<{ id: string; file_id: string; object_key: string; size: number; mime: string }>(
    'SELECT id, file_id, object_key, size, mime FROM file_versions WHERE id=?', version_id);
  if (!v) return;
  const file = d.get<{ name: string; kind: string; organization_id: string }>('SELECT name, kind, organization_id FROM files WHERE id=?', v.file_id);
  if (!file) return;
  const t0 = Date.now();
  try {
    const buffer = await svc.readObject(v.object_key);
    if (!buffer.length) {
      await svc.saveExtractionResult(version_id, payloadOf({
        status: 'unavailable', reason: '空文件（0 字节）', raw_text: '', tokens: '', blocks: [], unit_count: 0,
        provider: 'flowmate-extraction/0.2', preview: { kind: 'monospace' },
      }, 0));
      return;
    }
    const res = await Promise.race([
      extract(file.name, buffer, v.mime),
      new Promise<never>((_, reject) => setTimeout(() => reject(new AppError('EXTRACT_FAILED', '正文抽取超时，已标记为正文不可检索', 422)), config.extractionTimeoutMs)),
    ]);
    await svc.saveExtractionResult(version_id, payloadOf(res, buffer.length));
  } catch (e) {
    const msg = e instanceof AppError ? e.message : (e as Error).message;
    await svc.saveExtractionResult(version_id, payloadOf({
      status: 'failed', reason: msg, raw_text: '', tokens: '', blocks: [], unit_count: 0,
      provider: 'flowmate-extraction/0.2', preview: { kind: 'monospace' },
    }, 0));
  } finally {
    void t0;
  }
}

export function startExtractionWorker() {
  if (started) return;
  started = true;
  scheduler.define('extraction', { concurrency: 2, retryBackoffMs: [1500, 5000] });
  scheduler.onJob('extraction', async (job) => {
    const versionId = String((job.payload as { version_id?: string }).version_id ?? '');
    if (!versionId) return;
    await runExtraction(getFilesService(), versionId);
  });
}

/** 启动时补跑：把库里 pending 的抽取重新入队（Worker 重启可恢复） */
export async function recoverExtractions() {
  startExtractionWorker();
  const svc = getFilesService();
  const pending = await svc.pendingExtractionVersions(500);
  for (const v of pending) scheduler.push('extraction', { version_id: v });
  return pending.length;
}
