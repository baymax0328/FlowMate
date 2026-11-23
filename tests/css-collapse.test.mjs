// FlowMate · 右栏收起的 CSS 层叠回归
// 起因：Task / Center 右栏「收起失败」。我把 .paneled.detail-only.detail-closed（1 列）
// 写在了 .paneled.detail-only.detail-wide（两栏 400px）之前 —— 两条同为 3 个类名、特异度相同，
// 于是后写的赢，收起后仍然留着一条 400px 空列。这类错误肉眼看不出来，SSR 也测不出来（Node 不算层叠），
// 所以这里直接对**构建产物里真正下发给浏览器的那份 CSS** 做层叠计算。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ASSETS = path.resolve('dist/client/assets');

function builtCss() {
  if (!fs.existsSync(ASSETS)) return null;
  const f = fs.readdirSync(ASSETS).filter((n) => n.endsWith('.css')).sort()[0];
  return f ? { file: f, css: fs.readFileSync(path.join(ASSETS, f), 'utf8') } : null;
}

/** 只处理 `.a.b { prop: v }` 这种简单复合选择器（本项目栅格规则都在这个子集里） */
function rules(css, prop) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (!sel || sel.includes('@') || sel.includes(',')) continue;
    const dm = new RegExp(`${prop}\\s*:\\s*([^;]+)`).exec(m[2]);
    if (!dm) continue;
    const parts = sel.split(/\s+/).filter(Boolean);
    if (!parts.every((p) => /^\.[\w-]+(\.[\w-]+)*$/.test(p))) continue;   // 只认纯类名组合（含后代选择器里的最后一段之外的一律跳过）
    if (parts.length !== 1) continue;                                      // 组合后代选择器（.paneled .detail）不参与栅格列数
    out.push({
      sel,
      classes: sel.slice(1).split('.'),
      value: dm[1].trim(),
      spec: sel.slice(1).split('.').length,
      at: m.index,
    });
  }
  return out;
}

/** 浏览器层的赢家：特异度最高；同特异度取源码里靠后的 */
function winner(list, classString) {
  const have = new Set(classString.split(/\s+/));
  const hits = list.filter((r) => r.classes.every((c) => have.has(c)));
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.spec > a.spec || (b.spec === a.spec && b.at > a.at) ? b : a));
}

const norm = (v) => String(v).replace(/\s+/g, ' ').trim();
/** 单列的写法只有一种：一个轨道值（minmax(0,1fr) 这种带逗号的算一个轨道） */
const isOneCol = (v) => colCount(v) === 1;
/** 按顶层空格切轨道：括号内的空格不算分隔（vite 压缩后 minmax(0,1fr) 里连空格都没有） */
function colCount(value) {
  const s = norm(value);
  let depth = 0; let n = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ' ' && depth === 0) { if (cur) n++; cur = ''; continue; }
    cur += ch;
  }
  if (cur) n++;
  return n;
}

test('构建产物里有 CSS 可测', () => {
  assert.ok(builtCss(), '未找到 dist/client/assets/*.css（先跑 vite build 再测）');
});

test('Task / Center（detail-only + detail-wide）收起后回到单列', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const list = rules(b.css, 'grid-template-columns');
  const open = winner(list, 'paneled detail-only detail-wide');
  const closed = winner(list, 'paneled detail-only detail-wide detail-closed');
  assert.ok(open, '展开态应有两栏规则');
  assert.equal(colCount(open.value), 2, `展开态应两栏，实际「${open.value}」`);
  assert.ok(closed, '收起态应命中一条规则');
  assert.ok(isOneCol(closed.value), `收起态必须单列，实际赢家是 ${closed.sel}{${closed.value}}`);
});

test('不带 detail-wide 的 detail-only 收起同样单列', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const list = rules(b.css, 'grid-template-columns');
  const closed = winner(list, 'paneled detail-only detail-closed');
  assert.ok(closed && isOneCol(closed.value), `实际赢家 ${closed?.sel} { ${closed?.value} }`);
});

test('三栏页（with-detail）展开三栏、收起两栏', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const list = rules(b.css, 'grid-template-columns');
  const open = winner(list, 'paneled with-detail');
  const closed = winner(list, 'paneled with-detail detail-closed');
  assert.equal(colCount(open.value), 3, `展开应三栏，实际「${open.value}」`);
  assert.equal(colCount(closed.value), 2, `收起应两栏（侧栏 + 工作面），实际「${closed.value}」`);
});

test('导航栏可收成图标态：只改列宽变量，不是把导航删掉', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const css = b.css.replace(/\s+/g, ' ');
  assert.match(css, /\.shell\.nav-min\{grid-template-columns:var\(--nav-w-min\) 1fr\}/,
    '收起态应该是「窄列宽」而不是 display:none');
  assert.match(css, /--nav-w-min:\s*68px/, '图标态宽度变量要在');
  // 收起时只隐藏文字，图标与品牌标必须留下
  assert.match(css, /\.nav-min \.nav-name[^}]*display:none/, '文字收成时隐藏标签文字');
  assert.ok(!/\.nav-min \.nav\{display:none/.test(css), '不允许整条导航被隐藏');
  assert.match(css, /\.nav-min \.nav-item\{justify-content:center/, '图标态要把图标居中');
});

test('列宽拖拽把手存在，且窄屏（抽屉形态）下不参与拖宽', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const css = b.css.replace(/\s+/g, ' ');
  assert.match(css, /\.col-resizer\{[^}]*cursor:col-resize/, '把手要有 col-resize 光标');
  assert.match(css, /\.side\{[^}]*position:relative/, '把手靠 .side 相对定位压在边界上');
  assert.match(css, /\.col-resizer\{display:none\}/, '窄屏 .side 是抽屉，把手要隐藏');
});

test('右栏收起规则仍排在加宽规则之后（防回归）', () => {
  const b = builtCss(); if (!b) return assert.skip('dist 未构建');
  const list = rules(b.css, 'grid-template-columns');
  const closed = list.find((r) => r.sel === '.paneled.detail-only.detail-closed');
  const wide = list.find((r) => r.sel === '.paneled.detail-only.detail-wide');
  assert.ok(closed && wide, '两条规则都得在');
  assert.equal(wide.spec, closed.spec, '两条同为 3 类名，特异度相同——只能靠源码顺序');
  assert.ok(closed.at > wide.at, '.detail-closed 必须写在 .detail-wide 后面，否则收起会被加宽规则盖回去');
});
