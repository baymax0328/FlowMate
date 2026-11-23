// 回归测试：AI 记账字段 provider 必须写「实际在用的是谁家模型」，不得再一律写死成笼统的协议名
// 钉住 2026-11-06 的改动：server/adapters/model.adapter.ts 的 providerLabel()
// 运行：pnpm test（node --test "tests/*.test.mjs"）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 只取模块，不触发 getDb()（懒加载），因此不会打开或写入任何数据库
const { config } = require('../dist/server/core/config.js');
const { providerLabel } = require('../dist/server/adapters/model.adapter.js');

// 用例：[MODEL_BASE_URL, 期望 provider]
const CASES = [
  ['https://api.deepseek.com', 'deepseek'],
  ['https://api.deepseek.com/v1', 'deepseek'],
  ['https://api.deepseek.com/v1/chat/completions', 'deepseek'],
  ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'dashscope'],
  ['https://api.moonshot.cn/v1', 'moonshot'],
  ['https://open.bigmodel.cn/api/paas/v4', 'zhipu'],
  ['https://ark.cn-beijing.volces.com/api/v3', 'volc-ark'],
  ['https://my-gateway.example.net/v1', 'my-gateway'],
  ['http://127.0.0.1:8000/v1', 'custom-gateway'],
  ['http://localhost:11434/v1', 'custom-gateway'],
  ['', 'unconfigured'],
];

test('providerLabel 按网关域名给出真实服务商，认不出时记 custom-gateway', () => {
  const original = config.model.baseUrl;
  try {
    for (const [baseUrl, want] of CASES) {
      config.model.baseUrl = baseUrl;
      assert.equal(providerLabel(), want, `MODEL_BASE_URL=${baseUrl || '(空)'} 应记为 ${want}`);
    }
  } finally {
    config.model.baseUrl = original;
  }
});

test('provider 标签不再返回笼统协议名（DeepSeek 场景）', () => {
  const original = config.model.baseUrl;
  try {
    config.model.baseUrl = 'https://api.deepseek.com';
    const got = providerLabel();
    assert.equal(got, 'deepseek', 'DeepSeek 网关必须记成 deepseek');
    assert.equal(got, 'deepseek');
  } finally {
    config.model.baseUrl = original;
  }
});
