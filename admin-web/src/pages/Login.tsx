import { useState, type FormEvent } from 'react';
import logo from '../eko-mark.png';
import { useAuth } from '../lib/auth';
import { errorText, useI18n } from '../lib/i18n';

export function Login() {
  const { t, lang, setLang } = useI18n();
  const { signIn, notice } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await signIn(email, password);
    setBusy(false);
    if (res) setErr(/invalid login/i.test(res) ? t('wrongLogin') : errorText(t, res));
    setPassword('');
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <div className="row between">
          <img src={logo} alt="EKO" width={56} height={56} />
          <button type="button" className="btn btn-sm" onClick={() => setLang(lang === 'sq' ? 'en' : 'sq')}>
            {lang === 'sq' ? 'EN' : 'SQ'}
          </button>
        </div>
        <h1>{t('loginTitle')}</h1>
        <p className="muted">{t('loginHint')}</p>
        {notice && <div className="alert alert-warn">{t(notice)}</div>}
        {err && <div className="alert alert-error">{err}</div>}
        <label>
          {t('email')}
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="email" />
        </label>
        <label>
          {t('password')}
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="password" />
        </label>
        <button className="btn btn-primary btn-block" disabled={busy} data-testid="login">
          {busy ? t('loading') : t('login')}
        </button>
      </form>
    </div>
  );
}
