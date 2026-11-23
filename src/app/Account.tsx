// FlowMate · 账户与成员管理（PRD §03 账户菜单、§20 组织角色、§21 种子账号）
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, errMsg, fmtDate, jsonOf, useQ, type Json } from '../api/hooks';
import { Btn, Check, Empty, Err, Field, Modal, Note, Pill, Skel, useToast } from '../components/ui';
import { useSession } from './session';

const S = (v: unknown, f = ''): string => (v === null || v === undefined || v === '' ? f : String(v));

export function AccountPage() {
  const { me, refresh } = useSession();
  const toast = useToast();
  const prefs = jsonOf<Json>((me?.user as unknown as Record<string, unknown> | undefined)?.prefs, {}) as Json;
  const [p, setP] = useState<Json>({ mention_notifications: prefs.mention_notifications !== false, approval_notifications: p_default(prefs) });
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const busy = useState(false);
  const org = (me?.orgs ?? [])[0];

  return (
    <div className="paneled account-page" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
      <section className="work account-work" style={{ padding: 28 }}>
        <h1 style={{ marginBottom: 4 }}>设置</h1>
        {err ? <div style={{ marginBottom: 16 }}><Err>{err}</Err></div> : null}
        <div className="card stack">
          <div className="card-title">资料</div>
          <div className="dl">
            <dt>姓名</dt><dd>{S(me?.user.display_name)}</dd>
            <dt>邮箱</dt><dd>{S(me?.user.email)}</dd>
            <dt>职务</dt><dd>{S(me?.user.title, '未填写')}</dd>
            <dt>已加入组织</dt><dd>{(me?.orgs ?? []).map((o) => `${o.name}（${roleCn(o.role)}）`).join('、')}</dd>
          </div>
        </div>
        <div className="card stack" style={{ marginTop: 16 }}>
          <div className="card-title">通知偏好</div>
          <Check checked={!!p.mention_notifications} onChange={(v) => setP({ ...p, mention_notifications: v })}>有人 @ 我时通知</Check>
          <Check checked={!!p.approval_notifications} onChange={(v) => setP({ ...p, approval_notifications: v })}>团队办公中有待我共同确认时通知</Check>
          <div className="cluster" style={{ marginTop: 8 }}>
            <Btn size="sm" variant="primary" onClick={async () => {
              try { await api.patch('/auth/profile', { prefs: p }); toast('已保存偏好'); refresh(); } catch (e) { setErr(errMsg(e)); }
            }}>保存偏好</Btn>
          </div>
        </div>
        <div className="card stack" style={{ marginTop: 16 }}>
          <div className="card-title">界面</div>
          <Check checked={localStorage.getItem('fm.lannotice') !== '0'} onChange={(v) => {
            localStorage.setItem('fm.lannotice', v ? '1' : '0');
            toast(v ? '顶部环境提醒将重新显示' : '顶部环境提醒已收起');
            window.location.reload();
          }}>在顶栏显示「局域网测试环境」提醒</Check>
        </div>
        <div className="card stack" style={{ marginTop: 16 }}>
          <div className="card-title">修改密码</div>
          <Field label="当前密码"><input type="password" required value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
          <Field label="新密码" hint="改密后其他登录会话会失效"><input type="password" required value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
          <div><Btn size="sm" loading={busy[0]} onClick={async () => {
            busy[1](true); setErr(null);
            try { await api.post('/auth/password', { currentPassword: cur, newPassword: next }); toast('已修改'); setCur(''); setNext(''); }
            catch (e) { setErr(errMsg(e)); } finally { busy[1](false); }
          }}>修改密码</Btn></div>
        </div>
        {me?.demo_mode ? <div style={{ marginTop: 16 }}><Note tone="warn">测试环境：登录页可一键切换演示身份（{S(org?.name)}）。生产环境请设 FLOWMATE_DEMO=0 关闭。</Note></div> : null}
      </section>
    </div>
  );
}

function p_default(prefs: Json) { return prefs.approval_notifications !== false; }
function roleCn(r: string) { return ({ owner: '所有者', admin: '管理员', member: '成员' } as Record<string, string>)[r] ?? r; }

