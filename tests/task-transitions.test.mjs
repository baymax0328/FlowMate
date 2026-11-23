// C14 / 任务四段（创建→接收→负责→验收）+ 经手人链：状态机迁移合法性
// completed 只能由 review(approve) 产生；退回落到 ready_to_assign(带 returned 标记)；不存在自动通过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, TRANSITION_TABLE, STAGE_OF, statusLabel } from '../dist/server/modules/tasks/tasks.service.js';

test('合法迁移：草稿→指派→接收→开始→交接→验收', () => {
  assert.equal(canTransition('draft', 'assign'), true, '草稿可直接指派');
  assert.equal(canTransition('ready_to_assign', 'assign'), true, '待指派 / 退回后的草稿也可指派');
  assert.equal(canTransition('pending_accept', 'accept'), true);
  assert.equal(canTransition('accepted', 'submit'), true, '接收后可直接交付');
  assert.equal(canTransition('in_progress', 'submit'), true);
  assert.equal(canTransition('in_progress', 'handoff_next'), true, '负责阶段可下游交接');
  assert.equal(canTransition('pending_review', 'review'), true);
  assert.equal(canTransition('pending_review', 'reassign'), true);
});

test('非法迁移一律拒绝（跳过阶段 / 越界动作）', () => {
  assert.equal(canTransition('draft', 'accept'), false, '草稿不能直接接收');
  assert.equal(canTransition('ready_to_assign', 'accept'), false, '未指派不能接收');
  assert.equal(canTransition('pending_review', 'submit'), false, '待验收不能提交产物');
  assert.equal(canTransition('pending_review', 'handoff_next'), false, '待验收只能验收或重新指派');
  assert.equal(canTransition('pending_review', 'accept'), false);
  assert.equal(canTransition('completed', 'accept'), false);
  assert.equal(canTransition('cancelled', 'publish'), false);
  assert.equal(canTransition('draft', 'review'), false);
});

test('退回落到待指派（带 returned 标记，回到创建人「创建」tab）', () => {
  assert.equal(canTransition('pending_accept', 'reject'), true, '退回 → 待指派');
  assert.equal(canTransition('pending_accept', 'accept'), true, '接收 → 负责');
});

test('取消：未完成可取消；转派只在负责阶段', () => {
  for (const s of ['draft', 'ready_to_assign', 'pending_accept', 'accepted', 'in_progress', 'pending_transfer', 'pending_review']) {
    assert.equal(canTransition(s, 'cancel'), true, `${s} 应可取消`);
  }
  assert.equal(canTransition('completed', 'cancel'), false);
  assert.equal(canTransition('accepted', 'transfer'), true);
  assert.equal(canTransition('pending_review', 'transfer'), false, '待验收不可转派');
});

test('阶段映射：四段（create/receive/work/review）', () => {
  assert.equal(STAGE_OF.draft, 'create');
  assert.equal(STAGE_OF.ready_to_assign, 'create');   // 待指派 + 退回后的草稿都在「创建」
  assert.equal(STAGE_OF.pending_accept, 'receive');
  assert.equal(STAGE_OF.accepted, 'work');
  assert.equal(STAGE_OF.in_progress, 'work');
  assert.equal(STAGE_OF.pending_transfer, 'work');
  assert.equal(STAGE_OF.pending_review, 'review');
  assert.equal(STAGE_OF.completed, 'done');
});

test('动作表未出现「超时自动通过」这类路径', () => {
  const actions = Object.keys(TRANSITION_TABLE);
  assert.equal(actions.some((a) => /auto|timeout|force/i.test(a)), false, '不允许自动通过或强制通过动作');
  assert.equal(actions.includes('complete'), false, 'completed 只能由 review(approve) 产生');
  assert.ok(statusLabel('pending_review') === '待验收');
});
