// FlowMate · 探针基址护栏的单测
//
// 起因（真实事故）：各探针的环境变量名互不相同（PROBE_BASE / SHARE_BASE / SPACE_BASE / OPS_BASE /
// COVER_BASE / WORK_BASE / CHATMODE_BASE / E2E_BASE / SSR_BASE），漏传任意一个就会静默用默认的
// 8080 —— 也就是用户本机常驻实例与其线上库。实测确实因此把探针数据写进了用户真实数据。
// 这个测试钉住三件事：默认指向 8090、统一变量能整体覆盖、指向 8080 必须硬拒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { probeBase } from './probe-base.mjs';

const here = dirname(fileURLToPath(import.meta.url));

test('没有环境变量时默认打 8090 验证实例，不是 8080', () => {
  const saved = { ...process.env };
  for (const k of ['PROBE_BASE', 'FLOWMATE_BASE', 'SHARE_BASE', 'SSR_BASE', 'ALLOW_8080']) delete process.env[k];
  try {
    assert.equal(probeBase(['SHARE_BASE']), 'http://127.0.0.1:8090/api/v1');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('统一变量 PROBE_BASE 能覆盖各探针各自的旧变量名', () => {
  const saved = { ...process.env };
  process.env.PROBE_BASE = 'http://127.0.0.1:8099/api/v1';
  try {
    assert.equal(probeBase(['COVER_BASE']), 'http://127.0.0.1:8099/api/v1');
  } finally {
    Object.assign(process.env, saved);
  }
});

test('专属变量优先于统一变量（保留原有逐个指定实例的能力）', () => {
  const saved = { ...process.env };
  process.env.PROBE_BASE = 'http://127.0.0.1:8099/api/v1';
  process.env.SHARE_BASE = 'http://127.0.0.1:8098/api/v1';
  try {
    assert.equal(probeBase(['SHARE_BASE']), 'http://127.0.0.1:8098/api/v1');
  } finally {
    Object.assign(process.env, saved);
  }
});

// 子进程跑一个只打印基址的小脚本：process.exit(2) 不能污染测试进程本身
const printBase = (env) => {
  const script = join(here, '.probe-base-child.mjs');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ...env } });
  return r;
};

test('指向 8080 的探针必须被拒绝（exit 2），且给出可读原因', () => {
  const r = printBase({ PROBE_BASE: 'http://localhost:8080/api/v1', ALLOW_8080: '' });
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stderr, /8080/);
  assert.match(r.stderr, /ALLOW_8080/);
});

test('确实要打 8080 时，ALLOW_8080=1 显式放行（不牺牲人工排障能力）', () => {
  const r = printBase({ PROBE_BASE: 'http://localhost:8080/api/v1', ALLOW_8080: '1' });
  assert.equal(r.status, 0, `期望放行，实际 exit ${r.status}；stderr=${r.stderr}`);
  assert.match(r.stdout, /8080/);
});
