import flowmateLogo from '../assets/flowmate-logo.svg';
import { NavigationIcon } from '../components/NavigationIcon';
import { avatarSource } from './avatar-options';
import { AvatarChooser } from './AvatarChooser';
import xingyuLogo from '../assets/xingyu-logo.svg';
// FlowMate · 应用外壳（PRD §03 信息架构 + §04 四级层次的第一层导航与顶栏）
// 左侧 216px 深灰绿导航 · 顶部 60px 组织切换 / 面包屑 / 全局搜索 / 通知 / 个人菜单 · 内容区独立滚动
import React, { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LiveCtx, api, errMsg, fmtRel, jsonOf, setCurrentOrg, useLive, useQ, type Json } from '../api/hooks';
import { SessionProvider, useSession } from './session';
import { Btn, Empty, Err, Pop, PopItem, Pill, Skel, ToastHost, useToast } from '../components/ui';
import { GlobalSearch } from './GlobalSearch';
import { AccountPage, MembersPage } from './Account';
import { LoginPage } from './Login';

type Crumb = { label: string; to?: string };

function crumbFor(path: string, orgName: string): Crumb[] {
  const seg = path.split('/').filter(Boolean);
  const map: Record<string, string> = {
    message: '消息', workspace: '文档', task: '任务', dashboard: '首页',
  };
  // Agent 三个子页统一归到「办公」下：面包屑不再出现英文模块名
  const agentTab: Record<string, string> = { personal: '个人办公', team: '团队办公', center: '对话中心' };
  if (seg[0] === 'agent') return [{ label: orgName }, { label: '办公' }, { label: agentTab[seg[1] ?? ''] ?? '办公' }];
  if (seg[0] === 'search') return [{ label: orgName }, { label: '全局搜索' }];
  if (seg[0] === 'account') return [{ label: orgName }, { label: '设置' }];
  if (seg[0] === 'members') return [{ label: orgName }, { label: '成员管理' }];
  return [{ label: orgName }, { label: map[seg[0] ?? ''] ?? '概览' }];
}

