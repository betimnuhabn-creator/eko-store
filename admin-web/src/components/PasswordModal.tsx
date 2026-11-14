import { useState } from 'react';
import { generatePassword, setCustomerPassword, type SetPasswordError } from '../lib/adminPassword';
import { useI18n, type TKey } from '../lib/i18n';
import type { Profile } from '../lib/types';
import { Modal } from './ui';

// Klientët → Fjalëkalimi. The new password exists only in this dialog's state:
// it is never stored, and it is gone when the dialog closes.
export function PasswordModal({ customer, onClose }: { customer: Profile; onClose: () => void }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SetPasswordError | 'too_short' | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  async function save() {
    setError(null);
    if (password.length < 8 || password.length > 72) return setError('too_short');
    if (!adminPassword) return setError('reauth_failed');
    setBusy(true);
    const e = await setCustomerPassword(customer.id, password, adminPassword);
    setBusy(false);
    setAdminPassword('');
    if (e) return setError(e);
    setSaved(true); // only after Supabase confirmed the change
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setVisible(true); // clipboard blocked: show it so it can be copied by hand
    }
  }

  return (
    <Modal title={t('pwdTitle')} onClose={onClose} small>
      <div className="form" data-testid="password-modal">
        <div>
          <strong>{customer.business_name || customer.full_name || '—'}</strong>
          <div className="muted small">{customer.email}</div>
        </div>
        {!saved ? (
          <>
            <label>
              {t('pwdNew')}
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type={visible ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-lpignore="true"
                  data-testid="pwd-new"
                  style={{ flex: 1 }}
                />
                <button type="button" className="btn btn-sm" onClick={() => setVisible((v) => !v)} data-testid="pwd-toggle">
                  {visible ? t('pwdHide') : t('pwdShow')}
                </button>
              </div>
            </label>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPassword(generatePassword());
                setVisible(true);
              }}
              data-testid="pwd-generate"
            >
              {t('pwdGenerate')}
            </button>
            <label>
              {t('pwdAdminPassword')}
              <input
                type="password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                autoComplete="current-password"
                data-testid="pwd-admin"
              />
            </label>
            <p className="muted small">{t('pwdNote')}</p>
            {error && (
              <div className="alert alert-warn" role="alert" data-testid="pwd-error">
                {t(`pwdErr_${error}` as TKey)}
              </div>
            )}
            <button className="btn btn-primary" disabled={busy} onClick={save} data-testid="pwd-save">
              {busy ? '…' : t('pwdSave')}
            </button>
          </>
        ) : (
          <>
            <div className="alert alert-ok" data-testid="pwd-done">
              {t('pwdDone')}
            </div>
            <label>
              {t('pwdNew')}
              <div style={{ display: 'flex', gap: 6 }}>
                <input type={visible ? 'text' : 'password'} value={password} readOnly autoComplete="off" data-testid="pwd-result" style={{ flex: 1 }} />
                <button type="button" className="btn btn-sm" onClick={() => setVisible((v) => !v)}>
                  {visible ? t('pwdHide') : t('pwdShow')}
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={copy} data-testid="pwd-copy">
                  {copied ? t('pwdCopied') : t('pwdCopy')}
                </button>
              </div>
            </label>
            <p className="muted small">{t('pwdAfterNote')}</p>
            <button className="btn" onClick={onClose} data-testid="pwd-close">
              {t('close')}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
