// 用 CDP 驱动 Edge 复现前端崩溃：登录后逐个页面点击真实控件，抓 window 异常与 console 错误
// 前提：Edge 以 --remote-debugging-port=9222 --user-data-dir=临时目录 启动（本脚本自己拉起）
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const WebSocket = require('ws');

const PORT = 9223;
const PROFILE = path.join(process.env.LOCALAPPDATA || process.env.TEMP, 'flowmate-cdp-profile');
const OUT = [];

function log(...a) { const line = a.join(' '); console.log(line); OUT.push(line); }

async function waitForTarget(timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('CDP 端口未就绪');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

(async () => {
  fs.mkdirSync(PROFILE, { recursive: true });
  const edge = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const args = [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--window-size=1440,900', 'about:blank'];
  spawn(edge, args, { detached: true, stdio: 'ignore' }).unref();

  const target = await waitForTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.on('message', (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errors.push(`EXCEPTION: ${d.exception?.description ?? d.text}`.split('\n').slice(0, 6).join('\n    '));
    }
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) {
      const e = m.params.entry;
      if (!/favicon|DevTools|Download the React/i.test(e.text ?? '')) errors.push(`CONSOLE[${e.level}]: ${String(e.text).slice(0, 300)}`);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(`console.error: ${(m.params.args ?? []).map((a) => String(a.value ?? a.description)).join(' ').slice(0, 300)}`);
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) return { err: r.result.exceptionDetails.exception?.description ?? 'eval error' };
    return { value: r.result?.result?.value };
  };
  const go = async (url) => { await send('Page.navigate', { url }); await new Promise((r) => setTimeout(r, 2600)); };

  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  const BASE = 'http://localhost:8080';

  // 1) 登录（页面内 fetch，Cookie 落在同一 profile）
  await go(BASE + '/login');
  const login = await evaluate(`(async()=>{const r=await fetch('/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','X-FlowMate-Client':'web'},body:JSON.stringify({email:'baymax@xingyu.test',password:'abc123'})});return r.status})()`);
  log('登录 HTTP', JSON.stringify(login));

  const steps = [
    ['Workspace 挂载', `${BASE}/workspace`, null],
    ['Workspace 切换到团队空间', null, "(() => { const b=[...document.querySelectorAll('.side .row-item')]; const t=b.find(x=>/团队空间/.test(x.textContent)); if(!t) return '未找到团队空间按钮:'+b.length; t.click(); return 'clicked'; })()"],
    ['Workspace 切换到组织空间', null, "(() => { const b=[...document.querySelectorAll('.side .row-item')]; const t=b.find(x=>/组织空间/.test(x.textContent)); t?.click(); return t?'clicked':'none'; })()"],
    ['Workspace 点文件行', null, "(() => { const b=[...document.querySelectorAll('table.grid tbody .btn-link')]; b[0]?.click(); return b.length+' 行, clicked '+(b[0]?.textContent??''); })()"],
    ['Workspace 收起/展开预览', null, "(() => { const g=(txt)=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===txt); g('收起')?.click(); const a=g('文件预览'); a?.click(); return (a?'ok':'未找到展开按钮'); })()"],
    ['Message 挂载', `${BASE}/message`, null],
    ['Message 点会话', null, "(() => { const b=[...document.querySelectorAll('.side .row-item')]; b[1]?.click(); return b.length+' 个会话'; })()"],
    ['Message 收起详情', null, "(() => { const b=[...document.querySelectorAll('.detail-head button')].find(x=>x.textContent.includes('收起')); b?.click(); return b?'clicked':'none'; })()"],
    ['Agent Personal 挂载', `${BASE}/agent/personal`, null],
    ['Agent 新建会话对话框', null, "(() => { const b=[...document.querySelectorAll('.side-head button')].find(x=>x.textContent.includes('新建')); b?.click(); return b?'opened':'none'; })()"],
    ['Agent 关闭对话框', null, "(() => { const b=[...document.querySelectorAll('.modal .close-x, .modal-foot button')].find(x=>/取消|关闭/.test(x.textContent)); b?.click(); return 'closed'; })()"],
    ['Agent Team 挂载', `${BASE}/agent/team`, null],
    ['Agent Center 挂载', `${BASE}/agent/center`, null],
    ['Center 点 Run 行', null, "(() => { const b=[...document.querySelectorAll('table.grid tbody .btn-link')]; b[0]?.click(); return b.length+' 行'; })()"],
    ['Center 收起运行详情', null, "(() => { const b=[...document.querySelectorAll('.detail-head button')].find(x=>x.textContent.includes('收起')); b?.click(); const cols=getComputedStyle(document.querySelector('.paneled')).gridTemplateColumns; return '收起后列宽: '+cols; })()"],
    ['Center 切 Changes/Conflicts/Events', null, "(() => { const t=[...document.querySelectorAll('.subtab')]; t[1]?.click(); t[2]?.click(); t[3]?.click(); return t.map(x=>x.textContent.trim()).join('|'); })()"],
    ['Task 挂载', `${BASE}/task`, null],
    ['Task 点任务卡', null, "(() => { const b=[...document.querySelectorAll('.exec')]; b[0]?.click(); return b.length+' 张卡'; })()"],
    ['Task 收起任务详情', null, "(() => { const b=[...document.querySelectorAll('.detail-head button')].find(x=>x.textContent.includes('收起')); b?.click(); const cols=getComputedStyle(document.querySelector('.paneled')).gridTemplateColumns; return '收起后列宽: '+cols; })()"],
    ['全局搜索 Ctrl+K 并输入', null, "(() => { window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true})); const i=document.querySelector('.modal input[type=search]'); if(!i) return '未打开搜索弹层'; const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; set.call(i,'验收'); i.dispatchEvent(new Event('input',{bubbles:true})); return 'typed'; })()"],
    ['搜索切分类标签', null, "(() => { const t=[...document.querySelectorAll('.modal .subtab')]; t.forEach(x=>x.click()); return t.length+' 个分类'; })()"],
    ['通知浮层', null, "(() => { const b=[...document.querySelectorAll('.top-actions button')].find(x=>x.textContent.includes('通知')); b?.click(); return b?'opened':'none'; })()"],
    ['组织切换浮层', null, "(() => { const b=[...document.querySelectorAll('.top-actions button')].find(x=>x.textContent.includes('组织')); b?.click(); const i=[...document.querySelectorAll('.pop-item')].find(x=>x.textContent.includes('汇川')); i?.click(); return 'switched'; })()"],
  ];

  for (const [name, url, expr] of steps) {
    if (url) await go(url);
    let result = '';
    if (expr) { const r = await evaluate(expr); result = r.err ? 'EVAL_ERR ' + String(r.err).slice(0, 120) : String(r.value); }
    const before = errors.length;
    await new Promise((r) => setTimeout(r, 1200));
    const fresh = errors.slice(before);
    log(`- ${name}${result ? ' → ' + result : ''}${fresh.length ? '\n    ' + fresh.join('\n    ') : ''}`);
  }

  log('\n合计捕获异常/错误', errors.length, '条');
  fs.writeFileSync('cdp-report.txt', OUT.join('\n'));
  ws.close();
  process.exit(0);
})().catch(async (e) => { log('脚本异常:', e.message); fs.writeFileSync('cdp-report.txt', OUT.join('\n')); process.exit(1); });
