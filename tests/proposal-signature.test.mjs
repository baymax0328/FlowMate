// C10 / C11 / §11.2：共同确认的签名口径 —— 内容、基准、指令集合或确认人集合任一变化，旧签名必须不可复用
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDiffHash, computeSignedHash, normalizeDiff, buildTextDiff, buildBodyDiff, buildMetaDiff,
} from '../dist/server/modules/proposals/proposal.diff.js';

const base = {
  patch: '--- 需求说明书-v1.md\n+++ 需求说明书-v1.md\n@@ -1,2 +1,2 @@\n-旧\n+新',
  baseVersionId: 'ver-A',
  targetFileId: 'file-1',
  instructionIds: ['req-1'],
  requiredApprovers: ['user-a', 'user-b'],
};
const h = (over = {}) => computeDiffHash({ ...base, ...over });

test('相同输入得到相同哈希（签名可复算）', () => {
  assert.equal(h(), h());
});

test('差异内容变化 → 哈希变化（旧签名不可用于新内容）', () => {
  assert.notEqual(h(), h({ patch: `${base.patch}\n+又多一行` }));
});

test('基准版本变化 → 哈希变化（必须重新生成差异再确认）', () => {
  assert.notEqual(h(), h({ baseVersionId: 'ver-B' }));
});

test('相关指令集合变化 → 哈希变化（新增受影响的人要重审）', () => {
  assert.notEqual(h(), h({ instructionIds: ['req-1', 'req-2'] }));
});

test('确认人集合变化 → 哈希变化（不能靠移除未同意者凑通过）', () => {
  assert.notEqual(h(), h({ requiredApprovers: ['user-a'] }));
  assert.notEqual(h(), h({ requiredApprovers: ['user-a', 'user-c'] }));
});

test('集合顺序不影响哈希（同一组人同一组指令算同一个签名对象）', () => {
  assert.equal(h({ instructionIds: ['req-1'], requiredApprovers: ['user-b', 'user-a'] }), h());
  assert.equal(h({ instructionIds: ['req-1', 'req-1'], requiredApprovers: ['user-a', 'user-b', 'user-b'] }), h(), '重复项与顺序都不应改变签名');
});

test('目标文件不同 → 哈希不同（不会串到别的文件上）', () => {
  assert.notEqual(h(), h({ targetFileId: 'file-2' }));
});

test('签名绑定提案版本：r1 的签名不等于 r2 的签名', () => {
  const hash = h();
  assert.notEqual(computeSignedHash(hash, 1), computeSignedHash(hash, 2));
  assert.equal(computeSignedHash(hash, 3), computeSignedHash(hash, 3));
});

test('差异规范化：CRLF 与行尾空白不产生假差异', () => {
  const crlf = base.patch.replace(/\n/g, '\r\n');
  assert.equal(normalizeDiff(crlf), normalizeDiff(base.patch));
  assert.equal(normalizeDiff(`${base.patch}   `), normalizeDiff(base.patch), '行尾空白应被规范化掉');
});

test('文本类出 unified diff 并统计增删', () => {
  const d = buildTextDiff('第一行\n第二行\n', '第一行\n第二行改了\n第三行\n', 'v1', 'v2');
  assert.match(d.patch, /^--- v1/m);
  assert.ok(d.stats.added >= 1, `added=${d.stats.added}`);
  assert.ok(d.stats.removed >= 1, `removed=${d.stats.removed}`);
});

test('Office 类给正文级差异并明说整体替换', () => {
  const d = buildBodyDiff('旧正文', '新正文', 'v1', 'v2');
  assert.match(d.patch, /整体替换|正文级/);
});

test('无文本层用元信息差异，不假装能比对正文', () => {
  const d = buildMetaDiff({
    targetName: '旧版合同扫描件.pdf',
    base: { versionNo: 1, size: 100, sha256: 'a'.repeat(64) },
    proposed: { versionNo: 2, size: 220, sha256: 'b'.repeat(64) },
    reason: '扫描版 PDF 无文本层',
  });
  assert.match(d.patch, /元信息级差异（正文不可比对）/);
  assert.match(d.patch, /整体替换/);
  assert.doesNotMatch(d.patch, /旧正文|新正文/);
});
