// C08 / §8.3：路径边界与文件名净化（不信任任何客户端或模型给的路径）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveLogicalPath, sanitizeName, assertInsideDir, wouldCreateCycle } from '../dist/server/core/paths.js';

test('绑定目录内的正常逻辑路径可以通过', () => {
  assert.deepEqual(resolveLogicalPath('客户门户改版/需求说明书-v1.md'), ['客户门户改版', '需求说明书-v1.md']);
  assert.deepEqual(resolveLogicalPath('\\a\\b'), ['a', 'b'], '反斜杠同样按分隔符处理');
  assert.deepEqual(resolveLogicalPath('./a//b'), ['a', 'b']);
});

test('../ 上跳被拒绝，且错误码与说明符合规格', () => {
  assert.throws(() => resolveLogicalPath('../etc/passwd'), (e) => e.code === 'FORBIDDEN' && e.message.includes('绑定'));
  assert.throws(() => resolveLogicalPath('a/../../b'), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => resolveLogicalPath('a\0b'), (e) => e.code === 'FORBIDDEN');
});

test('文件名净化：保留名加前缀、去分隔符、空名回落、超长截断', () => {
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('nul.txt'), '_nul.txt');
  assert.match(sanitizeName('a/b\\c:d*?'), /^[^/\\:]+$/);
  assert.equal(sanitizeName('   '), '未命名');
  assert.match(sanitizeName('../逃逸'), /逃逸/);
  assert.ok(sanitizeName('x'.repeat(400)).length <= 180);
});

test('磁盘对象键不能逃出存储根', () => {
  const root = path.resolve('C:\\tmp-root');
  assert.equal(assertInsideDir(root, path.join(root, 'a', 'b')), path.join(root, 'a', 'b'));
  assert.throws(() => assertInsideDir(root, path.resolve('C:\\other')), (e) => e.code === 'FORBIDDEN');
  assert.throws(() => assertInsideDir(root, path.join(root, '..', 'escape')), (e) => e.code === 'FORBIDDEN');
  assert.equal(assertInsideDir(root, root), root, '存储根本身允许');
});

test('目录移动时的 parent 循环检查', () => {
  const children = { a: ['b'], b: ['c'], c: [] };
  assert.equal(wouldCreateCycle('c', 'a', (id) => children[id] ?? []), true, '把 a 移到其后代 c 下应判为环');
  assert.equal(wouldCreateCycle('b', 'a', (id) => children[id] ?? []), true);
  assert.equal(wouldCreateCycle('a', 'a', () => []), true, '自身作为父级非法');
  assert.equal(wouldCreateCycle(null, 'a', () => []), false, '移到根目录合法');
});
