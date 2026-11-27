import { useEffect, useState } from 'react';
import { deleteCustomer, previewDeletion, type DeleteError, type DeletePreview } from '../lib/adminDelete';
import { useI18n, type TKey } from '../lib/i18n';
import type { Profile } from '../lib/types';
import { Modal, Spinner } from './ui';

// Klientët → Fshi klientin. Shows what the SERVER knows about the customer
// (name, e-mail, orders), asks for confirmation and the administrator's password.
export function DeleteCustomerModal({ customer, onClose, onDeleted }: { customer: Profile; onClose: () => void; onDeleted: () => void }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<DeletePreview | null>(null);
  const [error, setError] = useState<DeleteError | null>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    previewDeletion(customer.id).then((r) => (typeof r === 'string' ? setError(r) : setInfo(r)));
  }, [customer.id]);

  async function remove() {
    setError(null);
    if (!adminPassword) return setError('reauth_failed');
    setBusy(true);
    const r = await deleteCustomer(customer.id, adminPassword);
    setBusy(false);
    setAdminPassword('');
    if (typeof r === 'string') return setError(r);
    onDeleted(); // only after the server confirmed the deletion
  }

  return (
    <Modal title={t('delTitle')} onClose={onClose} small>
      <div className="form" data-testid="delete-modal">
        <p>
          <strong>{t('delQuestion')}</strong>
        </p>
        {!info && !error && <Spinner />}
        {info && (
          <>
            <div data-testid="del-info">
              <strong data-testid="del-name">{info.business_name || info.name || '—'}</strong>
              {info.business_name && info.name && <div className="muted small">{info.name}</div>}
              <div className="muted small" data-testid="del-email">{info.email}</div>
              <div className="small">
                {t('delOrders')}: <strong data-testid="del-orders">{info.orders}</strong>
                {info.open_orders > 0 && ` (${info.open_orders} ${t('delOpenOrders')})`}
              </div>
            </div>
            {info.orders > 0 ? (
              <div className="alert alert-warn" data-testid="del-orders-warning">
                {t('delHasOrders', { n: info.orders, open: info.open_orders })}
                {info.open_orders > 0 && (
                  <>
                    <br />
                    <strong>{t('delHasOpen', { open: info.open_orders })}</strong>
                  </>
                )}
              </div>
            ) : (
              <p className="muted small">{t('delNoOrders')}</p>
            )}
            <p className="muted small">{t('delWhat')}</p>
            <label>
              {t('delAdminPassword')}
              <input type="password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} autoComplete="current-password" data-testid="del-admin-password" />
            </label>
          </>
        )}
        {error && (
          <div className="alert alert-warn" role="alert" data-testid="del-error">
            {t(`delErr_${error}` as TKey)}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose} data-testid="del-cancel">
            {t('cancel')}
          </button>
          {info && (
            <button className="btn btn-danger" disabled={busy} onClick={remove} data-testid="del-confirm">
              {busy ? '…' : t('delConfirm')}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