export function MembersPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const { me } = useSession();
  const members = useQ<Json[]>(['members'], '/organizations/members');
  const [invite, setInvite] = useState(false);
  const rows = jsonOf<Json[]>(members.data, []);
  const canManage = (me?.orgs ?? []).some((o) => o.role === 'owner' || o.role === 'admin');
  return (
    <div className="paneled members-page" style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
      <section className="work" style={{ padding: 24 }}>
        <div className="cluster" style={{ marginBottom: 12 }}>
          <h1 className="grow members-title">成员管理</h1>
          {canManage ? <Btn size="sm" variant="primary" onClick={() => setInvite(true)}>生成邀请</Btn> : <Pill plain tone="idle">当前组织内你没有成员管理权</Pill>}
        </div>
        {members.isLoading ? <Skel rows={4} /> : null}
        {members.isError ? <Err>{errMsg(members.error)}</Err> : null}
        {!rows.length && !members.isLoading ? <Empty title="还没有成员" /> : null}
        <div className="table-wrap"><table className="grid members-table">
          <thead><tr><th>成员</th><th>邮箱</th><th>组织角色</th><th>账号</th><th>所在团队</th><th>加入时间</th><th style={{ width: 240 }}>操作</th></tr></thead>
          <tbody>{rows.map((m) => (
            <tr key={S(m.id ?? m.user_id)}>
              <td>{S(m.display_name)}<div className="muted small">{S(m.title)}</div></td>
              <td className="small">{S(m.email)}</td>
              <td><Pill plain status>{roleCn(S(m.role))}</Pill></td>
              <td><Pill status={m.status === 'disabled' ? 'disabled' : 'active'} /></td>
              <td className="small">{jsonOf<Json[]>(m.teams, []).map((t) => S(t.name)).join('、') || '—'}</td>
              <td className="small">{fmtDate(S(m.created_at))}</td>
              <td className="cluster">{canManage ? <>
                <Btn size="sm" variant="ghost" onClick={async () => {
                  const role = S(m.role) === 'admin' ? 'member' : 'admin';
                  try { await api.patch(`/members/${S(m.id ?? m.user_id)}`, { role }); toast('角色已更新'); members.refetch(); } catch (e) { toast(errMsg(e), true); }
                }}>{S(m.role) === 'admin' ? '降为成员' : '设为管理员'}</Btn>
                <Btn size="sm" variant="danger" onClick={async () => {
                  const disable = S(m.status) !== 'disabled';
                  try { await api.patch(`/members/${S(m.id ?? m.user_id)}`, { status: disable ? 'disabled' : 'active' }); toast(disable ? '已停用（登录会话与实时连接已断开）' : '已恢复'); members.refetch(); qc.invalidateQueries({ queryKey: ['me'] }); }
                  catch (e) { toast(errMsg(e), true); }
                }}>{S(m.status) === 'disabled' ? '恢复账号' : '停用账号'}</Btn>
              </> : null}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      {invite ? <InviteDialog onClose={() => setInvite(false)} onDone={() => { setInvite(false); toast('邀请已生成'); }} /> : null}
    </div>
  );
}

function InviteDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const teams = useQ<Json[]>(['teams'], '/teams');
  const [f, setF] = useState<Json>({ email: '', display_name: '', role: 'member', team_ids: [] as string[] });
  const [code, setCode] = useState('');
  return (
    <Modal title="邀请成员" sub="邮箱 + 初始密码；受邀人登录后可在组织切换中看到该组织" onClose={onClose}
      footer={<>
        <Btn variant="ghost" onClick={onClose}>关闭</Btn>
        <Btn variant="primary" onClick={async () => {
          try { const r = await api.post<Json>('/invites', { ...f, password: 'Flowmate#2026' }); setCode(S((r as Json).code ?? (r as Json).invite_code)); onDone(); toast('已生成邀请'); }
          catch (e) { toast(errMsg(e), true); }
        }}>生成邀请</Btn>
      </>}>
      <div className="stack">
        <Field label="邮箱" required><input type="email" value={S(f.email)} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="姓名" required><input type="text" value={S(f.display_name)} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="角色"><select value={S(f.role)} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="member">成员</option><option value="admin">管理员</option></select></Field>
        <Field label="加入团队">
          <div className="stack">{(teams.data ?? []).map((t) => (
            <Check key={S(t.id)} checked={(f.team_ids as string[]).includes(S(t.id))}
              onChange={(v) => setF({ ...f, team_ids: v ? [...(f.team_ids as string[]), S(t.id)] : (f.team_ids as string[]).filter((x) => x !== S(t.id)) })}>{S(t.name)}</Check>
          ))}</div>
        </Field>
        {code ? <Note>邀请码：<span className="mono">{code}</span>（初始密码 Flowmate#2026，仅演示环境）</Note> : null}
      </div>
    </Modal>
  );
}
