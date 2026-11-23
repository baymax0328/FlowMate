// FlowMate · Message（PRD §05）
// 三栏：会话导航（搜索 + 私聊/项目群 + 未读与@我）· 会话主区（消息流 + 回复 + 卡片 + 输入）· 可折叠会话详情
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { api, arrOf, errMsg, fmtRel, idem, jsonOf, useM, usePageCols, useQ, useSubscription, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { MessageActionIcon, Avatar, Btn, Check, ColResizer, Confirm, copyText, Empty, Err, Field, Modal, Pill, RowMenu, Skel, Snippet, SubTabs, useToast } from '../../components/ui';
import { useSession } from '../../app/session';
import { avatarSource } from '../../app/avatar-options';

const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));

/**
 * 后端把 mentions 回成对象数组 `[{user_id, display_name}]`（见 messages.service.dto），
 * 不是 ID 字符串数组。前端以前写 `jsonOf<string[]>(m.mentions, []).includes(meId)`，
 * 拿对象去比字符串永远 false —— 「@我」的高亮、徽标、提示条一起失效（本轮需求 1 的根因）。
 * 这里统一收口成 ID 数组，兼容裸字符串（防止别处接口回的是简化形状）。
 */
const mentionIdsOf = (m: Json): string[] => arrOf<Json>(m.mentions)
  .map((x) => (typeof x === 'string' ? x : S((x ?? {}).user_id ?? (x ?? {}).id)))
  .filter(Boolean);
const mentionNamesOf = (m: Json): string[] => arrOf<Json>(m.mentions)
  .map((x) => (typeof x === 'string' ? '' : S((x ?? {}).display_name)))
  .filter(Boolean);

type GroupRole = 'admin' | 'member';

const DISSOLVED_NOTICE = '该群聊已解散，无法再发送消息';
const EMOJIS = [
  ['😊', '微笑'], ['🤔', '思考'], ['😂', '笑哭'], ['😮', '惊讶'], ['😎', '酷'],
  ['👍', '赞同'], ['👏', '鼓掌'], ['🙏', '感谢'], ['👌', 'OK'], ['🤝', '合作'],
  ['🎉', '庆祝'], ['❤️', '喜爱'], ['👀', '正在查看'], ['✅', '确认'], ['❎', '取消'],
];

type Conv = {
  id: string; type: 'dm' | 'project'; name?: string | null; display_name?: string; type_label?: string;
  unread_count?: number; at_me_unread_count?: number; unread_label?: string; last_message?: Json | null;
  last_message_at?: string | null; members?: Json[]; member_count?: number; can_manage?: boolean; my_role?: string;
  /** 我在这个会话里的已读位点：会话顶部「有新的@」提示条要靠它区分「新的」和「已看过的」 */
  last_read_at?: string | null;
  /** 「成员」列里还没聊过的组织成员：没有会话 id，点开时先建（或复用）单聊会话 */
  member_id?: string;
  pinned_at?: string | null;
  muted?: boolean;
  created_by?: string | null;
  dissolved_at?: string | null;
};

function peerId(conversation: Conv, meId: string) {
  return conversation.member_id ?? conversation.members?.map((member) => S(member.user_id ?? member.id))
    .find((id) => id && id !== meId) ?? '';
}

