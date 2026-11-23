// FlowMate · 开发模式启动器（PRD §21：本机启动 + 局域网访问，热更新，看日志方便）
// 三个进程：tsc -w（服务端编译）→ node --watch（API+Worker，8080）→ vite（5173，代理 /api 与 /api/live）
// 生产演示只需一条命令：pnpm build && pnpm start（8080 同时托管前端静态资源）
import { spawn } from 'node:child_process';
import process from 'node:process';

const port = process.env.FLOWMATE_PORT || '8080';
const devPort = process.env.FLOWMATE_DEV_PORT || '5173';
const children = [];

function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: 'pipe', shell: process.platform === 'win32', env: { ...process.env, ...env } });
  const tag = `[${name}]`;
  p.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}`).join('\n') + '\n'));
  p.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => `${tag}! ${l}`).join('\n') + '\n'));
  p.on('exit', (code) => console.log(`${tag} 退出（${code}）`));
  children.push(p);
  return p;
}

console.log(`FlowMate 开发模式：API http://localhost:${port} · 前端 http://localhost:${devPort}`);
run('tsc', 'npx', ['tsc', '-p', 'tsconfig.server.json', '-w', '--preserveWatchOutput']);
run('api', 'node', ['--watch', '--enable-source-maps', 'dist/server/main.js']);
run('web', 'npx', ['vite', '--port', devPort, '--host']);

const stop = () => { for (const c of children) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
