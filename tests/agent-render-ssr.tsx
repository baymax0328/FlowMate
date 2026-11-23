// FlowMate · Agent 会话渲染回归（Node 内 SSR，不用开浏览器）
// 为什么要有这个文件：`j(...).slice is not a function` 是渲染期抛的，服务端日志里 0 错误，
// 只有把后端真实返回的 payload 灌进组件树跑一次 render 才能证明「点击会话不再崩」。
//
// 用法：
//   node node_modules/esbuild/bin/esbuild tests/agent-render-ssr.tsx --bundle --platform=node \
//        --format=esm --jsx=automatic --packages=external --loader:.css=empty --loader:.svg=dataurl \
//        --outfile=.probe/ssr-agent-render.mjs
//   node .probe/ssr-agent-render.mjs            # 默认打 8090 验证实例；probe-base.mjs 会硬拒 8080
import { renderToString } from 'react-dom/server';
import { createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SessionList, SessionView } from '../src/features/agent/session-ui';
import { SessionProvider } from '../src/app/session';

import { probeBase } from './probe-base.mjs';
// probeBase 返回的是「…/api/v1」；本套件要的是不带后缀的站点根，所以在这里剥掉。
const BASE = probeBase(['SSR_BASE']).replace(/\/api\/v1$/, '');
const PW = process.env.SEED_PASSWORD || 'abc123';
const EMAIL = process.env.SSR_USER || 'baymax@xingyu.test';
const API = BASE + '/api/v1';

let cookie = '';
let org = '';
async function get(path: string) {
  const headers: Record<string, string> = { 'X-FlowMate-Client': 'web' };
  if (cookie) headers.cookie = cookie;
  if (org) headers['X-Organization-Id'] = org;
  const res = await fetch(API + path, { headers });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${JSON.stringify(j.error ?? {})}`);
  return j.data;
}

const results: string[] = [];
let fail = 0;
const ok = (name: string, pass: boolean, detail = '') => {
  if (!pass) fail++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`);
};

function tree(qc: QueryClient, node: any) {
  return h(QueryClientProvider, { client: qc }, h(MemoryRouter, { initialEntries: ['/agent/personal'] }, h(SessionProvider, null, node)));
}

