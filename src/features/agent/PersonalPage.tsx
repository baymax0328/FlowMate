// FlowMate · Agent / 个人办公（PRD §09）：选工作区 → 工作 → 草稿 / 共享 / 新建团队分支
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { errMsg, usePageCols, useQ, useUrlState, usePersistentState, type Json } from '../../api/hooks';
import { Empty, Err, Skel } from '../../components/ui';
import { SessionList, SessionView, type SessionDto } from './session-ui';

export default function PersonalPage() {
  const {params,update}=useUrlState({s:''});
  const id=params.s;
  const setId=(value:string)=>update({s:value});
  const [detailOpen, setDetailOpen] = usePersistentState('office.personal.detail',false);
  /** 会话行「···」里点「选择工作区 / 新建团队分支」：先选中该会话，再把意图交给 SessionView 开弹窗 */
  const [intent, setIntent] = useState<'' | 'workspace' | 'branch'>('');
  const cols = usePageCols('agent');                     // 第二列与右栏都可拖宽
  const s = useQ<SessionDto>(['session', 'personal', id], `/agent/sessions/${id || 'none'}`, undefined, { enabled: !!id, refetchMs: 15000 });
  // 与左栏共用同一个查询键：不会多发一次请求，只是页面也要知道「第一个会话是谁」
  const list = useQ<Json[]>(['sessions', 'personal'], '/agent/sessions', { mode: 'personal' });
  // 需求：进来就默认打开第一个会话（只在没有 ?s= 时兜底，不覆盖用户显式指定的会话）
  useEffect(() => {
    if (id) return;
    const rows = Array.isArray(list.data) ? list.data : [];
    const first = rows[0];
    const firstId = first ? String((first as Json).id ?? '') : '';
    if (firstId) setId(firstId);
  }, [id, list.data]);
  // 右栏收起时整块栅格退回两栏，中间工作区横向扩到右边缘（不留空列、不放占位文案）
  const showDetail = !!id && !!s.data && detailOpen;

  return (
    <div className={`paneled with-detail${showDetail ? '' : ' detail-closed'}`} style={{ height: '100%', ...cols.style }}>
      <SessionList mode="personal" activeId={id}
        onSelect={(v) => { setId(v); }}
        onIntent={(kind, sid) => { setId(sid); setIntent(kind); }}
        pane={cols.side} />
      {!id && list.isLoading ? <div style={{ padding: 24 }}><Skel rows={5} /></div> : null}
      {!id && !list.isLoading ? <Empty title="请在左侧对话栏中选择或新建对话" /> : null}
      {id && s.isLoading ? <div style={{ padding: 24 }}><Skel rows={6} /></div> : null}
      {id && s.isError ? <div style={{ padding: 24 }}><Err>{errMsg(s.error)}</Err></div> : null}
      {id && s.data ? (
        <SessionView key={id} session={s.data as SessionDto} onRefresh={() => { void s.refetch(); }}
          detailOpen={showDetail} onToggleDetail={setDetailOpen} detailResize={cols.detail}
          intent={intent} onIntentDone={() => setIntent('')} />
      ) : null}
    </div>
  );
}
