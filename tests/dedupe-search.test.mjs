// C02 / C17：正文分词检索（中文二元组 + FTS5）与候选任务去重键
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tokenize, buildMatch, hasQuery, snippetFor, fingerprint } from '../dist/server/core/tokens.js';
import { dedupeKeyFor } from '../dist/server/modules/discovery/discovery.service.js';

test('中文按二元组切分，ASCII 整词保留', () => {
  const t = tokenize('FlowMate 客户门户验收');
  assert.ok(t.includes('flowmate'), '英文词应小写整词入索引');
  assert.ok(t.includes('客户') && t.includes('门户') && t.includes('户门'), '连续汉字应产生二元组');
  assert.equal(hasQuery('   '), false, '空输入不应发起查询');
});

test('FTS5 倒排可以命中中文词并回原句取片段', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(tokens, id UNINDEXED)');
  const rows = [
    ['1', '虎牙在下周三之前完成客户门户权限矩阵文档'],
    ['2', '数据看板的首屏指标口径已冻结'],
    ['3', '陈奕迅本周五前给出三套配色方向的视觉情绪板'],
  ];
  for (const [id, text] of rows) db.prepare('INSERT INTO t VALUES (?,?)').run(tokenize(text).join(' '), id);
  const hit = db.prepare('SELECT id FROM t WHERE t MATCH ? ORDER BY bm25(t)').all(buildMatch('权限矩阵'));
  assert.deepEqual(hit.map((r) => String(r.id)), ['1'], '应只命中含「权限矩阵」的那条');
  const snip = snippetFor(rows[0][1], '权限矩阵');
  assert.ok(snip && snip.text.includes('权限矩阵') && snip.hits.length >= 1, '片段应含命中文本与偏移');
  assert.equal(snippetFor(rows[1][1], '权限矩阵'), null, '没命中就返回空，不得编造片段');
});

test('证据回锚：片段必须能在原文里定位（§14.3）', () => {
  const source = '大白伟负责在下个月内完成验收标准的补充，逐项写清可判定的通过条件。';
  const ok = snippetFor(source, '完成验收标准的补充');
  assert.ok(ok, '逐字引用的证据应能定位');
  assert.equal(snippetFor(source, '季度预算表重构排期'), null, '原文里没有的表述不得成为证据');
  assert.ok(source.includes('完成验收标准的补充'), '证据必须能在抽取正文里逐字命中');
});

test('去重键：同一文件同一版本同一行动项稳定，任一变化即不同', () => {
  const k = (over = {}) => dedupeKeyFor(over.file ?? 'file-1', over.ver ?? 'v3', over.block ?? 'b2',
    over.title ?? '整理权限矩阵', over.deliverable ?? '文档');
  assert.equal(k(), k());
  assert.notEqual(k(), k({ file: 'file-2' }), '来源文件不同应视为不同候选');
  assert.notEqual(k(), k({ ver: 'v4' }), '文件版本变化应允许重新提取');
  assert.notEqual(k(), k({ title: '整理权限矩阵并补充口径' }));
  assert.notEqual(k({ deliverable: '文档' }), k({ deliverable: '表格' }));
});

test('行动项指纹忽略标点与空白差异', () => {
  assert.equal(fingerprint('整理 权限矩阵！'), fingerprint('整理权限矩阵'), '同义书写不应产生两个候选');
  assert.notEqual(fingerprint('整理权限矩阵'), fingerprint('输出视觉情绪板'));
});
