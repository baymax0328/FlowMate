// FlowMate · 登录（§20 账号：邮箱密码登录；错误不暴露账号是否存在；§21 种子账号 + 测试环境身份切换）
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errMsg, useQ, type Json } from '../api/hooks';
import { useSession } from './session';
import { Btn, Field, useToast } from '../components/ui';
import flowmateLogo from '../assets/flowmate-logo.svg';

export function LoginPage() {
  const nav = useNavigate();
  const { login, me } = useSession();
  const toast = useToast();
  const [email, setEmail] = useState('baymax@xingyu.test');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const demo = useQ<{ enabled: boolean; accounts: Json[] }>(['demo-accounts'], '/auth/demo-accounts', undefined, { retry: 0 });

  useEffect(() => { if (me?.user) nav('/message', { replace: true }); }, [me, nav]);

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await login(email.trim(), password);
      toast('已登录');
      nav('/message', { replace: true });
    } catch (x) {
      setErr(errMsg(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-art">
        <svg className="login-ribbon" viewBox="0 0 620 500" fill="none" aria-hidden="true">
          <defs><linearGradient id="ribbon-shade" x1="80" y1="0" x2="480" y2="450" gradientUnits="userSpaceOnUse"><stop stopColor="#fff"/><stop offset=".5" stopColor="#c8dcd2"/><stop offset="1" stopColor="#89b19d"/></linearGradient><linearGradient id="ribbon-fold" x1="200" y1="100" x2="460" y2="450" gradientUnits="userSpaceOnUse"><stop stopColor="#bed3c8"/><stop offset="1" stopColor="#eff5ef"/></linearGradient></defs>
          <circle cx="330" cy="255" r="193" stroke="#b9cec270"/><circle cx="330" cy="255" r="145" stroke="#fff"/>
          <path d="M118 330C50 210 151 71 299 95c162 26 180 241 91 282-61 28-149-42-137-111 10-62 88-106 159-68 90 48 86 176-6 231" stroke="url(#ribbon-shade)" strokeWidth="58" strokeLinecap="round"/>
          <path d="M299 95c162 26 180 241 91 282-61 28-149-42-137-111" stroke="url(#ribbon-fold)" strokeWidth="58" strokeLinecap="round"/>
          <circle cx="126" cy="126" r="9" fill="#6caa8b"/><circle cx="491" cy="385" r="5" fill="#bfad8e"/>
        </svg>
        <h1 className="login-h1"><span className="login-name">FlowMate</span><br /><span className="login-tag">AI 原生协作工作台</span></h1>
        <p>面向任务协作的 AI 办公平台</p>
        <div className="login-list">
          <span>Message · 人与人的会话</span>
          <span>Workspace · 文件与版本</span>
          <span>Agent · 绑定工作区的个人与团队执行</span>
          <span>Task · 责任与验收</span>
        </div>
      </div>

      <div className="login-panel">
        <form className="login-card" onSubmit={submit}>
          <div className="login-card-brand">
            <img src={flowmateLogo} alt="" width="48" height="48" />
            <strong>FlowMate</strong>
          </div>
          <h2>登录</h2>
          {err ? <div style={{ marginBottom: 16 }}><ErrNote text={err} /></div> : null}
          <Field label="邮箱">
            <input type="email" required value={email} autoComplete="username" onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="密码" hint="种子账号密码见 README（默认 abc123）">
            <input type="password" required value={password} autoComplete="current-password" onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Btn type="submit" variant="primary" loading={busy} className="login-submit">登录</Btn>

          {demo.data?.enabled ? (
            <div style={{ marginTop: 24 }}>
              <div className="pop-title" style={{ padding: '0 0 6px' }}>测试环境身份切换（仅演示用，界面已标记）</div>
              <div className="btn-group">
                {(demo.data.accounts ?? []).map((a: Json) => (
                  <button key={String(a.email)} type="button" className={`btn sm${email === a.email ? ' primary' : ''}`}
                    onClick={() => { setEmail(String(a.email)); setPassword(String(a.password ?? 'abc123')); }}>
                    {String(a.display_name)} · {String(a.title ?? '')}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function ErrNote({ text }: { text: string }) {
  return <div className="err">{text}</div>;
}
export { api };