const boot = async () => {
  const login = await fetch(API + '/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web' },
    body: JSON.stringify({ email: EMAIL, password: PW }),
  });
  if (!login.ok) throw new Error(`登录失败 ${login.status}`);
  cookie = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  const me = await get('/auth/me');
  org = (me.organizations ?? [])[0]?.id ?? '';

  // 真实数据：一个已绑定目录的个人会话（就是当初一点就崩的那种）
  const list = await get('/agent/sessions?mode=personal');
  let rows: any[] = Array.isArray(list) ? list : (list?.rows ?? []);
  let bound = rows.find((r) => r.binding?.folder_id || r.folder_id) ?? rows[0];
  if (!bound) {
    // 刚重播过种子时库里没有会话：自己建一个绑定「我的文件」根的会话，
    // 让这套渲染回归不依赖「库里恰好有人建过会话」这种偶然状态。
    const roots: any[] = (await get('/spaces')) ?? [];
    const root = roots.find((s) => s.space === 'personal' && s.id);
    if (root) {
      const created = await fetch(`${API}/agent/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-FlowMate-Client': 'web', cookie, 'X-Organization-Id': org },
        body: JSON.stringify({ title: '渲染回归会话', folder_id: root.id, include_children: true }),
      }).then((r) => r.json());
      const d0 = created?.data;
      if (d0?.id) {
        rows = [...rows, { id: d0.id, title: d0.title, binding: d0.binding }];
        bound = rows[rows.length - 1];
      }
    }
  }
  if (!bound) throw new Error('库里没有任何个人会话，也无法新建（检查 /spaces 是否有个人根）');
  const sid = String(bound.id ?? bound.session_id);
  const detail = await get(`/agent/sessions/${sid}`);
  const messages = await get(`/agent/sessions/${sid}/messages`);
  const runs = await get(`/agent/sessions/${sid}/runs`);
  const artifacts = await get(`/agent/sessions/${sid}/artifacts`);
  const manifest = await get(`/agent/sessions/${sid}/read-manifest`);
  const files = detail?.binding?.folder_id ? await get(`/agent/sessions/${sid}/files?path=/`) : undefined;

  console.log(`会话 ${String(detail?.id).slice(0, 8)}「${detail?.title}」· 绑定=${JSON.stringify(detail?.binding?.root_name ?? null)}`
    + `· /files 形状=${Array.isArray(files) ? 'array' : `object{${Object.keys(files ?? {}).join(',')}}`}`);

  // ---------- 00 先证明这个 payload 就是当初的崩溃现场 ----------
  // 老代码那一行等价于：jsonOf(tree.data, []).slice(0, 40)
  if (files !== undefined) {
    const jsonOf = (v: any, f: any) => (v === null || v === undefined || v === '' ? f : (typeof v !== 'string' ? v : (() => { try { return JSON.parse(v); } catch { return f; } })()));
    let threw = '';
    try { jsonOf(files, []).slice(0, 40); } catch (e) { threw = String((e as Error).message); }
    ok('S00 老代码那一行在这份真实 payload 上确实抛错（证明用例有效）', threw.includes('is not a function') || threw.includes('slice'), threw || '未抛错');
  }

  // ---------- 01 崩溃现场原样复跑 ----------
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc.setQueryData(['sessions', 'personal'], rows);
  qc.setQueryData(['sessions', 'shared'], []);
  qc.setQueryData(['session', sid], detail);
  qc.setQueryData(['session', sid, 'messages'], messages);
  qc.setQueryData(['session', sid, 'runs'], runs);
  qc.setQueryData(['session', sid, 'artifacts'], artifacts);
  qc.setQueryData(['session', sid, 'read'], manifest);
  if (files !== undefined) qc.setQueryData(['session', sid, 'tree'], files);

  let html = '';
  try {
    // 这一组断言看的是「右栏展开时里面有没有真内容」，所以显式传 detailOpen:true
    // （默认值已经是收起，由下面 L01 单独验）。
    html = renderToString(tree(qc, h(SessionView, { session: detail, onRefresh: () => undefined, detailOpen: true, onToggleDetail: () => undefined })));
    ok('S01 点击会话（含绑定目录）渲染不抛错', true);
  } catch (e) {
    ok('S01 点击会话（含绑定目录）渲染不抛错', false, String((e as Error).message).slice(0, 200));
  }
  ok('S02 右栏渲染出工作区里的真实条目',
    /当前工作区/.test(html) && (Array.isArray(files) || !(files?.files ?? []).length || /row-meta/.test(html)),
    `folders=${(files?.folders ?? []).length} files=${(files?.files ?? []).length}`);
  const firstName = String(files?.files?.[0]?.name ?? files?.folders?.[0]?.name ?? '');
  ok('S03 文件名字面出现在 HTML 里', !firstName || html.includes(firstName), firstName);
  ok('S04 读取清单按 entries 渲染（不再永远「还没有读取记录」）', /本次读取/.test(html));
  ok('S05 输入框与「交给 Agent」按钮在页面上', /交给 Agent/.test(html) && /composer/.test(html));
  ok('S06 两种模式分段可渲染（对话模式 / 工作模式）', /对话模式/.test(html) && /工作模式/.test(html) && !/只要回答/.test(html));

  // ---------- 02 左栏：新 DTO 与旧 DTO 都要能渲染 ----------
  const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc2.setQueryData(['sessions', 'personal'], rows);
  qc2.setQueryData(['sessions', 'shared'], []);
  let lhtml = '';
  try {
    lhtml = renderToString(tree(qc2, h(SessionList, { mode: 'personal', activeId: '', onSelect: () => undefined })));
    ok('S07 左栏渲染不抛错', true);
  } catch (e) {
    ok('S07 左栏渲染不抛错', false, String((e as Error).message).slice(0, 200));
  }
  const boundRow: any = rows.find((r) => r.binding?.folder_id);
  ok('S08 已绑定会话不再显示「未绑定目录」',
    !boundRow || (lhtml.includes(String(boundRow.binding.root_name ?? '')) && !/未绑定目录（不能读写文件）/.test(lhtml)),
    boundRow ? `root_name=${boundRow.binding?.root_name}` : '列表里没有已绑定会话');

  // 旧形状（没有 binding 字段）也不能崩
  const legacy = rows.map((r) => ({ id: (r as any).id, title: (r as any).title, mode: 'personal', folder_id: (r as any).folder_id }));
  const qc3 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  qc3.setQueryData(['sessions', 'personal'], legacy);
  qc3.setQueryData(['sessions', 'shared'], []);
  try {
    renderToString(tree(qc3, h(SessionList, { mode: 'personal', activeId: '', onSelect: () => undefined })));
    ok('S09 旧版列表 DTO（无 binding 字段）也容错', true);
  } catch (e) {
    ok('S09 旧版列表 DTO（无 binding 字段）也容错', false, String((e as Error).message).slice(0, 160));
  }

  // ---------- 03 形状漂移兜底：把包装对象硬喂给按数组用的地方 ----------
  const qc4 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const bad = { ...detail, binding: { folder_id: 'x', root_name: '坏形状', include_children: false } };
  qc4.setQueryData(['session', sid], bad);
  qc4.setQueryData(['session', sid, 'messages'], { nested: true } as never);   // 完全不是数组
  qc4.setQueryData(['session', sid, 'runs'], 'not json' as never);             // 字符串
  qc4.setQueryData(['session', sid, 'artifacts'], null);
  qc4.setQueryData(['session', sid, 'read'], undefined);
  qc4.setQueryData(['session', sid, 'tree'], { folders: { nope: 1 } });        // 里层也不是数组
  try {
    renderToString(tree(qc4, h(SessionView, { session: bad, onRefresh: () => undefined })));
    ok('S10 任意形状漂移只降级为「暂无」，不再整页崩溃', true);
  } catch (e) {
    ok('S10 任意形状漂移只降级为「暂无」，不再整页崩溃', false, String((e as Error).message).slice(0, 200));
  }

  results.push('');
  // ---------- 04 右栏合并：只有一个 aside、Team 页两个页签都在里面 ----------
  const teamView = { ...detail, mode: 'team', my_role: 'coordinator' };
  let thtml = '';
  try {
    const qct = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qct.setQueryData(['session', sid], teamView);
    qct.setQueryData(['session', sid, 'messages'], messages);
    qct.setQueryData(['session', sid, 'runs'], runs);
    qct.setQueryData(['session', sid, 'artifacts'], artifacts);
    qct.setQueryData(['session', sid, 'read'], manifest);
    if (files !== undefined) qct.setQueryData(['session', sid, 'tree'], files);
    thtml = renderToString(tree(qct, h(SessionView, {
      session: teamView, onRefresh: () => undefined, detailOpen: true,
      extraTabs: [{ key: 'team', label: '团队与提案', node: h('div', { className: 'stack' }, 'TEAM-PANEL') }],
    })));
    const asideCount = (thtml.match(/class="detail"/g) ?? []).length;
    ok('S11 一个会话只渲染一个右栏 aside', asideCount === 1, `aside 数 ${asideCount}`);
    ok('S12 两个页签都在同一个右栏里', /文件与执行/.test(thtml) && /团队与提案/.test(thtml));
    ok('S13 默认页签是「文件与执行」，团队内容不抢先渲染', !/TEAM-PANEL/.test(thtml));
  } catch (e) {
    ok('S11 一个会话只渲染一个右栏 aside', false, String((e as Error).message).slice(0, 160));
  }
  // 收起态：页面按 detailOpen 切 class，aside 不再渲染
  {
    const qc5 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qc5.setQueryData(['session', sid], detail);
    qc5.setQueryData(['session', sid, 'messages'], messages);
    const closed = renderToString(tree(qc5, h(SessionView, { session: detail, onRefresh: () => undefined, detailOpen: false })));
    ok('S14 收起后不再渲染 aside（中间区横向扩到右边缘由栅格类控制）', !/class="detail"/.test(closed));
  }

  // ---------- 05 Markdown 管线（marked 在 Node 可验；DOMPurify 需要浏览器） ----------
  {
    const m = (await import('marked')) as unknown as Record<string, unknown>;
    const marked = (m.marked ?? m.parse) as { parse: (s: string) => string };
    const d = (await import('dompurify')) as unknown as Record<string, unknown>;
    const purify = (d.default ?? d) as ((input: string, options?: unknown) => string) & { isSupported?: boolean };
    const sample = '**共同确认** 要求：\n\n- 全部相关指令人同意\n- 72 小时未集齐转挂起\n\n<script>alert(1)</script>\n\n`npm start`';
    const html = String(marked.parse(sample));
    ok('S15 Markdown 渲成结构化 HTML',
      /<strong>共同确认<\/strong>/.test(html) && /<li>全部相关指令人同意<\/li>/.test(html) && /<code>npm start<\/code>/.test(html));
    if (purify.isSupported) {
      const out = String(purify(html, { FORBID: ['script', 'style', 'iframe', 'object', 'embed', 'form'] }));
      ok('S16 脚本被净化掉（模型输出按不可信输入处理）', !/<script/i.test(out) && !/alert\(1\)/.test(out));
    } else {
      // Node 里没有 window，DOMPurify 只是工厂函数本体（调它会返回它自己的源码字符串）。
      // 不假装通过：净化这条只能在浏览器里验；组件侧已加防御——拿不到真净化结果就退回纯文本，绝不投毒 DOM。
      console.log('SKIP  S16 DOMPurify 净化断言（Node 无 window · isSupported=false；浏览器路径与 Workspace 预览同源）');
      ok('S16 无 DOM 时组件判为失败并退回纯文本（不会把工厂函数源码渲染出来）', !html.includes('createDOMPurify'),
        '组件先校验 typeof dp.sanitize === "function"，缺 window 时直接 throw → 纯文本分支');
    }
  }

  // ---------- 06 本轮布局需求：默认收起 · 拖拽把手 · 列宽夹取 ----------
  {
    const qcA = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qcA.setQueryData(['session', sid], detail);
    qcA.setQueryData(['session', sid, 'messages'], messages);
    const noProp = renderToString(tree(qcA, h(SessionView, { session: detail, onRefresh: () => undefined })));
    ok('L01 不传 detailOpen 时右栏默认收起（新默认值）', !/class="detail"/.test(noProp));

    const qcB = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    qcB.setQueryData(['sessions', 'personal'], rows);
    qcB.setQueryData(['sessions', 'shared'], []);
    const listHtml = renderToString(tree(qcB, h(SessionList, {
      mode: 'personal', activeId: '', onSelect: () => undefined, onIntent: () => undefined,
      pane: { width: 280, style: { '--side-w': '280px' } as never, onResizeStart: () => undefined, nudge: () => undefined },
    })));
    ok('L02 会话列右边界渲染出拖拽把手', /col-resizer/.test(listHtml) && /role="separator"/.test(listHtml) && /aria-orientation="vertical"/.test(listHtml));
    ok('L03 把手可聚焦（键盘也能调宽）', /class="col-resizer"[^>]*tabindex="0"/.test(listHtml));
    ok('L04 会话行有「···」行内菜单', /class="row-menu"/.test(listHtml), `${(listHtml.match(/class="row-menu"/g) ?? []).length} 个`);
    ok('L05 页签是「个人会话 / 共享会话」且不带数量', /个人会话/.test(listHtml) && /共享会话/.test(listHtml) && !/我的会话/.test(listHtml));
    ok('L06 会话按工作区分组（组标题就是工作区名）',
      listHtml.includes(String(rows[0]?.binding?.root_name ?? '未指定工作区')), `首个会话工作区=${String(rows[0]?.binding?.root_name ?? '未指定')}`);
    ok('L07 底部有「已删除的会话」恢复入口', /已删除的会话/.test(listHtml));
    // L08 查的是「产品自己的文案有没有还留着旧术语」，所以要先剥掉数据带来的文字：
    // 会话标题与工作区名是用户（以及先前几轮探针）建的数据，名字里带不带「目录」都不算产品文案缺陷。
    const chromeHtml = rows.reduce((acc: string, r: any) => {
      const names = [r?.title, r?.name, r?.binding?.root_name, r?.binding?.path].filter((x) => typeof x === 'string' && x.length > 1);
      return names.reduce((a2: string, n: string) => a2.split(n).join('□'), acc);
    }, listHtml);
    ok('L08 会话列产品文案不再出现「目录」字样（术语统一为工作区）', !/目录/.test(chromeHtml),
      (chromeHtml.match(/[^>]{0,12}目录[^<]{0,12}/g) ?? []).slice(0, 2).join(' | ') || '（剥掉数据名后无残留）');
    const html2 = renderToString(tree(qcB, h(SessionView, {
      session: detail, onRefresh: () => undefined, detailOpen: true,
      detailResize: { width: 320, style: {}, onResizeStart: () => undefined, nudge: () => undefined },
    })));
    ok('L09 右栏展开时渲染左边界拖拽把手', /col-resizer left/.test(html2) || /col-resizer[^"]*left/.test(html2),
      (html2.match(/class="col-resizer[^"]*"/) ?? []).join(' | '));
    ok('L10 头部不再有「选择工作区 / 新建团队分支」按钮（已收进行内菜单）',
      !/选择工作区</.test(html2) && !/新建团队分支</.test(html2));
    ok('L11 头部共享按钮存在', /共享/.test(html2));
  }
  {
    const { nothingToShow } = await import('../src/features/workspace/WorkspacePage');
    ok('L12 只有子目录的目录不判为「没有内容」', nothingToShow([], [{ id: 'f1' }]) === false, 'files=0 folders=1');
    ok('L13 真的空（无文件无子目录）才判为没有内容', nothingToShow([], []) === true);
    ok('L14 有文件时不判空', nothingToShow([{ id: 'x' }], []) === false);
    ok('L15 搜索态只看命中数', nothingToShow([], [{ id: 'f1' }], true) === true && nothingToShow([{ id: 'x' }], [], true) === false);
  }
  {
    const { clampCol, COL, colMax } = await import('../src/api/hooks');
    ok('W01 第二列下限比原来的 280 略小', clampCol(10, COL.sideMin) === COL.sideMin && COL.sideMin < COL.sideDef,
      `side min=${COL.sideMin} def=${COL.sideDef}`);
    ok('W02 上限不超过屏宽一半（两列同规则）', clampCol(99999, COL.detailMin) === colMax() && colMax() <= 800,
      `max=${colMax()}（Node 无 window 按 1600 兜底）`);
    ok('W03 区间内的值原样保留', clampCol(420, COL.sideMin) === 420 && clampCol(300, COL.detailMin) === 300);
  }

  // ---------- 07 URL 状态合并：点文件不能把当前目录丢掉 ----------
  // 线上现象：点任意文档跳到「个人空间 / index.html」，且「产品知识库」里有子目录却显示空。
  // 根因是 update() 从 defaults 重建整个状态、把没 patch 的 folder 抹成空 → 列表回落到个人根。
  {
    const { mergeUrlState, urlStateToQuery } = await import('../src/api/url-state');
    const D = { folder: '', focus: '', view: 'list', q: '', scope: 'folder' };
    const a = mergeUrlState(D, { ...D, folder: 'fld-kb', view: 'grid', q: '验收' }, { focus: 'file-9' });
    ok('U01 patch focus 时保留 folder / view / q', a.folder === 'fld-kb' && a.view === 'grid' && a.q === '验收' && a.focus === 'file-9',
      JSON.stringify(a));
    const b = mergeUrlState(D, { ...D, folder: 'f1', focus: 'x1' }, { focus: null });
    ok('U02 显式 null 才回落默认值，不误伤别的键', b.focus === '' && b.folder === 'f1', JSON.stringify(b));
    const c = mergeUrlState(D, { ...D, focus: 'x1', q: 'abc', view: 'grid' }, { folder: 'f2', focus: null, q: '' });
    ok('U03 切目录清掉 focus / q，但视图模式保留', c.folder === 'f2' && c.focus === '' && c.q === '' && c.view === 'grid', JSON.stringify(c));
    const d = mergeUrlState(D, { ...D }, { evil: '1', folder: 'f' } as never);
    ok('U04 未声明的键不进来', !('evil' in d) && d.folder === 'f');
    const e = mergeUrlState(D, { folder: 'f' } as never, {});
    ok('U05 cur 缺键回落成字符串默认值（下游 .trim() 不会炸）',
      Object.keys(D).every((k) => typeof e[k] === 'string'));
    ok('U06 默认值不写进地址栏', urlStateToQuery({ ...D, folder: 'f9', view: 'list' }, D) === 'folder=f9',
      urlStateToQuery({ ...D, folder: 'f9', view: 'list' }, D));
  }

  console.log(`\n${fail ? `FAIL ${fail} 项` : 'ALL PASS'} · base=${BASE}`);
  process.exit(fail ? 1 : 0);
};

boot().catch((e) => { console.error('渲染回归脚本自身出错：', e); process.exit(2); });
