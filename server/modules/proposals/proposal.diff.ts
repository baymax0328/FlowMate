// FlowMate · 共同确认差异生成与签名哈希（PRD §11.2 / §16「共同确认正式修改」/ §23 C10/C11）
// 三种差异模式，诚实分级，绝不假装能比对无文本层的正文：
//   text —— markdown/text/html：对原件文本做 unified diff（首版可在线编辑的类型）。
//   body —— word/excel/ppt 及有文本层的 pdf：对「抽取正文」做 diff，并显式标注原文件将整体替换。
//   meta —— 无文本层（扫描版 pdf）/图片等：只能给元信息级差异（整体替换 + 大小/哈希变化），不显示正文差异。
import * as Diff from 'diff';
import { createHash } from 'node:crypto';

export type DiffMode = 'text' | 'body' | 'meta';

export interface DiffStats { added: number; removed: number }

export interface BuiltDiff {
  mode: DiffMode;
  patch: string;           // 存入 proposals.diff（签名固定到此文本）
  stats: DiffStats;
  note: string | null;     // 面向用户的诚实说明（写入卡片/详情）
  comparable: boolean;     // meta = false（正文不可比对）
}

export const EDITABLE_KINDS = ['markdown', 'text', 'html'];
/** 有文本层即可做正文级 diff 的类型；image 永远走 meta */
export const BODY_DIFFABLE_KINDS = ['word', 'excel', 'ppt', 'pdf'];

/** 规范化：换行统一 \n、去行尾空白、丢弃时间戳类噪声行（保证 diff_hash 稳定，C10 重复点击口径一致） */
export function normalizeDiff(text: string): string {
  const noise = /^\s*(date|timestamp|index:|=== .* ===)\b.*$/i;
  const tsLine = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?/;
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !noise.test(line) && !(tsLine.test(line) && !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@')))
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n');
}

/** 由 structuredPatch 结果渲染 unified diff 文本（不引入时间戳，保证可复现）+ 统计增删行 */
function renderPatch(oldLabel: string, newLabel: string, pd: Diff.ParsedDiff): { patch: string; stats: DiffStats } {
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  let added = 0;
  let removed = 0;
  for (const h of pd.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const line of h.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
      out.push(line);
    }
  }
  return { patch: out.join('\n'), stats: { added, removed } };
}

/** 文本级 unified diff（markdown/text/html） */
export function buildTextDiff(oldText: string, newText: string, oldLabel: string, newLabel: string): BuiltDiff {
  const pd = Diff.structuredPatch(oldLabel, newLabel, oldText ?? '', newText ?? '', '', '', { context: 3 });
  const { patch, stats } = renderPatch(oldLabel, newLabel, pd);
  return { mode: 'text', patch, stats, note: null, comparable: true };
}

/** 正文级 diff（不可在线编辑但有文本层）：显式标注整体替换 */
export function buildBodyDiff(oldBody: string, newBody: string, oldLabel: string, newLabel: string): BuiltDiff {
  const pd = Diff.structuredPatch(oldLabel, newLabel, oldBody ?? '', newBody ?? '', '', '', { context: 3 });
  const { patch, stats } = renderPatch(oldLabel, newLabel, pd);
  const banner = '目标为首版不支持在线编辑的类型，以下为正文级差异，原文件将整体替换为新版本（二进制/版式差异不在此呈现）。';
  return { mode: 'body', patch: `# ${banner}\n${patch}`, stats, note: banner, comparable: true };
}

/** 元信息级提案（无文本层：扫描版 PDF / 图片等）：诚实说明「正文不可比对，整体替换」+ 大小/哈希变化 */
export function buildMetaDiff(meta: {
  targetName: string;
  base: { versionNo: number; size: number; sha256: string };
  proposed: { versionNo: number; size: number; sha256: string };
  reason: string | null;
}): BuiltDiff {
  const sizeDelta = meta.proposed.size - meta.base.size;
  const patch = [
    `元信息级差异（正文不可比对）`,
    `目标：${meta.targetName}`,
    `原因：${meta.reason ?? '该类型无可抽取文本层（如扫描版 PDF / 图片）'}`,
    `处理：正式提交将以整体替换方式产生新版本，旧版本作为历史保留、可下载、不可被覆盖。`,
    `- base 版本 v${meta.base.versionNo}  大小 ${meta.base.size} 字节  sha256 ${meta.base.sha256}`,
    `+ 提案版本 v${meta.proposed.versionNo}  大小 ${meta.proposed.size} 字节  sha256 ${meta.proposed.sha256}`,
    `  大小变化 ${sizeDelta >= 0 ? '+' : ''}${sizeDelta} 字节；哈希由 ${meta.base.sha256.slice(0, 12)} 变为 ${meta.proposed.sha256.slice(0, 12)}`,
    `说明：本提案不提供正文级差异视图（不得假装能显示正文差异）。请在客户端下载两版原件自行比对后再决定是否确认。`,
  ].join('\n');
  return { mode: 'meta', patch, stats: { added: 0, removed: 0 }, note: '正文不可比对，元信息级整体替换提案', comparable: false };
}

const sortUniq = (ids: string[]): string[] => Array.from(new Set(ids)).sort();

/**
 * diff_hash（签名的核心口径，精确到字段）：
 *   sha256( 规范化 unified diff + base_version_id + target_file_id + instruction_ids(排序去重) + required_approvers(排序去重) )
 * 任一字段变化都会改变签名 → 旧签名无法批准新内容（C11）。
 */
export function computeDiffHash(inp: {
  patch: string; baseVersionId: string; targetFileId: string;
  instructionIds: string[]; requiredApprovers: string[];
}): string {
  const canon = JSON.stringify({
    patch: normalizeDiff(inp.patch),
    base_version_id: inp.baseVersionId,
    target_file_id: inp.targetFileId,
    instruction_ids: sortUniq(inp.instructionIds),
    required_approvers: sortUniq(inp.requiredApprovers),
  });
  return createHash('sha256').update(canon).digest('hex');
}

/** signed_for_hash：把签名再固定到 revision（同一 diff_hash 跨 revision 也不复用） */
export function computeSignedHash(diffHash: string, revision: number): string {
  return createHash('sha256').update(`${revision}:${diffHash}`).digest('hex');
}
