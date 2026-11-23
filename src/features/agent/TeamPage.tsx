// FlowMate · Agent / Team（PRD §11）：多人共同工作区 + 请求卡 / 执行卡 / 共同确认卡
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, arrOf, errMsg, usePageCols, useQ, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { Avatar, Btn, Check, Empty, Err, Modal, Note, Pill, Skel, useToast } from '../../components/ui';
import { avatarSource } from '../../app/avatar-options';
import { SessionList, SessionView, type SessionDto } from './session-ui';

const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));

export default function TeamPage() {
  const {params,update}=useUrlState({s:''});
  const id=params.s;
  const setId=(value:string)=>update({s:value});
  const [detailOpen, setDetailOpen] = usePersistentState('office.team.detail',false);
  const [intent, setIntent] = useState<'' | 'workspace' | 'branch'>('');
  const cols = usePageCols('agent');                     // 与个人办公共用同一套列宽记忆
  const s = useQ<SessionDto>(['session', 'team', id], `/agent/sessions/${id || 'none'}`, undefined, { enabled: !!id, refetchMs: 15000 });
  const list = useQ<Json[]>(['sessions', 'team'], '/agent/sessions', { mode: 'team' });
  // 需求：进来就默认打开第一个团队会话（没有 ?s= 时才兜底）
  useEffect(() => {
    if (id) return;
    const rows = Array.isArray(list.data) ? list.data : [];
    const firstId = rows[0] ? String((rows[0] as Json).id ?? '') : '';
    if (firstId) setId(firstId);
  }, [id, list.data]);
  const showDetail = !!id && !!s.data && detailOpen;

  return (
    <div className={`paneled with-detail${showDetail ? '' : ' detail-closed'}`} style={{ height: '100%', ...cols.style }}>
      <SessionList mode="team" activeId={id} onSelect={setId} pane={cols.side}
        onIntent={(kind, sid) => { setId(sid); setIntent(kind); }} />
      {/* 自动打开第一个团队会话前显示骨架，避免闪一下空状态 */}
      {!id && list.isLoading ? <div style={{ padding: 24 }}><Skel rows={5} /></div> : null}
      {!id && !list.isLoading ? <Empty title="请在左侧对话栏中选择或新建对话" /> : null}
      {id && s.isLoading ? <div style={{ padding: 24 }}><Skel rows={6} /></div> : null}
      {id && s.isError ? <div style={{ padding: 24 }}><Err>{errMsg(s.error)}</Err></div> : null}
      {id && s.data ? (
        /* 以前这里并排渲染两个 aside（SessionView 的文件与执行 + 团队与提案），
           而栅格只有三栏 → 第四块被挤出去。现在合成一个右栏两个页签。 */
        <SessionView key={id} session={s.data as SessionDto} onRefresh={() => { void s.refetch(); }}
          detailOpen={showDetail} onToggleDetail={setDetailOpen} detailResize={cols.detail}
          intent={intent} onIntentDone={() => setIntent('')}
          extraTabs={[{ key: 'team', label: '团队与提案', node: <TeamDetailBody sessionId={id} /> }]} />
      ) : null}
    </div>
  );
}

function TeamDetailBody({ sessionId }: { sessionId: string }) {
  const toast = useToast();
  const people = useQ<Json[]>(['session', sessionId, 'participants'], `/agent/sessions/${sessionId}/participants`, undefined, { refetchMs: 20000 });
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const avatars = new Map(arrOf<Json>(members.data).map((member) => [S(member.user_id ?? member.id), avatarSource(member.avatar)]));
  const [invite, setInvite] = useState(false);
  return (
    <div className="stack office-file-execution team-detail-body">
      <div>
        <div className="side-title cluster">成员<Btn size="sm" variant="ghost" className="right" onClick={() => setInvite(true)}>邀请</Btn></div>
        {arrOf<Json>(people.data).map((p) => (
          <div className="row-meta team-detail-member" key={S(p.user_id ?? p.id)}>
            <Avatar name={S(p.display_name ?? p.name)} src={avatars.get(S(p.user_id ?? p.id))} />
            <span className="grow truncate team-detail-member-name">{S(p.display_name ?? p.name)}</span>
            <Pill plain status>{{ coordinator: '协调者', participant: '参与者', viewer: '仅查看' }[S(p.role)] ?? S(p.role)}</Pill>
          </div>
        ))}
      </div>
      <div className="row-sep" />
      <div>
        <div className="side-title">对话中心</div>
        <div className="cluster"><span className="muted small grow">团队办公会话执行记录可在对话中心中查看</span>
          <Btn size="sm" onClick={() => { window.location.href = `/agent/center?session=${encodeURIComponent(sessionId)}`; }}>打开对话中心</Btn></div>
      </div>
      <div className="row-sep" />
      <div>
        <div className="side-title">工作区变更</div>
        <div className="muted small">暂无工作区变更</div>
      </div>
      {invite ? <InviteDialog sessionId={sessionId} onClose={() => setInvite(false)} onDone={() => { setInvite(false); people.refetch(); toast('已邀请'); }} /> : null}
    </div>
  );
}

function InviteDialog({ sessionId, onClose, onDone }: { sessionId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const [who, setWho] = useState('');
  const [role, setRole] = useState<'participant' | 'viewer' | 'coordinator'>('participant');
  return (
    <Modal title="邀请成员加入团队会话" sub="三种角色：查看 / 参与 / 协调；邀请不自动授予工作区内容访问权" onClose={onClose}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>取消</Btn>
        <Btn variant="primary" disabled={!who} disabledReason="先选择成员" onClick={async () => {
          try { await api.post(`/agent/sessions/${sessionId}/participants`, { user_id: who, role }); onDone(); }
          catch (e) { toast(errMsg(e), true); }
        }}>邀请</Btn>
      </>}>
      <div className="stack">
        <div className="stack" style={{ maxHeight: 260, overflow: 'auto' }}>
          {arrOf<Json>(members.data).map((m) => (
            <Check key={S(m.user_id ?? m.id)} checked={who === S(m.user_id ?? m.id)} onChange={(v) => setWho(v ? S(m.user_id ?? m.id) : '')}>
              {S(m.display_name)} · {S(m.title)}
            </Check>
          ))}
        </div>
        <div className="cluster">
          {(['participant', 'viewer', 'coordinator'] as const).map((r) => (
            <Btn key={r} size="sm" variant={role === r ? 'primary' : 'default'} onClick={() => setRole(r)}>
              {{ participant: '参与', viewer: '查看', coordinator: '协调' }[r]}
            </Btn>
          ))}
        </div>
        {role === 'coordinator' ? <Note tone="warn">协调者可管理成员与暂停受影响运行，但不能替他人签署共同确认。</Note> : null}
      </div>
    </Modal>
  );
}
