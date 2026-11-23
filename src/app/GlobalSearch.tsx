// FlowMate · 全局搜索（PRD §15：分类聚合任务/会话与消息/文件/成员，分页 20，300ms 防抖，空输入不发请求）
// 结果直达实体深链；无权内容后端已剔除；正文不可检索的文件必须显式列出。
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, fmtRel, jsonOf, useDebounced, type Json } from '../api/hooks';
import { Empty, Modal, Note, Pill, Skel, Snippet, SubTabs } from '../components/ui';

type Group = {
  query: string;
  groups: {
    members?: { items: Json[] };
    conversations?: { items: Json[] };
    messages?: { items: Json[]; more?: boolean };
    files?: { items: Json[]; more?: boolean };
    tasks?: { items: Json[] };
  };
  unsearchable?: { file_id: string; name: string; reason: string; status: string }[];
  note?: string;
};

const TABS = [
  { key: 'all', label: '全部' },
  { key: 'tasks', label: '任务' },
  { key: 'conversations', label: '会话' },
  { key: 'messages', label: '消息正文' },
  { key: 'files', label: '文件' },
  { key: 'members', label: '成员' },
] as const;
type TabKey = typeof TABS[number]['key'];

export function GlobalSearch({ onClose, seed = '' }: { onClose: () => void; seed?: string }) {
  const nav = useNavigate();
  const [q, setQ] = useState(seed);
  const [tab, setTab] = useState<TabKey>('all');
  const debounced = useDebounced(q, 300);
  const [data, setData] = useState<Group | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!debounced.trim()) { setData(null); setErr(null); return; }
    let alive = true;
    setBusy(true);
    api.get<Group>(`/search`, { q: debounced, type: tab })
      .then((r) => { if (alive) { setData(r); setErr(null); } })
      .catch((e) => { if (alive) setErr(errMsg(e)); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [debounced, tab]);

  const g = data?.groups ?? {};
  const go = (path: string) => { nav(path); onClose(); };

  const total = useMemo(() => ({
    tasks: g.tasks?.items.length ?? 0,
    conversations: g.conversations?.items.length ?? 0,
    messages: g.messages?.items.length ?? 0,
    files: g.files?.items.length ?? 0,
    members: g.members?.items.length ?? 0,
  }), [g]);

  return (
    <Modal title="全局搜索" onClose={onClose} wide>
      <div className="searchbox">
        <input type="search" autoFocus value={q} placeholder="输入关键词"
          onChange={(e) => setQ(e.target.value)} aria-label="搜索关键词" />
      </div>
      <div style={{ margin: '12px -20px 0' }}>
        <SubTabs value={tab} onChange={setTab} items={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          n: t.key === 'all' ? undefined : total[t.key as keyof typeof total],
        }))} />
      </div>

      <div style={{ marginTop: 14 }}>
        {!debounced.trim() ? <Empty title="输入关键词后开始检索" /> : null}
        {debounced.trim() && busy && !data ? <Skel rows={5} /> : null}
        {err ? <div className="err">{err}</div> : null}

        {data ? (
          <div className="stack">
            {data.unsearchable?.length ? (
              <Note tone="warn">
                部分文件正文暂不可检索（{data.unsearchable.length} 个）：
                {data.unsearchable.slice(0, 4).map((u) => ` ${u.name}`).join('、')}
                {data.unsearchable.length > 4 ? ' 等' : ''}
                <div className="small">没有命中不等于没写过 —— 上述文件没有文本层或抽取未完成。</div>
              </Note>
            ) : null}

            {tab !== 'all' ? null : <Section title="成员" n={total.members}>
              {g.members?.items.map((m) => (
                <Line key={String(m.id)} title={String(m.display_name)} meta={`${m.email} · ${m.title ?? ''}`} onClick={() => go(`/message?new=dm&user=${m.id}`)} />
              ))}
            </Section>}

            <Section title="任务" n={total.tasks}>
              {g.tasks?.items.map((t) => (
                <Line key={String(t.id)} title={String(t.title)} meta={`${t.status_label ?? t.status} · ${t.assignee_name ?? '未指派'}${t.project ? ` · ${t.project}` : ''}`}
                  pill={<Pill status={String(t.status)} />} onClick={() => go(`/task?focus=${t.id}`)} />
              ))}
            </Section>

            <Section title="会话" n={total.conversations}>
              {g.conversations?.items.map((c) => (
                <Line key={String(c.id)} title={String(c.display_name)} meta={c.type === 'dm' ? '私聊' : '项目群'} onClick={() => go(`/message?c=${c.id}`)} />
              ))}
            </Section>

            <Section title="消息正文" n={total.messages}>
              {g.messages?.items.map((m) => (
                <Line key={String(m.message_id)} title={String(m.conversation_name ?? '会话')}
                  meta={`${m.sender_name} · ${fmtRel(String(m.created_at))}`}
                  body={<span className="small"><Snippet text={String(m.snippet)} hits={jsonOf<[number, number][]>(m.hits, [])} /></span>}
                  onClick={() => go(`/message?c=${m.conversation_id}&around=${m.message_id}`)} />
              ))}
            </Section>

            <Section title="文件" n={total.files}>
              {g.files?.items.map((f) => (
                <Line key={`${f.file_id}-${f.kind}`} title={String(f.name)}
                  meta={f.kind === 'file_content' ? '正文命中' : '名称或路径命中'}
                  body={f.snippet ? <span className="small"><Snippet text={String(f.snippet)} hits={jsonOf<[number, number][]>(f.hits, [])} /></span> : undefined}
                  pill={f.location ? <Pill plain status>{locLabel(jsonOf<Json>(f.location, {}))}</Pill> : undefined}
                  onClick={() => go(`/workspace?focus=${f.file_id}`)} />
              ))}
            </Section>

            {busy ? <div className="muted small">检索中…</div> : null}
            {!total.messages && !total.files && !total.tasks && !total.members && !total.conversations && debounced.trim() && !busy
              ? <Empty title="没有命中" body="换个关键词，或注意上方「正文暂不可检索」清单。" /> : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Section({ title, n, children }: { title: string; n: number; children: React.ReactNode }) {
  if (!n) return null;
  return (
    <section>
      <div className="pop-title">{title} · {n}</div>
      {children}
    </section>
  );
}

function Line({ title, meta, body, pill, onClick }: { title: string; meta?: string; body?: React.ReactNode; pill?: React.ReactNode; onClick: () => void }) {
  return (
    <button className="pop-item" style={{ height: 'auto', alignItems: 'flex-start', padding: '8px 10px' }} onClick={onClick}>
      <span className="grow">
        <span style={{ display: 'block', fontSize: 14 }}>{title}</span>
        {meta ? <span className="muted small">{meta}</span> : null}
        {body ? <span style={{ display: 'block', marginTop: 2 }}>{body}</span> : null}
      </span>
      {pill}
    </button>
  );
}

function locLabel(loc: Json): string {
  if (loc.page) return `第 ${loc.page} 页`;
  if (loc.sheet) return `工作表 ${loc.sheet}`;
  if (loc.slide) return `第 ${loc.slide} 页幻灯`;
  if (loc.line_start) return `第 ${loc.line_start} 行`;
  return '正文命中';
}