export default function MessagePage() {
  const { me } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const { params, update } = useUrlState({ c: '', side: '', around: '', q: '', new: '' });
  const [tab, setTab] = usePersistentState<'all' | 'dm' | 'project'>('message.list-tab','all');
  const [listQuery, setListQuery] = usePersistentState('message.list-query','');
  const [newOpen, setNewOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = usePersistentState('message.pinned-open',true);
  const [conversationAction, setConversationAction] = useState<{ kind: 'leave' | 'remove'; conversation: Conv } | null>(null);
  const [dissolveTarget, setDissolveTarget] = useState<Conv | null>(null);
  const [roleTarget, setRoleTarget] = useState<{ conversationId: string; userId: string; role: GroupRole } | null>(null);
  const [detailOpen, setDetailOpen] = usePersistentState('message.detail-open',false);   // 需求：右侧可收起的栏默认收起
  const cols = usePageCols('message');
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Json | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<{ file_id: string; version_id: string; name: string }[]>([]);
  const [sendErr, setSendErr] = useState<string | null>(null);
  const [caret, setCaret] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  /** 插入 @ 之后要把光标放回「@名字 」之后：React 改 value 不会自己挪光标 */
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  const convs = useQ<Conv[]>(['conversations'], '/conversations', undefined, { refetchMs: 30000 });
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const activeId = params.c || '';
  useSubscription('conversation', activeId);
  const list = useMemo<Conv[]>(() => {
    const convRows = convs.data ?? [];
    const mine = me?.user.id ?? '';
    let rows: Conv[] = convRows;
    const q = listQuery.trim().toLowerCase();
    if (tab === 'dm' || (tab === 'all' && q)) {
      // 「成员」= 组织内所有人在这一列里（还没聊过的也列出来），点进去没有单聊就先建一条再进入
      const byPeer = new Map<string, Conv>();
      for (const c of convRows.filter((x) => x.type === 'dm')) {
        const peer = peerId(c, mine);
        if (peer) byPeer.set(peer, c);
      }
      rows = (members.data ?? [])
        .filter((m) => !m.disabled)
        .map((m) => ({ id: S(m.user_id ?? m.id), name: S(m.display_name) }))
        .filter((m) => m.id && m.id !== mine)
        .map((m) => byPeer.get(m.id) ?? {
          id: '', type: 'dm' as const, display_name: m.name || '未命名成员', member_id: m.id,
        });
      if (tab === 'all') rows = [...rows, ...convRows.filter((c) => c.type === 'project')];
    } else if (tab === 'project') {
      rows = convRows.filter((c) => c.type === 'project');
    }
    if (!q) return rows;
    return rows.filter((c) => `${S(c.display_name)}${S(c.name)}${S((c as Conv).member_id, '')}`.toLowerCase().includes(q));
  }, [convs.data, members.data, tab, listQuery, me?.user.id]);

  /** 打开一行：已有会话直接选；成员还没有会话时先建（后端对同一对人幂等） */
  const openRow = useCallback(async (c: Conv) => {
    if (c.id === activeId && c.id) {
      try {
        await api.put(`/conversations/${c.id}/read`);
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['messages-unread'] });
      } catch (error) { toast(errMsg(error), true); }
    }
    if (c.id) { update({ c: c.id, around: null }); setSp({ c: c.id }, { replace: true }); return; }
    if (!c.member_id) return;
    try {
      const r = await api.post<Json>('/conversations', { type: 'dm', member_ids: [c.member_id] });
      const id = S(r.id ?? r.conversation_id);
      if (!id) { toast('没能打开与这位成员的会话', true); return; }
      update({ c: id, around: null }); setSp({ c: id }, { replace: true });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (e) { toast(errMsg(e), true); }
  }, [activeId, update, setSp, qc, toast]);

  /** 各页签计数与列表口径必须同一个算法：曾经「成员」标 4（含我自己）而列表只列 3 个，看着就是数字错了 */
  const tabCounts = useMemo(() => {
    const convRows = convs.data ?? [];
    const mine = me?.user.id ?? '';
    const peerCount = (members.data ?? []).map((m) => S(m.user_id ?? m.id)).filter((id) => id && id !== mine).length;
    return {
      all: convRows.length,
      dm: peerCount,
      project: convRows.filter((c) => c.type === 'project').length,
    };
  }, [convs.data, members.data, me?.user.id]);

  const listedConversation = (convs.data ?? []).find((c) => c.id === activeId);
  const msgs = useInfiniteQuery({
    queryKey: ['messages', activeId, params.around ?? ''],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api.get<{ items: Json[]; next_cursor: string | null }>(
      `/conversations/${activeId}/messages`, { limit: 60, before: pageParam ?? undefined, around: params.around || undefined }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: !!activeId,
  });
  const newestMessages = msgs.data?.pages[0];
  const detail = useQ<Json>(['conversation-detail', activeId], `/conversations/${activeId || 'none'}/members`, undefined,
    { enabled: !!activeId });
  const myAvatar = avatarSource(jsonOf<Json>((me?.user as unknown as Json)?.prefs ?? {}, {}).avatar);
  const active: Conv | undefined = listedConversation ?? detail.data?.conversation;
  const convPeople = useQ<Json[]>(['conversation-members', activeId], `/conversations/${activeId || 'none'}/participants`,
    undefined, { enabled: !!activeId });
  const memberRows = jsonOf<Json[]>(detail.data?.member_rows ?? detail.data?.members, []);
  const creatorId = active?.type === 'project' ? S(detail.data?.conversation?.created_by ?? active.created_by ??
    (convPeople.data ?? []).find((person) => person.is_creator)?.user_id ??
    memberRows.find((person) => person.is_creator)?.user_id) : '';
  const conversationMembers = memberRows.map<Json>((person) => ({ ...person, is_creator: !!creatorId && S(person.user_id ?? person.id) === creatorId }));
  const dissolved = !!(active?.dissolved_at || detail.data?.conversation?.dissolved_at);
  const myGroupRole = conversationMembers.find((person) => S(person.user_id ?? person.id) === me?.user.id)?.role ?? active?.my_role;
  const orgAvatars = new Map((members.data ?? []).map((p) => [S(p.user_id ?? p.id), avatarSource(p.avatar)]));
  const memberAvatars = new Map(conversationMembers.map((p) => [S(p.user_id ?? p.id), avatarSource(p.avatar)]));
  const canChangeRole = active?.type === 'project' && !dissolved &&
    (detail.data?.can_change_roles ?? (creatorId === me?.user.id || myGroupRole === 'admin'));
  const roleMember = canChangeRole && roleTarget?.conversationId === activeId
    ? conversationMembers.find((member) => S(member.user_id ?? member.id) === roleTarget.userId && !member.is_creator)
    : undefined;
  const changeRole = useM(async ({ conversationId, userId, role }: { conversationId: string; userId: string; role: GroupRole }) => {
    await api.patch(`/conversations/${conversationId}/members/${userId}`, { role });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['conversation-detail', conversationId] }),
      qc.invalidateQueries({ queryKey: ['conversations'] }),
    ]);
  });

  const closeRoleDialog = useCallback(() => {
    if (!changeRole.isPending) setRoleTarget(null);
  }, [changeRole.isPending]);

  useEffect(() => {
    if (!activeId && (convs.data ?? []).length) {
      const first = (convs.data as Conv[])[0];
      setSp({ c: first.id }, { replace: true });
      update({ c: first.id });
    }
  }, [convs.data, activeId, setSp, update]);

  useEffect(() => {
    if (!params.around) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [newestMessages, params.around]);

  // 打开会话即标已读（通知与未读计数是两件事：已读不等于已处理）
  useEffect(() => {
    if (!activeId) return;
    void api.put(`/conversations/${activeId}/read`).then(() => {
      qc.invalidateQueries({ queryKey: ['conversations'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['messages-unread'] });
    }).catch(() => undefined);
  }, [activeId, newestMessages, qc]);

  // 切会话要把「回复中」草稿态清掉：以前留着，会出现「在 A 会话点了回复、切到 B 会话一句话挂到 A 的消息上」
  // @我提示的水位线按会话从 localStorage 恢复：确认后回来不会重复打扰，只有新的 @ 才重新提示
  useEffect(() => {
    setReplyTo(null); setMentions([]); setMentionAt(-1);
    let seen = '';
    try { seen = localStorage.getItem(`fm.athint.${activeId}`) ?? ''; } catch { /* 无存储则每次访问重新提示一次，可接受 */ }
    setAtHintSeenAt(seen);
  }, [activeId]);

  /** 把光标放回输入框里刚插入的 @名字 之后（程序改 value 不会自己动光标，不处理就会一直卡在句尾） */
  useEffect(() => {
    if (pendingCaret == null) return;
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      try { ta.setSelectionRange(pendingCaret, pendingCaret); } catch { /* 个别浏览器在受控 value 刚变时拒绝设置，忽略即可 */ }
      setCaret(pendingCaret);
    }
    setPendingCaret(null);
  }, [pendingCaret]);

  const focusComposer = () => { const ta = taRef.current; if (ta) { ta.focus(); setCaret(ta.selectionStart ?? ta.value.length); } };

  const send = useM(async () => {
    const body = draft.trim();
    if (!body && !attachments.length) throw new Error('请输入内容');
    const r = await api.post<Json>(`/conversations/${activeId}/messages`, {
      body, parent_id: replyTo?.id ?? null, mentions, client_msg_id: idem('msg'),
      attachments: attachments.map((a) => ({ file_id: a.file_id, version_id: a.version_id })),
    });
    return r;
  }, ['messages', 'conversations', 'notifications']);

  async function doSend() {
    if (dissolved) return;
    setSendErr(null);
    try {
      await send.mutateAsync();
      setDraft(''); setReplyTo(null); setMentions([]); setAttachments([]);
    } catch (e) {
      setSendErr(errMsg(e)); // 失败保留输入
    }
  }

  // ---------- @ 提及：在输入框里直接选人，不再靠下方按钮开弹窗 ----------
  // 候选优先取本会话成员（群聊只列在群里的人，@ 群外成员没有意义），拿不到时退回组织成员。
  const mentionPool = useMemo<Json[]>(() => {
    const rows = arrOf<Json>(convPeople.data);
    const base = rows.length ? rows : arrOf<Json>(members.data);
    // @ 不能包括自己：提醒自己没有任何意义，还会污染「@我」未读计数
    return base.filter((p) => S(p.user_id ?? p.id) !== (me?.user.id ?? ''));
  }, [convPeople.data, members.data, me?.user.id]);
  const [mentionAt, setMentionAt] = useState(-1);          // 光标处 @ 的起始下标；-1 = 未触发
  const [mentionIdx, setMentionIdx] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  // 需求：@我提示只显示一次 —— 用「已确认到的时间点」当水位线：
  // 点「知道了」或「跳到最近一条」后，把水位线推到当前最新一条 @，提示条就不再高亮，
  // 只有当后续来了更新的 @ 才会重新出现。水位线按会话存 localStorage，切走再回来也不会重复打扰。
  const [atHintSeenAt, setAtHintSeenAt] = useState('');
  const candidates = useMemo<Json[]>(() => {
    if (mentionAt < 0) return [];
    const frag = draft.slice(mentionAt + 1, caret);
    if (/\s/.test(frag)) return [];
    const q = frag.trim().toLowerCase();
    // 不再把「这条已经 @ 过的人」从候选里剔掉：需求要求同一个人可以被反复 @
    // （「@大白伟 你看下 → 补充一句还是 @大白伟」是正常打字节奏，之前第二条根本选不出来）。
    // 去重发生在提交时：mentions 是集合，后端再收一次，不会重复通知。
    return mentionPool
      .filter((p) => !q || `${S(p.display_name ?? p.name)}${S(p.title ?? '')}`.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mentionAt, draft, caret, mentionPool]);

  /** 会话里 @ 了我、且还没被我看过的消息：顶部提示条用 */
  const atMeItems = useMemo<Json[]>(() => {
    const mine = me?.user.id ?? '';
    if (!mine) return [];
    return (newestMessages?.items ?? []).filter((m) => mentionIdsOf(m).includes(mine) && !m.retracted && !m.is_retracted);
  }, [newestMessages, me?.user.id]);
  const lastReadAt = S(active?.last_read_at ?? '');
  /** 「新到达的@」= 在我上次已读之后发来的；已读之后提示条不消失（否则正看着就没了，等于没提示） */
  const freshAt = lastReadAt ? atMeItems.filter((m) => S(m.created_at) > lastReadAt) : atMeItems;
  /** 提示条只在水位线之后的 @ 上出现：确认后 newAtItems 归零，直到有更晚的 @ 才重新提示 */
  const newAtItems = useMemo(() => (atHintSeenAt ? atMeItems.filter((m) => S(m.created_at) > atHintSeenAt) : atMeItems), [atMeItems, atHintSeenAt]);
  const ackAtHint = () => {
    const newest = atMeItems.reduce((mx, m) => (S(m.created_at) > mx ? S(m.created_at) : mx), '');
    if (newest) { setAtHintSeenAt(newest); try { localStorage.setItem(`fm.athint.${activeId}`, newest); } catch { /* 存储不可用则退回内存态 */ } }
    else setAtHintSeenAt('');
  };
  /** 提示条上要说清是谁@的你（后端 DTO 已带 display_name，不再二次查成员表） */

  /** 输入或移动光标时重新判断是否处在 @… 片段中 */
  const trackMention = (value: string, pos: number) => {
    setCaret(pos);
    const before = value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at < 0) { setMentionAt(-1); return; }
    // @ 前面必须是行首或空白（邮箱、日期里的 @ 不该触发）
    const prev = at === 0 ? '' : before[at - 1];
    if (prev && !/\s/.test(prev)) { setMentionAt(-1); return; }
    if (/\s/.test(before.slice(at + 1))) { setMentionAt(-1); return; }
    setMentionAt(at); setMentionIdx(0);
  };

  const pickMention = (p: Json) => {
    const id = S(p.user_id ?? p.id);
    const name = S(p.display_name ?? p.name, id);
    if (!id || mentionAt < 0) return;
    const next = `${draft.slice(0, mentionAt)}@${name} ${draft.slice(caret)}`;
    setDraft(next);
    // 光标停在插入结果之后，接着打字即可（不处理就会跳回句尾，看起来像「@ 完之后不能继续 @」）
    setPendingCaret(mentionAt + name.length + 2);
    setMentions((prev) => (prev.includes(id) ? prev : [...prev, id]));
    setMentionAt(-1);
  };

  // 注：附件的「添加到本条消息」入口按需求撤掉了（上传附件请在文档页做，会话里只做引用）。
  // attachments 状态保留：历史消息里的附件仍要渲染，将来接引用卡片也走这里。

  async function saveConversationSettings(conversation: Conv, settings: { pinned?: boolean; muted?: boolean; unread?: true }) {
    try {
      await api.patch(`/conversations/${conversation.id}/preferences`, settings);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['conversations'] }),
        qc.invalidateQueries({ queryKey: ['messages-unread'] }),
      ]);
      if (settings.pinned) setPinnedOpen(true);
    } catch (error) { toast(errMsg(error), true); }
  }

  const pinned = list.filter((conversation) => conversation.pinned_at)
    .sort((a, b) => S(b.pinned_at).localeCompare(S(a.pinned_at)));
  const unpinned = list.filter((conversation) => !conversation.pinned_at);
  const renderConversationAvatar = (c: Conv) => {
    const groupMembers = c.type === 'project' ? (c.members ?? []).slice(0, 9) : [];
    if (!groupMembers.length) {
      return <Avatar name={S(c.display_name ?? c.name, '会话')}
        src={c.type === 'dm' ? orgAvatars.get(peerId(c, me?.user.id ?? '')) : undefined} />;
    }
    return <span className={`group-avatar${groupMembers.length > 4 ? ' group-avatar-nine' : ''}`}>
      {groupMembers.map((member) => {
        const id = S(member.user_id ?? member.id);
        const src = id === me?.user.id ? myAvatar : orgAvatars.get(id) ?? avatarSource(member.avatar);
        return <img key={id} src={src} alt="" loading="lazy" />;
      })}
    </span>;
  };
  const renderConversation = (c: Conv) => (
    <div className="conversation-list-row" key={c.id || 'm-' + c.member_id}>
      <button type="button" className="row-item" aria-current={!!c.id && c.id === activeId} onClick={() => void openRow(c)}>
        <span className="contact-avatar" aria-hidden="true">{renderConversationAvatar(c)}</span>
        <div className="contact-info"><div className="row-title">
          <span className="grow truncate">{S(c.display_name ?? c.name, '未命名会话')}</span>
          {/* 未读数放在标题行右侧（一眼可见的数字气泡），@我 单独一个标记；
              以前「未读 N 条」孤零零挂在行下方，滚动列表里几乎注意不到 */}
          {Number(c.at_me_unread_count ?? 0) > 0 ? <Pill tone="wait">@我 {c.at_me_unread_count}</Pill> : null}
          {Number(c.unread_count ?? 0) > 0 ? (
            <span className="row-unread" aria-label={`未读 ${c.unread_count} 条`}>{Number(c.unread_count) > 99 ? '99+' : c.unread_count}</span>
          ) : null}
        </div>
        <div className="row-meta">
          <span className="truncate">{S(c.last_message?.body_preview ?? c.last_message?.body, c.type === 'dm' ? '私聊' : '项目群')}</span>
          <span className="right nowrap contact-time">{fmtRel(c.last_message_at)}
            {c.muted ? <svg role="img" aria-label="免打扰" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m3 3 18 18M9 18H4l2-3v-4m3-5a6 6 0 0 1 9 5v3m-8 7a2 2 0 0 0 4 0"/></svg> : null}
          </span>
        </div></div>
      </button>
      {c.id ? <RowMenu label={`「${S(c.display_name ?? c.name, '会话')}」的操作`} items={[
        { key: 'pin', label: c.pinned_at ? '取消置顶' : '置顶', onSelect: () => void saveConversationSettings(c, { pinned: !c.pinned_at }) },
        { key: 'mute', label: c.muted ? '取消免打扰' : '免打扰', onSelect: () => void saveConversationSettings(c, { muted: !c.muted }) },
        { key: 'unread', label: '标记为未读', disabled: c.unread_count ? '会话已有未读消息' : null, onSelect: () => void saveConversationSettings(c, { unread: true }) },
        { key: 'remove', label: '删除会话', danger: true, onSelect: () => setConversationAction({ kind: 'remove', conversation: c }) },
      ]} /> : null}
    </div>
  );

  return (
    <div className={`paneled with-detail message-page${detailOpen ? '' : ' detail-closed'}${window.innerWidth <= 1024 && params.side ? ' side-open' : ''}`} style={{ height: '100%', ...cols.style }}>
      <aside className="side">
        <ColResizer onResizeStart={cols.side.onResizeStart} onNudge={cols.side.nudge} label="拖动调整会话列表宽度" />
        <div className="side-head"><button className="mobile-conversations" onClick={() => update({ side: '' })} aria-label="收起会话列表">收起列表</button><div className="inbox-title"><h1>消息中心</h1></div>
          <div className="searchbox grow">
            <input type="search" value={listQuery} placeholder="搜索成员 / 群聊 / 消息" aria-label="搜索会话"
              onChange={(e) => setListQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' || !listQuery.trim()) return;
                if (list.length === 1) void openRow(list[0]);
                else if (!list.length) window.dispatchEvent(new CustomEvent('fm:globalsearch', { detail: listQuery }));
              }} />
          </div>
          <Btn size="sm" variant="primary" onClick={() => setNewOpen(true)}>新建群聊</Btn>
        </div>
        <SubTabs value={tab} onChange={setTab} items={[
          { key: 'all', label: '全部', n: tabCounts.all },
          { key: 'dm', label: '成员', n: tabCounts.dm },
          { key: 'project', label: '群聊', n: tabCounts.project },
        ]} />
        <div className="side-body">
          {(tab === 'dm' ? members.isLoading : convs.isLoading) ? <Skel rows={5} /> : null}
          {convs.isError ? <div style={{ padding: 8 }}><Err>{errMsg(convs.error)}</Err></div> : null}
          {!convs.isLoading && !list.length ? (
            <Empty title={tab === 'project' ? '还没有群聊' : '还没有可聊的成员'}
              body={tab === 'project' ? '建一个群聊（3 人及以上），把相关的人放在同一个上下文里。' : '组织里其他成员会直接出现在这一列，点进去就能开始。'}
              action={<Btn variant="primary" onClick={() => setNewOpen(true)}>新建群聊</Btn>} />
          ) : null}
          {pinned.length ? <div className="pinned-conversation-section">
            <button type="button" className="pinned-conversation-toggle" aria-expanded={pinnedOpen} aria-controls="pinned-conversations" onClick={() => setPinnedOpen((open) => !open)}>
              <span>置顶会话（{pinned.length}）</span>
              <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={pinnedOpen ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'}/></svg>
            </button>
            <div id="pinned-conversations" hidden={!pinnedOpen}>{pinned.map(renderConversation)}</div>
          </div> : null}
          {unpinned.map(renderConversation)}
        </div>
      </aside>

      <section className="work message-work">
        {!activeId ? <Empty title="选择左侧会话" body="打开最近会话，或新建一个。" /> : null}
        {active ? (
          <>
            <div className="card-head" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', margin: 0 }}>
              <button className="mobile-conversations" onClick={() => update({ side: '1' })} aria-label="打开会话列表"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
              <div className="grow conversation-heading">
                <div className="card-title truncate">{S(active.display_name ?? active.name)}</div>
                {active.type === 'dm' ? <span className="muted small nowrap">成员会话</span>
                  : <span className="muted small nowrap conversation-group-count">群聊（{active.member_count ?? active.members?.length ?? 0}）</span>}
              </div>
              <Btn size="sm" variant="ghost" onClick={() => setDetailOpen((v) => !v)}>{detailOpen ? '收起详情' : '会话详情'}</Btn>
            </div>
            {/* 需求：有人@我时，聊天上方要有提示；提示只显示一次 ——
                点「知道了」或「跳到最近一条」后确认这批 @，提示条与消息上的高亮一起熄灭，
                只有后续来了更新的 @ 才会重新出现（水位线按会话存 localStorage）。 */}
            {newAtItems.length ? (
              <div className="mention-bar" style={{ margin: '10px 16px 0' }} role="status">
                <b>@我</b>
                <span className="grow">
                  {freshAt.length ? '有新的' : '本会话有'} {newAtItems.length} 条消息提及你
                  {[...new Set(newAtItems.flatMap(mentionNamesOf))].length ? ` · 来自 ${[...new Set(newAtItems.flatMap(mentionNamesOf))].join('、')}` : ''}
                </span>
                <button className="msg-tool" onClick={() => {
                  // 最近一条 = 时间最大的那条（列表按时间正序，取末尾），直接滚过去并闪一下
                  const last = newAtItems[newAtItems.length - 1];
                  const el = document.getElementById(`msg-${S(last?.id)}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  if (el) { el.classList.add('flash'); window.setTimeout(() => el.classList.remove('flash'), 1800); }
                  ackAtHint();
                }}>跳到最近一条</button>
                <button className="msg-tool" onClick={ackAtHint}>知道了</button>
              </div>
            ) : null}
            <div className="grow" ref={scrollRef} style={{ overflow: 'auto', minHeight: 0 }}>
              {msgs.isLoading ? <div style={{ padding: 16 }}><Skel rows={6} /></div> : null}
              {msgs.isError ? <div style={{ padding: 16 }}><Err onRetry={() => msgs.refetch()}>{errMsg(msgs.error)}</Err></div> : null}
              {msgs.hasNextPage ? <div className="center" style={{ padding: 8 }}>
                <Btn size="sm" variant="ghost" loading={msgs.isFetchingNextPage} onClick={() => void msgs.fetchNextPage()}>加载更早消息</Btn>
              </div> : null}
              {params.around ? <div className="center" style={{ padding: 8 }}>
                <Btn size="sm" variant="ghost" onClick={() => update({ around: null })}>回到最新消息</Btn>
              </div> : null}
              {(msgs.data?.pages ?? []).slice().reverse().flatMap((page) => page.items).map((m) => (
                <MessageItem key={S(m.id)} m={m} meId={me?.user.id ?? ''}
                  avatar={S(m.sender_id) === me?.user.id ? myAvatar : memberAvatars.get(S(m.sender_id))}
                  mentionNew={!atHintSeenAt || S(m.created_at) > atHintSeenAt}
                  onReply={dissolved ? undefined : () => { setReplyTo(m); focusComposer(); }}
                  onRetract={dissolved ? undefined : async () => { await api.del(`/messages/${m.id}`); qc.invalidateQueries({ queryKey: ['messages'] }); }}
                  onTask={async () => { const r = await api.post<Json>(`/messages/${m.id}/task-draft`); const id = S(r.task?.id ?? r.id); nav(id ? `/task?tab=create&focus=${id}` : '/task?tab=create'); }}
                  onJump={() => { if (m.parent_id) { update({ around: S(m.parent_id) }); } }}
                />
              ))}
            </div>
            {dissolved ? (
              <div className="composer">
                <div className="message-compose-box">
                  <textarea aria-label="消息输入" value={DISSOLVED_NOTICE} disabled />
                </div>
              </div>
            ) : <div className="composer">
              {replyTo ? (
                <div className="msg-quote cluster" style={{ marginBottom: 6 }}>
                  <span className="grow truncate">引用 {S(replyTo.sender_name)}：{S(replyTo.body)}</span>
                  <button className="msg-tool" onClick={() => setReplyTo(null)}>取消引用</button>
                </div>
              ) : null}
              {attachments.length ? (
                <div className="msg-refs" style={{ marginBottom: 6 }}>
                  {attachments.map((a) => <span key={a.file_id} className="ref-card"><span className="kind">附件</span>{a.name}
                    <button className="msg-tool" onClick={() => setAttachments((p) => p.filter((x) => x.file_id !== a.file_id))}>移除</button></span>)}
                </div>
              ) : null}
              {sendErr ? <div style={{ marginBottom: 6 }}><Err>{sendErr}（内容已保留，可重试）</Err></div> : null}
              <div className="message-compose-box" style={{ position: 'relative' }}>
                <textarea ref={taRef} value={draft}  aria-label="消息输入"
                  onChange={(e) => { setDraft(e.target.value); trackMention(e.target.value, e.target.selectionStart ?? 0); }}
                  onSelect={(e) => trackMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
                  onBlur={() => window.setTimeout(() => setMentionAt(-1), 160)}   // 给列表的点击留出时间，否则一按下拉就失焦关掉
                  onKeyDown={(e) => {
                    // @ 列表打开时：上下选、Enter/Tab 插入、Esc 关掉
                    if (mentionAt >= 0 && candidates.length) {
                      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx((i) => (i + 1) % candidates.length); return; }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIdx((i) => (i - 1 + candidates.length) % candidates.length); return; }
                      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(candidates[Math.min(mentionIdx, candidates.length - 1)]); return; }
                      if (e.key === 'Escape') { setMentionAt(-1); return; }
                    }
                    // Enter 直接发送；Shift+Enter 换行（Ctrl/Cmd+Enter 也仍然可用，兼容老习惯）
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void doSend(); }
                    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void doSend(); }
                  }} />
                {mentionAt >= 0 && (
                  <div className="mention-pop" role="listbox" aria-label="要提及的成员">
                    {candidates.length ? candidates.map((p, i) => (
                      <button key={S(p.user_id ?? p.id)} role="option" aria-selected={i === Math.min(mentionIdx, candidates.length - 1)}
                        className="mention-item" onMouseDown={(e) => { e.preventDefault(); pickMention(p); }}>
                        <Avatar name={S(p.display_name ?? p.name)} me={S(p.user_id ?? p.id) === me?.user.id} />
                        <span className="grow truncate">{S(p.display_name ?? p.name)}</span>
                        <span className="muted small">{S(p.title ?? p.role_label ?? '')}</span>
                      </button>
                    )) : <div className="mention-empty">没有匹配的成员，继续输入姓名试试</div>}
                  </div>
                )}
                <div className="message-send"><Btn variant="primary" loading={send.isPending} onClick={() => void doSend()}>发送</Btn></div>
              <div className="message-compose-tools">
                <button className="icon-btn" aria-label="提及成员" title="提及成员" onClick={() => { const pos = taRef.current?.selectionStart ?? draft.length; const next = draft.slice(0,pos) + '@' + draft.slice(pos); setDraft(next); trackMention(next,pos+1); taRef.current?.focus(); requestAnimationFrame(() => taRef.current?.setSelectionRange(pos+1,pos+1)); }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="12" r="4"/><path d="M15 8v7c0 3 6 2 6-3a9 9 0 1 0-4 7"/></svg></button>
                <button className="icon-btn" aria-label="表情" title="表情" aria-expanded={emojiOpen} onClick={() => setEmojiOpen(!emojiOpen)}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="9"/><path d="M8 14q4 5 8 0M8 9h1m6 0h1"/></svg></button>
                {emojiOpen ? <div className="emoji-picker" role="group" aria-label="选择表情">{EMOJIS.map(([emoji, label]) => <button key={emoji} aria-label={label} title={label} onClick={() => { const pos = taRef.current?.selectionStart ?? draft.length; setDraft(draft.slice(0,pos)+emoji+draft.slice(pos)); setEmojiOpen(false); taRef.current?.focus(); requestAnimationFrame(() => taRef.current?.setSelectionRange(pos+emoji.length,pos+emoji.length)); }}>{emoji === '❎' ? <span className="emoji-cancel">×</span> : emoji}</button>)}</div> : null}
              </div>
              </div>
              {mentions.length ? <div className="hint">已提及：{mentions.map((id) => S((members.data ?? []).find((x) => S(x.user_id ?? x.id) === id)?.display_name, id)).join('、')}</div> : null}
            </div>}
          </>
        ) : null}
      </section>

      {detailOpen && activeId ? (
        <aside className="detail">
          <ColResizer edge="left" onResizeStart={cols.detail.onResizeStart} onNudge={cols.detail.nudge} label="拖动调整详情栏宽度" />
          <div className="detail-head"><b className="grow">会话详情</b><Btn size="sm" variant="ghost" onClick={() => setDetailOpen(false)}>收起</Btn></div>
          <div className="detail-body stack">
            {detail.isLoading ? <Skel rows={4} /> : null}
            {detail.isError ? <Err>{errMsg(detail.error)}</Err> : null}
            {detail.data ? (
              <>
                <div className="conversation-members">
                  <div className="side-title conversation-member-heading">
                    <span>成员</span>
                    {canChangeRole && conversationMembers.some((p) => !p.is_creator && S(p.user_id ?? p.id) !== me?.user.id) ? <span className="muted small">点击右侧按钮可更改权限</span> : null}
                  </div>
                  {conversationMembers.map((p) => {
                    const userId = S(p.user_id ?? p.id);
                    const name = S(p.display_name ?? p.name);
                    const roleLabel = p.is_creator ? '创建者' : p.role === 'admin' ? '管理员' : '成员';
                    return <div className="row-meta" key={userId}>
                      <Avatar name={name} src={userId === me?.user.id ? myAvatar : memberAvatars.get(userId)} />
                      <span className="grow truncate conversation-member-name">{name}</span>
                      {canChangeRole && !p.is_creator && userId !== me?.user.id ? (
                        <button type="button" className="conversation-role" aria-label={`更改 ${name} 的会话权限，当前为${roleLabel}`}
                          aria-haspopup="dialog" onClick={() => setRoleTarget({ conversationId: activeId, userId, role: p.role === 'admin' ? 'admin' : 'member' })}>
                          <Pill plain status>{roleLabel}</Pill>
                        </button>
                      ) : <Pill plain status>{roleLabel}</Pill>}
                    </div>;
                  })}
                </div>
                {/* 「共享文件」板块按需求删掉：文件权限只在文档里改，会话里放这个列表容易让人误以为已经授权 */}
                <div>
                  <div className="side-title">关联任务</div>
                  {(jsonOf<Json[]>(detail.data.tasks, [])).length ? (jsonOf<Json[]>(detail.data.tasks, [])).map((t) => (
                    <div className="row-meta" key={S(t.id)}>
                      <span className="grow truncate">{S(t.title)}</span><Pill status={S(t.status)} />
                      <Btn size="sm" variant="ghost" onClick={() => nav(`/task?focus=${S(t.id)}`)}>查看</Btn>
                    </div>
                  )) : <div className="muted small">暂无本会话关联的任务</div>}
                </div>
                {active?.type === 'project' ? (
                  <div className="conversation-danger-actions cluster">
                    <Btn size="sm" onClick={() => setConversationAction({ kind: 'leave', conversation: active })}>退出群聊</Btn>
                    {!dissolved && creatorId === me?.user.id ? <Btn size="sm" variant="danger" onClick={() => setDissolveTarget(active)}>解散群聊</Btn> : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      ) : null}

      {conversationAction ? (
        <Confirm title={conversationAction.kind === 'leave' ? '确认退出群聊' : '确认删除会话'} danger
          confirmText={conversationAction.kind === 'leave' ? '退出群聊' : '删除会话'}
          body={conversationAction.kind === 'leave'
            ? <>退出「{S(conversationAction.conversation.display_name ?? conversationAction.conversation.name)}」后，你将无法查看该群聊，也不会再收到新消息。</>
            : <>删除后，你将无法查看该会话的消息</>}
          onClose={() => setConversationAction(null)} onConfirm={async () => {
            const { kind, conversation: { id } } = conversationAction;
            try {
              if (kind === 'leave') await api.post(`/conversations/${id}/leave`, {});
              else await api.patch(`/conversations/${id}/preferences`, { remove: true });
              qc.setQueryData<Conv[]>(['conversations'], (rows) => rows?.filter((row) => row.id !== id));
              if (id === activeId) { setDetailOpen(false); setSp({}, { replace: true }); }
              qc.removeQueries({ queryKey: ['messages', id] });
              qc.removeQueries({ queryKey: ['conversation-detail', id] });
              await Promise.all([
                qc.invalidateQueries({ queryKey: ['conversations'] }),
                qc.invalidateQueries({ queryKey: ['messages-unread'] }),
                qc.invalidateQueries({ queryKey: ['search'] }),
              ]);
              setConversationAction(null);
              toast(kind === 'leave' ? '已退出群聊' : '已删除会话');
            } catch (error) { toast(errMsg(error), true); }
          }} />
      ) : null}

      {dissolveTarget ? (
        <Confirm title="确认解散群聊" danger confirmText="解散群聊"
          body={<>解散「{S(dissolveTarget.display_name ?? dissolveTarget.name)}」后，成员仍可查看聊天记录，群聊将永久停止接收新消息。</>}
          onClose={() => setDissolveTarget(null)} onConfirm={async () => {
            const id = dissolveTarget.id;
            try {
              await api.post(`/conversations/${id}/dissolve`, {});
              await Promise.all([
                qc.invalidateQueries({ queryKey: ['conversations'] }),
                qc.invalidateQueries({ queryKey: ['conversation-detail', id] }),
              ]);
              setDissolveTarget(null);
              toast('群聊已解散');
            } catch (error) { toast(errMsg(error), true); }
          }} />
      ) : null}

      {roleTarget && roleMember ? (
        <Modal title={`修改「${S(roleMember.display_name ?? roleMember.name)}」的群聊权限为`} onClose={closeRoleDialog}
          footer={<>
            <Btn disabled={changeRole.isPending} onClick={closeRoleDialog}>取消</Btn>
            <Btn variant="primary" loading={changeRole.isPending} onClick={() => {
              if (roleTarget.role === roleMember.role) { closeRoleDialog(); return; }
              changeRole.mutate(roleTarget, {
                onSuccess: () => { setRoleTarget(null); toast('群聊权限已更新'); },
                onError: (e) => toast(errMsg(e), true),
              });
            }}>完成</Btn>
          </>}>
          <div className="group-role-options" role="radiogroup" aria-label="群聊权限">
            {(['admin', 'member'] as const).map((role) => (
              <label key={role}>
                <input type="radio" name="group-role" checked={roleTarget.role === role}
                  disabled={changeRole.isPending} onChange={() => setRoleTarget({ ...roleTarget, role })} />
                {role === 'admin' ? '管理员' : '成员'}
              </label>
            ))}
          </div>
        </Modal>
      ) : null}

      {newOpen ? (
        <NewConversation members={members.data ?? []} meId={me?.user.id ?? ''}
          onClose={() => setNewOpen(false)} onCreated={(id) => {
          setNewOpen(false); update({ c: String(id) }); setSp({ c: String(id) }, { replace: true });
          qc.invalidateQueries({ queryKey: ['conversations'] });
        }} />
      ) : null}
    </div>
  );
}

function MessageItem({ m, meId, avatar, mentionNew, onReply, onRetract, onTask, onJump }: {
  m: Json; meId: string; avatar?: string; mentionNew: boolean;
  onReply?: () => void; onRetract?: () => Promise<void>;
  onTask: () => void; onJump: () => void;
}) {
  const toast = useToast();
  const mine = S(m.sender_id) === meId;
  // 「@我」高亮只在还没确认（在水位线之后）时出现；确认过一次后消息正常显示，不再反复提醒
  const mentionsMe = mentionIdsOf(m).includes(meId);
  const highlight = mentionsMe && mentionNew;
  if (m.retracted || m.is_retracted) {
    return <div className="msg"><Avatar name="·" /><div className="grow"><div className="msg-body muted">该消息已被撤回（由它创建的任务不会随之删除）</div></div></div>;
  }
  return (
    <div className={`msg chat-bubble-message ${mine ? 'from-me' : 'from-other'}${highlight ? ' at-me' : ''}`} id={`msg-${S(m.id)}`}>
      <Avatar name={S(m.sender_name, '?')} me={mine} src={avatar} />
      <div className="grow">
        <div className="msg-head">
          <b>{S(m.sender_name)}</b><span>{fmtRel(S(m.created_at))}</span>
          {m.edited_at || m.is_edited ? <span>· 已编辑</span> : null}
          {highlight ? <Pill tone="wait" plain>@我</Pill> : null}
        </div>
        {(m.parent_id || m.parent) ? (() => {
          // 后端返回的是结构化 parent（含 excerpt / sender_name / 不可用原因），
          // 前端以前读的是 parent_body / parent_preview 两个不存在的字段 → 永远显示「原消息不可用」；
          // 而 DTO 又不回 parent_id，整块引用干脆不渲染 —— 两处一起修掉（本轮需求 3）。
          const p = (m.parent ?? {}) as Json;
          if (p.parent_unavailable) return <div className="msg-quote truncate muted">{S(p.message, '原消息不可用')}</div>;
          return (
            <div className="msg-quote truncate">
              引用 <b>{S(p.sender_name)}</b>：{S(p.excerpt, '（附件或卡片消息）')}
              <button className="msg-tool" style={{ marginLeft: 6 }} onClick={onJump}>跳到原消息</button>
            </div>
          );
        })() : null}
        {S(m.body).trim() ? <div className="msg-body"><Snippet text={S(m.body)} /></div> : null}
        {(jsonOf<Json[]>(m.attachments, [])).length ? (
          <div className="msg-refs">{(jsonOf<Json[]>(m.attachments, [])).map((a, i) => (
            <span key={i} className="ref-card"><span className="kind">文件</span>{S(a.name)}</span>
          ))}</div>
        ) : null}
        {m.card_type ? <CardRef cardType={S(m.card_type)} card={m.card ?? m.card_info} /> : null}
        <div className="msg-tools">
          {/* 平铺常用动作：不再套一层「更多」菜单；「交给 Agent」按需求移除 */}
          {onReply ? <button className="msg-tool" title="引用" aria-label="引用" onClick={onReply}><MessageActionIcon name="quote"/></button> : null}
          <button className="msg-tool" title="复制" aria-label="复制" onClick={async () => {
            // 局域网 HTTP 下 navigator.clipboard 直接不存在，?. 调用会静默失败 —— 之前照样弹「已复制」
            const done = await copyText(S(m.body));
            toast(done ? '已复制到剪贴板' : '当前环境不允许复制（请用浏览器菜单），未伪装成功', done ? undefined : true);
          }}><MessageActionIcon name="copy"/></button>
          <button className="msg-tool" title="创建任务" aria-label="创建任务" onClick={onTask}><MessageActionIcon name="task"/></button>
          {mine && onRetract ? <button className="msg-tool" title="撤回" aria-label="撤回" onClick={async () => { await onRetract(); }}><MessageActionIcon name="undo"/></button> : null}
        </div>
      </div>
      <span className="sr-only">{mentionNamesOf(m).length ? `提及 ${mentionNamesOf(m).join('、')}` : ''}</span>
    </div>
  );
}

function CardRef({ cardType, card }: { cardType: string; card?: Json | null }) {
  const nav = useNavigate();
  const c = (card ?? {}) as Json;
  if (cardType === 'file_version') {
    const open = c.access === 'granted' && !!c.file_id;
    const content = <>
      <span className="shared-file-icon" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm7 0v5h4M9 12h6m-6 4h5"/></svg>
      </span>
      <span className="shared-file-info">
        <strong>{S(c.title, '共享文件')}</strong>
        <span>{open ? '共享文件 · 点击查看' : S(c.permission_note, '文件不可访问')}</span>
      </span>
      {open ? <svg className="shared-file-arrow" aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6"/></svg> : null}
    </>;
    return open
      ? <button type="button" className="shared-file-card" onClick={() => nav(`/workspace?section=recent&focus=${encodeURIComponent(S(c.file_id))}`)}>{content}</button>
      : <div className="shared-file-card">{content}</div>;
  }
  const label = cardType === 'task' ? '任务' : cardType === 'session' ? '会话' : '内容';
  const openPath = cardType === 'task' ? `/task?focus=${S(c.id)}` : `/agent/personal?s=${S(c.session_id ?? c.id)}`;
  return (
    <div className="ref-card" style={{ marginTop: 6 }}>
      <span className="kind">{label}</span>
      <span className="grow truncate">{S(c.title ?? c.name, '未命名')}</span>
      {c.status ? <Pill status={S(c.status)} /> : null}
      {c.access !== 'granted' ? <span className="muted small">{S(c.permission_note, '内容不可访问')}</span>
        : <Btn size="sm" variant="ghost" onClick={() => nav(openPath)}>{cardType === 'session' && c.mode === 'team' ? '进入 Team' : cardType === 'session' ? '查看 Personal' : '打开'}</Btn>}
    </div>
  );
}

function NewConversation({ members, meId, onClose, onCreated }: {
  members: Json[]; meId: string; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [find, setFind] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const teams = useQ<Json[]>(['teams'], '/teams');
  const [teamId, setTeamId] = useState('');
  const people = members.flatMap((member) => {
    const id = S(member.user_id ?? member.id);
    if (!id || id === meId) return [];
    return [{
      id,
      name: S(member.display_name, '未命名成员'),
      avatar: avatarSource(member.avatar),
      disabled: !!member.disabled,
      teams: arrOf<Json>(member.teams).map((team) => S(team.name)).filter(Boolean),
    }];
  });
  const query = find.trim().toLowerCase();
  const shown = people.filter((person) => [person.name, ...person.teams].some((label) => label.toLowerCase().includes(query)));
  const selected = picked.filter((id) => people.some((person) => person.id === id && !person.disabled));
  return (
    <Modal title="新建群聊" onClose={onClose}
      footer={<>
        <span className="grow group-required-note"><span className="group-required">*</span>为必填项</span>
        <Btn variant="ghost" disabled={busy} onClick={onClose}>取消</Btn>
        <Btn variant="primary" loading={busy} disabled={!name.trim() || selected.length < 2}
          disabledReason="请输入群名称并选择至少两位成员" onClick={async () => {
            setBusy(true); setErr(null);
            try {
              const result = await api.post<Json>('/conversations', {
                type: 'project', member_ids: selected, name: name.trim(), team_id: teamId || null,
              });
              onCreated(S(result.id));
            } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
          }}>创建</Btn>
      </>}>
      <div className="stack group-create-form">
        {err ? <Err>{err}</Err> : null}
        <Field label={<>群名称 <span className="group-required" aria-hidden="true">*</span></>}>
          <input type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：客户门户改版" />
        </Field>
        <Field label="关联团队" hint="关联团队用于在团队办公侧对齐权限与工作区">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">不关联团队</option>
            {(teams.data ?? []).map((team) => <option key={S(team.id)} value={S(team.id)}>{S(team.name)}</option>)}
          </select>
        </Field>
        <div role="group" aria-labelledby="group-member-label">
          <div id="group-member-label" className="field-label">
            选择成员 <span className="group-required" aria-hidden="true">*</span>
            <span className="muted small">（已选 {selected.length}，至少选 2 位）</span>
          </div>
          <div className="searchbox group-member-search">
            <input type="search" value={find} placeholder="搜索姓名或团队" aria-label="搜索成员" onChange={(e) => setFind(e.target.value)} />
          </div>
          <div className="group-member-list">
            {!shown.length ? <div className="muted small">暂无匹配的成员</div> : null}
            {shown.map((person) => (
              <Check key={person.id} checked={selected.includes(person.id)} disabled={person.disabled}
                onChange={(checked) => setPicked((prev) => checked ? [...prev, person.id] : prev.filter((id) => id !== person.id))}>
                <Avatar name={person.name} src={person.avatar} />
                <span className="group-member-info">
                  <strong>{person.name}</strong>
                  <span className="group-member-teams">
                    {person.teams.length ? person.teams.map((team, index) => <Pill plain key={index}>{team}</Pill>)
                      : <span className="muted small">未加入团队</span>}
                    {person.disabled ? <span className="muted small">已停用</span> : null}
                  </span>
                </span>
              </Check>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
