// FlowMate · Agent / Center（PRD §12）：运行 / 变更 / 冲突 / 事件 + 详情侧栏 + 用量抽屉
// 只读为主，处理动作与 Team 页共用同一业务服务与权限；不把 AI 成功标成任务完成。
import { useMemo, useState } from 'react';
const CONFLICT_LABEL: Record<string, string> = { order: '确认顺序', option_a: '采用先前请求', option_b: '采用后续请求', clarify: '请求澄清' };
import { useSearchParams } from 'react-router-dom';
import { api, arrOf, errMsg, fmtRel, fmtSize, jsonOf, useM, usePageCols, useQ, usePersistentState, type Json } from '../../api/hooks';
import { Btn, ColResizer, Diff, Empty, Err, Modal, Note, Pill, Skel, SubTabs, Tabs, useToast, wordOf } from '../../components/ui';

const S = (v: unknown, f: string | number = ''): string => (v === null || v === undefined || v === '' ? String(f) : String(v));
const N = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export default function CenterPage() {
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = usePersistentState<'runs' | 'changes' | 'conflicts' | 'events'>('center.tab','runs');
  const [status, setStatus] = usePersistentState('center.status','');
  // 从团队办公会话「进入对话中心」带过来的会话过滤（?session=）
  const [sessionFilter, setSessionFilter] = useState(sp.get('session') ?? '');
  const [sel, setSel] = useState<{ type: string; id: string } | null>({ type: sp.get('proposal') ? 'proposal' : sp.get('run') ? 'run' : '', id: S(sp.get('proposal') ?? sp.get('run')) } as never);
  const [usageOpen, setUsageOpen] = useState(false);
  // 右栏「运行详情 / 提案详情」可收起；收起后中间表格扩到右侧，不留空列
  const [detailOpen, setDetailOpen] = usePersistentState('center.detail-open',false);
  const cols = usePageCols('center');
  const [diffView, setDiffView] = useState<{ title: string; patch: string } | null>(null);
  const scoped = sessionFilter ? { session_id: sessionFilter } : undefined;

  const ov = useQ<Json>(['center', 'overview'], '/center/overview', undefined, { refetchMs: 8000 });
  const runs = useQ<Json[]>(['center', 'runs', status, sessionFilter], '/center/runs', { status: status || undefined, session_id: sessionFilter || undefined, limit: 100 });
  const changes = useQ<Json[]>(['center', 'changes', sessionFilter], '/center/changes', scoped, { enabled: tab === 'changes', refetchMs: 10000 });
  const conflicts = useQ<Json[]>(['center', 'conflicts'], '/center/conflicts', undefined, { enabled: tab === 'conflicts' });
  const events = useQ<Json[]>(['center', 'events', sessionFilter], '/center/events', { limit: 120, session_id: sessionFilter || undefined }, { enabled: tab === 'events' });
  const sessionTitle = useQ<Json>(['session', sessionFilter || 'none'], sessionFilter ? `/agent/sessions/${sessionFilter}` : '/agent/sessions/none', undefined, { enabled: !!sessionFilter });

  const nums = (ov.data ?? {}) as Json;
  const filters: { key: string; label: string; n: number }[] = [
    { key: 'running', label: '运行', n: N(nums.running) ?? 0 },
    { key: 'queued', label: '排队', n: N(nums.queued) ?? 0 },
    { key: 'waiting_input', label: '待输入', n: N(nums.waiting_input) ?? 0 },
    { key: 'waiting_approval', label: '待确认', n: N(nums.waiting_approval) ?? 0 },
    { key: 'blocked', label: '挂起', n: (N(nums.blocked) ?? 0) + (N(nums.suspended) ?? 0) },
    { key: 'failed', label: '失败', n: N(nums.failed) ?? 0 },
    { key: 'succeeded', label: '完成', n: N(nums.succeeded) ?? 0 },
  ];

  return (
    <div className={`paneled detail-only detail-wide${detailOpen ? '' : ' detail-closed'}`} style={{ height: '100%', ...cols.style }}>
      <section className="work">
        <div className="card-head" style={{ padding: '12px 16px', borderBottom: '1px solid var(--line)', margin: 0, flexWrap: 'wrap' }}>
          <div className="grow">
            <div className="card-title">对话中心</div>
            <div className="card-sub">授权范围内跨团队的运行、变更、冲突与事件 · 每会话 {S(nums.slots_per_session, 2)} 个执行槽</div>
          </div>
          {sessionFilter ? (
            <span className="cluster" style={{ gap: 6 }}>
              <Pill tone="info">只看：{S(sessionTitle.data?.title, `${sessionFilter.slice(0, 8)}…`)}</Pill>
              <Btn size="sm" variant="ghost" onClick={() => { setSessionFilter(''); setSp({}, { replace: true }); }}>看全部</Btn>
            </span>
          ) : null}
          {!detailOpen ? <Btn size="sm" onClick={() => setDetailOpen(true)}>运行详情</Btn> : null}
          <Btn size="sm" onClick={() => setUsageOpen(true)}>用量</Btn>
          <Btn size="sm" variant="ghost" onClick={() => { ov.refetch(); runs.refetch(); }}>刷新</Btn>
        </div>

        <div className="flow" style={{ gridAutoFlow: 'column' }}>
          {filters.map((f) => (
            <button key={f.key} className={`stage${f.key === 'blocked' || f.key === 'waiting_approval' ? ' hint-wait' : ''}`}
              aria-pressed={status === f.key} onClick={() => { setStatus(status === f.key ? '' : f.key); setTab('runs'); }}>
              <div className="stage-no">{String(filters.indexOf(f) + 1).padStart(2, '0')}</div>
              <div className="stage-name">{f.label}</div>
              <div className="stage-n">{f.n}</div>
            </button>
          ))}
        </div>

        <SubTabs value={tab} onChange={setTab} items={[
          { key: 'runs', label: '执行列表', n: arrOf<Json>(runs.data).length },
          { key: 'changes', label: '文件变更', n: arrOf<Json>(changes.data).length },
          { key: 'conflicts', label: '冲突队列', n: arrOf<Json>(conflicts.data).length },
          { key: 'events', label: '协作事件', n: arrOf<Json>(events.data).length },
        ]} />

        <div className="grow" style={{ overflow: 'auto' }}>
          {tab === 'runs' ? (
            <>
              {runs.isLoading ? <div style={{ padding: 16 }}><Skel rows={6} /></div> : null}
              {runs.isError ? <div style={{ padding: 16 }}><Err>{errMsg(runs.error)}</Err></div> : null}
              {status ? <div style={{ padding: '8px 16px 0' }}><Note>已按「{wordOf(status)}」过滤 · <button className="btn-link" onClick={() => setStatus('')}>清除</button></Note></div> : null}
              <div className="table-wrap" style={{ border: 0 }}>
                <table className="grid">
                  <thead><tr><th>子任务</th><th>发起人</th><th>状态</th><th style={{ width: 90 }}>尝试</th><th style={{ width: 120 }}>开始</th><th>排队原因 / 错误</th></tr></thead>
                  <tbody>
                    {arrOf<Json>(runs.data).map((r) => (
                      <tr key={S(r.id)} style={sel?.id === S(r.id) ? { background: '#F4F8F3' } : undefined}>
                        <td><button className="btn-link" onClick={() => { setSel({ type: 'run', id: S(r.id) }); setDetailOpen(true); setSp({ run: S(r.id) }, { replace: true }); }}>{S(r.subtask_name)}</button>
                          <div className="muted small">{S(r.session_title)} · {S(r.goal).slice(0, 40)}</div></td>
                        <td>{S(r.creator_name)}</td>
                        <td><Pill status={S(r.status)} />{r.planner === 'deterministic' ? <Pill plain tone="idle">本地规划器</Pill> : null}</td>
                        <td className="num">{S(r.attempt)}</td>
                        <td className="small">{fmtRel(S(r.started_at ?? r.created_at))}</td>
                        <td className="small muted">{S(r.queue_reason ?? r.error_message ?? r.error_code, '—')}</td>
                      </tr>
                    ))}
                    {!runs.isLoading && !arrOf<Json>(runs.data).length ? <tr><td colSpan={6}><Empty title="没有运行记录" body="去团队办公会话里把一条明确的目标交给 Agent。" /></td></tr> : null}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {tab === 'changes' ? (
            <div className="table-wrap" style={{ border: 0 }}>
              <table className="grid">
                <thead><tr><th>文件</th><th>基准 → 目标</th><th>提案</th><th>确认</th><th>状态</th><th style={{ width: 150 }} /></tr></thead>
                <tbody>
                  {arrOf<Json>(changes.data).map((c) => (
                    <tr key={S(c.id)}>
                      <td>{S(c.target_name)}<div className="muted small">{S(c.summary)}</div></td>
                      <td className="small">v{S(c.base_version_no)}{c.committed_version_no ? ` → v${S(c.committed_version_no)}` : ' → 待写入'}</td>
                      <td className="small">r{S(c.revision)} · {fmtRel(S(c.created_at))}</td>
                      <td><Pill tone="count">{S(c.approval_count)}/{S(c.needed_count)}</Pill></td>
                      <td><Pill status={S(c.status)} />{c.final_reason ? <div className="muted small">{S(c.final_reason).slice(0, 40)}</div> : null}</td>
                      <td className="cluster">
                        <Btn size="sm" onClick={() => { setSel({ type: 'proposal', id: S(c.id) }); setDetailOpen(true); setSp({ proposal: S(c.id) }, { replace: true }); }}>详情</Btn>
                        <Btn size="sm" variant="ghost" onClick={async () => {
                          const t = await api.get<Json>(`/proposals/${S(c.id)}/diff`);
                          setDiffView({ title: `差异 · ${S(c.target_name)}`, patch: S((t as Json).patch ?? t) });
                        }}>差异</Btn>
                      </td>
                    </tr>
                  ))}
                  {!arrOf<Json>(changes.data).length ? <tr><td colSpan={6}><Empty title="还没有正式变更提案" /></td></tr> : null}
                </tbody>
              </table>
            </div>
          ) : null}

          {tab === 'conflicts' ? (
            <div className="stack" style={{ padding: 16 }}>
              {!arrOf<Json>(conflicts.data).length ? <Empty title="冲突队列是空的" body="确定性冲突（同文件 / 版本 / 路径 / 写集 / 依赖）与语义冲突都会进这里。" /> : null}
              {arrOf<Json>(conflicts.data).map((c) => (
                <div className="exec wait" key={S(c.id)}>
                  <div className="exec-head"><Pill status={S(c.status)} /><b>{S(c.type_label ?? c.type)}</b><span className="mono">{S(c.resource_key)}</span>
                    {c.basis === 'model_assisted' ? <Pill plain tone="info">模型辅助判断（不作为唯一锁）</Pill> : <Pill plain tone="idle">确定性</Pill>}
                    <span className="right">{fmtRel(S(c.created_at))}</span></div>
                  <div className="exec-body small">{S(c.detail)}</div>
                  <div className="exec-meta">影响 {jsonOf<string[]>(c.affected_ids, []).length} 个对象{jsonOf<string[]>(c.waiting_on, []).length ? ` · 在等 ${jsonOf<string[]>(c.waiting_on, []).length} 人表态` : ''}</div>
                  {S(c.status) === 'open' ? (
                    <div className="cluster" style={{ marginTop: 8 }}>
                      {(['order', 'option_a', 'option_b', 'clarify'] as const).map((r) => (
                        <Btn key={r} size="sm" onClick={async () => {
                          try { await api.post(`/conflicts/${S(c.id)}/resolve`, { resolution: r, note: '在对话中心处理' }); toast('已处理'); conflicts.refetch(); }
                          catch (e) { toast(errMsg(e), true); }
                          }}>{CONFLICT_LABEL[r]}</Btn>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              <Note tone="warn">业务矛盾会展示双方请求并暂停相关部分，不采用「最后消息优先」；正式修改仍需相关指令人全部确认。</Note>
            </div>
          ) : null}

          {tab === 'events' ? (
            <div className="stack" style={{ padding: '8px 16px' }}>
              {arrOf<Json>(events.data).map((e) => (
                <div className="row-meta" key={S(e.seq)} style={{ padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                  <Pill plain status>{S(e.actor_name, '系统')}</Pill>
                  <span className="grow">{S(e.type)}</span>
                  <button className="btn-link small" onClick={() => {
                    if (S(e.entity_type) === 'run') setSel({ type: 'run', id: S(e.entity_id) });
                    else if (S(e.entity_type) === 'proposal') setSel({ type: 'proposal', id: S(e.entity_id) });
                    else if (e.session_id) window.location.href = `/agent/team?s=${S(e.session_id)}`;
                  }}>{S(e.entity_type)} {S(e.entity_id).slice(0, 8)}</button>
                  <span className="muted nowrap">{fmtRel(S(e.occurred_at))}</span>
                </div>
              ))}
              {!arrOf<Json>(events.data).length ? <Empty title="还没有协作事件" /> : null}
            </div>
          ) : null}
        </div>
      </section>

      {detailOpen ? (
      <aside className="detail">
        <ColResizer edge="left" onResizeStart={cols.detail.onResizeStart} onNudge={cols.detail.nudge} label="拖动调整详情栏宽度" />
        <div className="detail-head"><b className="grow">{sel?.type === 'proposal' ? '提案详情' : '运行详情'}</b>{sel ? <Btn size="sm" variant="ghost" onClick={() => { setDetailOpen(false); setSel(null); setSp({}, { replace: true }); }}>收起</Btn> : null}</div>
        <div className="detail-body">
          {!sel ? <div className="muted small">点左侧任一 Run 或提案查看请求、工具调用步骤、读取版本清单与影响对象。</div> : null}
          {sel?.type === 'run' ? <RunDetail runId={sel.id} onDiff={(t, p) => setDiffView({ title: t, patch: p })} /> : null}
          {sel?.type === 'proposal' ? <ProposalDetail proposalId={sel.id} onDiff={(t, p) => setDiffView({ title: t, patch: p })} onChanged={() => { changes.refetch(); ov.refetch(); }} /> : null}
        </div>
      </aside>

      ) : null}
      {usageOpen ? <UsageDrawer onClose={() => setUsageOpen(false)} /> : null}
      {diffView ? <Modal title={diffView.title} wide onClose={() => setDiffView(null)} footer={<Btn onClick={() => setDiffView(null)}>关闭</Btn>}><Diff text={diffView.patch} /></Modal> : null}
    </div>
  );
}

function RunDetail({ runId, onDiff }: { runId: string; onDiff: (t: string, p: string) => void }) {
  const toast = useToast();
  const r = useQ<Json>(['run', runId], `/runs/${runId}`, undefined, { refetchMs: 6000 });
  const d = (r.data ?? {}) as Json;
  if (r.isLoading) return <Skel rows={5} />;
  if (r.isError) return <Err>{errMsg(r.error)}</Err>;
  return (
    <div className="stack">
      <div className="cluster"><Pill status={S(d.status)} /><b className="grow">{S(d.subtask_name)}</b><span className="muted small">第 {S(d.attempt)} 次尝试</span></div>
      <div className="dl">
        <dt>原请求</dt><dd>{S(d.goal).slice(0, 160)}</dd>
        <dt>发起人</dt><dd>{S(d.creator_name)} · {S(d.session_title)}</dd>
        <dt>规划来源</dt><dd>{d.planner === 'deterministic' ? '本地确定性规划器（未调用模型）' : '模型'}</dd>
        <dt>排队原因</dt><dd>{S(d.queue_reason, '—')}</dd>
        <dt>租约</dt><dd>{d.lease_expires_at ? `至 ${fmtRel(S(d.lease_expires_at))}` : '未占用'} · fencing {S(d.lease_token ?? '—')}</dd>
        <dt>错误</dt><dd>{S(d.error_code ?? d.error_message, '无')}</dd>
      </div>
      <div className="side-title">工具调用步骤（{jsonOf<Json[]>(d.steps, []).length}）</div>
      <ul className="exec-steps">
        {jsonOf<Json[]>(d.steps, []).map((s, i) => (
          <li key={i}><code>{S(s.step_index)}.{S(s.tool_name)}</code>
            <span className="grow truncate mono small">{JSON.stringify(jsonOf<Json>(s.args_digest, {}))}</span>
            <Pill plain tone={S(s.status) === 'success' ? 'ok' : 'bad'}>{S(s.status) === 'success' ? `${fmtSize(N(s.output_bytes))} · ${S(s.duration_ms)}ms` : S(s.error_code)}</Pill></li>
        ))}
      </ul>
      <div className="side-title">本次读取（固定版本清单）</div>
      {jsonOf<Json[]>(d.read_manifest, []).length ? jsonOf<Json[]>(d.read_manifest, []).map((m) => (
        <div className="row-meta" key={S(m.version_id)}><span className="grow truncate">{S(m.name)}</span><Pill plain status>v{S(m.version_no)}</Pill>
          <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/workspace?focus=${S(m.file_id)}`; }}>查看文件</Btn></div>
      )) : <div className="muted small">本次未读取文件。</div>}
      <div className="side-title">产物</div>
      {jsonOf<Json[]>(d.artifacts, []).length ? jsonOf<Json[]>(d.artifacts, []).map((a) => (
        <div className="row-meta" key={S(a.id)}><span className="grow truncate">{S(a.name)}</span><Pill status={S(a.status)} />
          <Btn size="sm" variant="ghost" onClick={async () => {
            try { const c = await api.get<{ content: string }>(`/agent/artifacts/${S(a.id)}/content`); onDiff(S(a.name), S((c as Json).content)); } catch (e) { toast(errMsg(e), true); }
          }}>预览</Btn></div>
      )) : <div className="muted small">无</div>}
      <div className="cluster">
        {['failed', 'cancelled'].includes(S(d.status)) ? <Btn size="sm" onClick={async () => { await api.post(`/runs/${runId}/retry`); r.refetch(); }}>重试</Btn> : null}
        {['running', 'queued', 'planning', 'waiting_input'].includes(S(d.status)) ? <Btn size="sm" variant="danger" onClick={async () => { await api.post(`/runs/${runId}/cancel`, { reason: 'Center 取消' }); r.refetch(); }}>取消</Btn> : null}
        {d.source_message_id ? <Btn size="sm" variant="ghost" onClick={() => { window.location.href = `/agent/team?s=${S(d.session_id)}`; }}>返回消息位置</Btn> : null}
      </div>
      <Note>运行成功不等于任务完成；采用与验收仍需人来判定。</Note>
    </div>
  );
}

function ProposalDetail({ proposalId, onDiff, onChanged }: { proposalId: string; onDiff: (t: string, p: string) => void; onChanged: () => void }) {
  const toast = useToast();
  const p = useQ<Json>(['proposal', proposalId], `/proposals/${proposalId}`, undefined, { refetchMs: 8000 });
  const d = (p.data ?? {}) as Json;
  if (p.isLoading) return <Skel rows={5} />;
  if (p.isError) return <Err>{errMsg(p.error)}</Err>;
  const act = async (path: string, body?: Json) => {
    try { await api.post(`/proposals/${proposalId}/${path}`, body ?? {}); toast('已处理'); p.refetch(); onChanged(); } catch (e) { toast(errMsg(e), true); p.refetch(); }
  };
  return (
    <div className="stack">
      <div className="cluster"><Pill status={S(d.status)} /><b className="grow">{S(d.target_name)}</b><Pill tone="count">{S(d.approval_count)}/{S(d.needed_count)}</Pill></div>
      <div className="dl">
        <dt>请求来源</dt><dd>{S(d.request_goal ?? d.summary, '—')}</dd>
        <dt>基准版本</dt><dd>v{S(d.base_version_no)}（当前 v{S(d.current_version_no, S(d.base_version_no))}）</dd>
        <dt>提案版本</dt><dd>r{S(d.revision)} · diff {S(d.diff_hash).slice(0, 12)}</dd>
        <dt>相关指令人</dt><dd>{jsonOf<string[]>(d.required_approvers, []).length} 人（全部同意才写入）</dd>
        <dt>执行者</dt><dd>{S(d.executor_name, '—')}（需具备文件编辑权）</dd>
        <dt>提醒 / 挂起</dt><dd>{S(d.reminder_count)} 次提醒{d.next_reminder_at ? ` · 下次 ${fmtRel(S(d.next_reminder_at))}` : ''} · 超 72h 未集齐转「已搁置」</dd>
        <dt>影响对象</dt><dd>{S(d.impact_note, '仅该正式文件')}{d.proposed_version_no ? ` · 提案内容 v${S(d.proposed_version_no)}` : ''}</dd>
      </div>
      <div className="cluster">
        <Btn size="sm" onClick={() => void api.get<Json>(`/proposals/${proposalId}/diff`).then((t) => onDiff(`差异 · ${S(d.target_name)}`, S((t as Json).patch ?? t)))}>逐文件差异</Btn>
        {['pending_approval', 'suspended', 'stale'].includes(S(d.status)) ? <>
          <Btn size="sm" onClick={async () => {
            const reason = window.prompt('修改意见（会生成新提案版本，旧确认全部失效）') ?? '';
            if (reason) await act('request-changes', { reason });
          }}>提出修改</Btn>
          <Btn size="sm" variant="danger" onClick={async () => { const reason = window.prompt('拒绝原因（必填）') ?? ''; if (reason) await act('reject', { reason }); }}>拒绝</Btn>
          <Btn size="sm" onClick={async () => { await api.post(`/proposals/${proposalId}/remind`); toast('已催办（不计入自动提醒节奏）'); }}>催办</Btn>
        </> : null}
        {S(d.status) === 'suspended' ? <Btn size="sm" variant="primary" onClick={() => act('wake')}>唤醒</Btn> : null}
        {['pending_approval', 'suspended'].includes(S(d.status)) ? <Btn size="sm" variant="ghost" onClick={async () => { const reason = window.prompt('作废原因') ?? ''; if (reason) await act('void', { action: 'void', reason }); }}>作废提案</Btn> : null}
      </div>
      <div className="side-title">确认记录</div>
      <ul className="exec-steps">{jsonOf<Json[]>(d.approvals, []).map((a, i) => (
        <li key={i}><code>{({ approve: '同意', reject: '拒绝', request_changes: '请求修改' } as Record<string, string>)[S(a.decision)] ?? S(a.decision)}</code>
          <span className="grow">{S(a.user_name)}</span><span className="muted">r{S(a.revision)} · {fmtRel(S(a.created_at))}</span>
          {N(a.active) === 0 ? <Pill plain tone="bad">已失效</Pill> : null}</li>
      ))}
        {!jsonOf<Json[]>(d.approvals, []).length ? <li className="muted">还没有人表态</li> : null}
      </ul>
      {jsonOf<Json[]>(d.revision_history, []).length ? <>
        <div className="side-title">修订历史</div>
        {jsonOf<Json[]>(d.revision_history, []).map((h, i) => <div className="row-meta" key={i}><Pill plain status>r{S(h.revision)}</Pill><span className="grow">{S(h.cause ?? h.reason)}</span><span className="muted">{fmtRel(S(h.created_at))}</span></div>)}
      </> : null}
      <Note tone="warn">内容、基准或相关指令任一变化，旧签名立即不可复用；不存在超时自动通过。</Note>
    </div>
  );
}

function UsageDrawer({ onClose }: { onClose: () => void }) {
  const u = useQ<Json>(['center', 'usage'], '/center/usage');
  const d = (u.data ?? {}) as Json;
  const nullish = (v: unknown) => (v === null || v === undefined ? <b>未获取</b> : String(v));
  return (
    <Modal title="用量" sub="本版只做透明展示，不做配额、限流与绩效排名" onClose={onClose}
      footer={<Btn onClick={onClose}>关闭</Btn>}>
      <div className="dl">
        <dt>模型</dt><dd>{S(d.model) || <b>未获取</b>}</dd>
        <dt>提供方</dt><dd>{S(d.provider) || '未获取'}</dd>
        <dt>调用次数</dt><dd>{nullish(d.calls)}</dd>
        <dt>失败次数</dt><dd>{nullish(d.failures)}</dd>
        <dt>输入 Token</dt><dd>{nullish(d.input_tokens)}</dd>
        <dt>输出 Token</dt><dd>{nullish(d.output_tokens)}</dd>
        <dt>成本粗估</dt><dd>{d.cost_estimate === null || d.cost_estimate === undefined ? '未获取' : `≈ ${S(d.cost_estimate)}`}</dd>
      </div>
      <div style={{ marginTop: 12 }}><Note>{S(d.tokens_note, '未知用量显示「未获取」而不是 0。')}</Note></div>
    </Modal>
  );
}

void useMemo; void Tabs;