export function Shell() {
  const { me, loading, orgId, orgs, switchOrg, logout, refresh } = useSession();
  const loc = useLocation();
  const nav = useNavigate();
  const live = useLive();
  const [searchOpen, setSearchOpen] = useState(false);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [searchSeed, setSearchSeed] = useState('');
  const [lanNotice, setLanNotice] = useState(() => localStorage.getItem('fm.lannotice') !== '0');
  const [navMin, setNavMin] = useState(() => localStorage.getItem('fm.navmin') === '1');
  const toast = useToast();
  const orgRef = useRef<HTMLButtonElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const [dark, setDark] = useState(() => localStorage.getItem('fm.theme') === 'dark');
  const [utilitiesOpen, setUtilitiesOpen] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('fm.theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => { setUtilitiesOpen(false); }, [loc.pathname]);
  const [pop, setPop] = useState<'none' | 'org' | 'bell'>('none');

  const unread = useQ<{ unread: number; count?: number }>(['notifications', 'count'], '/notifications/unread-count', { inbox: true }, { refetchMs: 20000 });
  const msgUnread = useQ<{ count: number }>(['messages-unread'], '/messages/unread-count', undefined, { refetchMs: 15000 });
  const notifs = useQ<Json[]>(['notifications'], '/notifications', { limit: 100, inbox: true }, { enabled: pop === 'bell' });
  const model = useQ<Json>(['model-status'], '/agent/model-status', undefined, { refetchMs: 60000 });

  useEffect(() => { localStorage.setItem('fm.lannotice', lanNotice ? '1' : '0'); }, [lanNotice]);

  useEffect(() => {
    document.body.classList.toggle('nav-min', navMin);
    localStorage.setItem('fm.navmin', navMin ? '1' : '0');
  }, [navMin]);

  // Ctrl/Cmd+K 全局搜索（§03）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen((v) => !v); }
      void 0;
    };
    const onG = (ev: Event) => { setSearchSeed(String((ev as CustomEvent).detail ?? '')); setSearchOpen(true); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('fm:globalsearch', onG);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('fm:globalsearch', onG); };
  }, []);

  const openPop = useCallback((p: 'org' | 'bell') => setPop((cur) => (cur === p ? 'none' : p)), []);

  async function openNotifications() {
    if (pop === 'bell') { setPop('none'); return; }
    setPop('bell');
    try { await api.put('/notifications/read-all?inbox=true'); await Promise.all([unread.refetch(), notifs.refetch()]); }
    catch (e) { toast(errMsg(e), true); }
  }

  if (loading) {
    return <div style={{ padding: 32 }}><Skel rows={6} /></div>;
  }
  if (!me?.user) {
    return <LoginPage />;
  }
  const orgName = orgs.find((o) => o.id === orgId)?.name ?? '未加入组织';

  return (
    <LiveCtx.Provider value={live}>
      <div className={`shell light-emerald${navMin ? ' nav-min' : ''}`}>
        <nav className="nav" aria-label="主导航">
          <div className="nav-brand">
            <span className="nav-mark"><img src={flowmateLogo} alt="FlowMate Logo" width="40" height="40" /></span>
            <span className="nav-name">FlowMate</span>
            {/* 收起/展开跟着品牌行走：不显示版本号，也不占单独一行 */}
            <button className="nav-collapse" onClick={() => setNavMin((v) => !v)}
              aria-expanded={!navMin} aria-label={navMin ? '展开导航栏' : '收起导航栏到只剩图标'}
              title={navMin ? '展开导航栏' : '收起导航栏（只留图标）'}>
              <span className="chev" aria-hidden="true"><Icon d={navMin ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6'} /></span>
            </button>
          </div>
          <NavItem to="/dashboard" label="首页"><Icon d="M3 11l9-7 9 7M5 9.5V20h14V9.5" /></NavItem>
          <NavItem to="/message" label="消息" dot={Number(msgUnread.data?.count ?? 0) > 0}>
            <Icon d="M4 6h16v10H9l-5 4z" />
          </NavItem>
          <NavItem to="/workspace" label="文档"><Icon d="M3 7h6l2 2h10v10H3z" /></NavItem>
          <NavItem to="/agent/personal" label="个人办公"><Icon d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 4-6 8-6s8 2 8 6" /></NavItem>
          <NavItem to="/agent/team" label="团队办公"><Icon d="M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7 0a3 3 0 1 0 0-6M3 20c0-3 3-5 6-5s6 2 6 5m1-5c3 0 5 2 5 5" /></NavItem>
          {/* 对话中心：按需求从侧栏移除入口（板块不再需要）。路由与页面模块保留，如需可恢复。 */}
          <NavItem to="/task" label="任务"><Icon d="M9 5h11M9 12h11M9 19h11M3 5l1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2" /></NavItem>
          <button className="nav-utility-toggle" aria-label="打开设置菜单" aria-expanded={utilitiesOpen} onClick={() => setUtilitiesOpen(v => !v)}><Icon d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M10 3h4l1 3 3 1 3 3v4l-3 1-1 3-3 3h-4l-1-3-3-1-3-3v-4l3-1 1-3z" /></button>
          <div className={`nav-utilities${utilitiesOpen ? ' is-open' : ''}`}>
            <NavItem to="/members" label="成员管理"><Icon d="M4 3h13v18H4zM8 7h5M8 11h5M8 15h3M20 7v10M2 7h4M2 12h4M2 17h4" /></NavItem>
            <NavItem to="/account" label="设置"><Icon d="M9.5 3h5l.6 2.6 1.3.8 2.6-.8 2.5 4.3-2 1.8v1.6l2 1.8L19 19.4l-2.6-.8-1.3.8-.6 2.6h-5l-.6-2.6-1.3-.8-2.6.8L2.5 15l2-1.8v-1.6l-2-1.8L5 5.6l2.6.8 1.3-.8zM12 9a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7" /></NavItem>
            <button className="nav-item theme-control" role="switch" aria-checked={dark} aria-label="深色模式" title="深色模式" onClick={() => setDark(v => !v)}>
              <Icon d="M20.5 14A9 9 0 0 1 10 3.5a9 9 0 1 0 10.5 10.5" /><span className="label">深色模式</span><span className="theme-switch" aria-hidden="true"><i /></span>
            </button>
            <div className="nav-utility-divider" />
            <button className="nav-item logout-control" title="退出登录" onClick={() => void logout()}><Icon d="M9 4H4v16h5M9 12h12m-4-4 4 4-4 4" /><span className="label">退出登录</span></button>
          </div>
        </nav>

        <div className="main">
          <header className="top">
            <nav className="top-breadcrumb" aria-label="当前位置">
              {crumbFor(loc.pathname, orgName).map((c, i, arr) => (
                <span key={i} className={`breadcrumb-part${i === 0 ? ' breadcrumb-org' : ''}${i === arr.length - 1 ? ' breadcrumb-current' : ''}`}>
                  {i > 0 ? <svg className="breadcrumb-divider" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg> : null}
                  {i === 0 ? <span title={c.label}><img className="enterprise-logo" src={xingyuLogo} alt={`${c.label} Logo`} width="30" height="30" /></span> : c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current={i === arr.length - 1 ? 'page' : undefined}>{c.label}</span>}
                </span>
              ))}
            </nav>
            <div className="top-actions">
              <button ref={orgRef} className="icon-btn" onClick={() => openPop('org')} aria-haspopup="menu" aria-label="切换组织" title="切换组织">
                <Icon d="M4 20V4h10v16M2 20h20M8 8h2m-2 4h2m-2 4h2M17 6l4 3-4 3m4-3h-6M21 16l-4 3 4 3m-4-3h6" />
              </button>
              <button className="icon-btn" onClick={() => setSearchOpen(true)} title="搜索" aria-label="搜索">
                <Icon d="M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15M16 16l5 5" />
              </button>
              <button ref={bellRef} className="icon-btn" onClick={() => void openNotifications()} aria-label="通知" title="通知">
                <Icon d="M8 18h8M10 21h4M5 16c2-2 1-4 2-8a5 5 0 0 1 10 0c1 4 0 6 2 8H5M12 2v1" />
                {Number(unread.data?.unread ?? unread.data?.count ?? 0) > 0 ? <span className="notification-dot" aria-label="有未读通知" /> : null}
              </button>
              <div className="profile-identity" title={`${me.user.display_name} · ${me.user.email}`}>
                <button className="profile-avatar-trigger" aria-label="更换头像" title="更换头像" onClick={() => setAvatarOpen(true)}><img className="profile-avatar" src={avatarSource(jsonOf<Json>((me.user as unknown as Json).prefs, {}).avatar)} alt={`${me.user.display_name}的头像`} width="48" height="48" /><span className="avatar-edit-mark" aria-hidden="true"><Icon d="m4 16 11-11 4 4L8 20H4zM13 7l4 4" /></span></button>
                <div className="profile-identity-text"><strong>{me.user.display_name}</strong><span>{me.user.email}</span></div>
              </div>
            </div>
          </header>

          {live.status !== 'open' ? (
            <div className="lan-banner"><b>连接中断</b><span>实时推送已断开，正在按游标重连补拉；数据以服务端为准。</span></div>
          ) : null}
          {/* 环境提醒可关闭：关掉后整行从 flex 流里消失，下方工作区自然顶上来，不留空洞。
              想再看一眼：左下导航脚注里常驻「本地演示环境」。 */}
          {lanNotice ? (
            <div className="lan-banner">
              <b>局域网测试环境</b>
              <span>HTTP 明文传输，请勿放入敏感数据；Lite 模式（SQLite + 进程内调度），未使用 PostgreSQL / Redis / Docker。</span>
              <button className="banner-x" onClick={() => { setLanNotice(false); toast('环境提醒已收起，可在「设置页」里重新显示'); }} aria-label="收起环境提醒">收起提醒</button>
            </div>
          ) : null}

          <div className="body-scroll">
            <Routes>
              <Route path="/" element={<Navigate to="/message" replace />} />
              <Route path="/login" element={<Navigate to="/message" replace />} />
              <Route path="/message/*" element={<LazyPage name="Message" />} />
              <Route path="/workspace/*" element={<LazyPage name="Workspace" />} />
              <Route path="/agent/personal/*" element={<LazyPage name="AgentPersonal" />} />
              <Route path="/agent/team/*" element={<LazyPage name="AgentTeam" />} />
              <Route path="/agent/center/*" element={<LazyPage name="AgentCenter" />} />
              <Route path="/task/*" element={<LazyPage name="Task" />} />
              <Route path="/dashboard/*" element={<LazyPage name="Dashboard" />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route path="*" element={<Empty title="页面不存在" body="请从左侧导航进入四个一级模块。" action={<Btn onClick={() => nav('/message')}>回到 Message</Btn>} />} />
            </Routes>
          </div>
        </div>

        {pop === 'org' ? (
          <Pop anchor={orgRef} onClose={() => setPop('none')} width={260}>
            <div className="pop-title">切换组织</div>
            {orgs.map((o) => (
              <PopItem key={o.id} current={o.id === orgId} onClick={() => { switchOrg(o.id); setPop('none'); }}>
                <span className="grow">{o.name}</span><span className="muted small">{{ owner: '所有者', admin: '管理员', member: '成员' }[o.role] ?? o.role}</span>
              </PopItem>
            ))}
            <div className="pop-sep" />
            
          </Pop>
        ) : null}

        {pop === 'bell' ? (
          <Pop anchor={bellRef} onClose={() => setPop('none')} width={400} className="notification-pop">
            <div className="notification-pop-head"><strong>通知</strong><button className="btn ghost sm" onClick={async () => {
              try { await api.put('/notifications/read-all?inbox=true'); await Promise.all([unread.refetch(), notifs.refetch()]); }
              catch (e) { toast(errMsg(e), true); }
            }}>全部标记为已读</button></div>
            <div className="notification-list">
              {notifs.isLoading ? <Skel rows={3} /> : notifs.isError ? <Err onRetry={() => void notifs.refetch()}>{errMsg(notifs.error)}</Err> : !notifs.data?.length ? <div className="notification-empty">暂无通知</div> : null}
              {(notifs.data ?? []).map((n: Json) => (
                <button key={String(n.id)} className={`pop-item notification-item${n.read_at ? '' : ' is-unread'}`} onClick={async () => {
                  try { await api.put(`/notifications/${n.id}/read`); void unread.refetch(); void notifs.refetch(); setPop('none'); if (n.target_path) nav(String(n.target_path)); }
                  catch (e) { toast(errMsg(e), true); }
                }}>
                  <span className="notification-item-mark" aria-hidden="true" />
                  <span className="grow"><span className="notification-item-title">{String(n.title)}</span><span className="muted small">{fmtRel(String(n.created_at))} · {String(n.type_label ?? '通知')}</span></span>
                </button>
              ))}
            </div>
          </Pop>
        ) : null}

        {avatarOpen ? <AvatarChooser key={me.user.id} current={String(jsonOf<Json>((me.user as unknown as Json).prefs, {}).avatar || 'male-1')} onClose={() => setAvatarOpen(false)} onSaved={() => { refresh(); toast('头像已更新'); }} /> : null}
        {searchOpen ? <GlobalSearch seed={searchSeed} onClose={() => { setSearchOpen(false); setSearchSeed(''); }} /> : null}
      </div>
    </LiveCtx.Provider>
  );
}

function NavItem({ to, label, children, badge, dot }: { to: string; label: string; children: ReactNode; badge?: number; dot?: boolean }) {
  const loc = useLocation();
  const active = loc.pathname === to || loc.pathname.startsWith(`${to}/`);
  return (
    <Link to={to} className="nav-item" aria-current={active ? 'page' : undefined} title={label}>
      <NavigationIcon route={to} selected={active}/><span className="label">{label}</span>
      {badge ? <span className="nav-badge">{badge}</span> : null}
      {dot && !badge ? <span className="nav-dot" aria-label="有新消息" /> : null}
    </Link>
  );
}

function Icon({ d }: { d: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

// 页面组件按模块拆文件；未创建的模块给出明确状态而不是空白页
const PAGES: Record<string, () => Promise<{ default: React.ComponentType }>> = {
  Message: () => import('../features/message/MessagePage'),
  Workspace: () => import('../features/workspace/WorkspacePage'),
  AgentPersonal: () => import('../features/agent/PersonalPage'),
  AgentTeam: () => import('../features/agent/TeamPage'),
  AgentCenter: () => import('../features/agent/CenterPage'),
  Task: () => import('../features/task/TaskPage'),
  Dashboard: () => import('../features/dashboard/DashboardPage'),
};

function LazyPage({ name }: { name: string }) {
  const Comp = useMemo(() => {
    const load = PAGES[name];
    if (!load) return null;
    return load;
  }, [name]);
  const [Inner, setInner] = useState<React.ComponentType | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setInner(null);
    setFailed(null);
    if (!Comp) { setFailed(`页面模块 ${name} 未实现`); return; }
    Comp().then((m) => { if (alive) setInner(() => m.default); })
      .catch((e) => { if (alive) setFailed(errMsg(e)); });
    return () => { alive = false; };
  }, [Comp, name]);
  if (failed) return <div style={{ padding: 24 }}><Empty title="页面加载失败" body={failed} /></div>;
  if (!Inner) return <div style={{ padding: 24, height: '100%' }}><Skel rows={8} /></div>;
  return <Inner />;
}

/** 渲染错误边界：崩溃时给出可读原因与重试，而不是整页空白（§04 全页状态） */
class ErrorBoundary extends React.Component<{ onError?: (m: string, s?: string) => void; children: ReactNode }, { error: Error | null }> {
  constructor(props: { onError?: (m: string, s?: string) => void; children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { this.props.onError?.(error.message, error.stack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24 }}>
        <Err onRetry={() => this.setState({ error: null })}>
          <b>页面渲染出错</b>：{this.state.error.message}
          <div className="small muted" style={{ marginTop: 6 }}>已记录到服务端日志（[client] 行），可点右上「重试」恢复本页。</div>
        </Err>
      </div>
    );
  }
}

export function App({ onRenderError }: { onRenderError?: (m: string, s?: string) => void }) {
  return (
    <ToastHost>
      <SessionProvider>
        <ErrorBoundary onError={onRenderError}>
          <Shell />
        </ErrorBoundary>
      </SessionProvider>
    </ToastHost>
  );
}

export function useOrgId() {
  const { orgId } = useSession();
  useEffect(() => { if (orgId) setCurrentOrg(orgId); }, [orgId]);
  return orgId;
}

export { Pill };



