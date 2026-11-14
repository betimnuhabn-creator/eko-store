import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type TKey } from '../lib/i18n';
import type { OrderStatus } from '../lib/types';

// ---------------------------------------------------------------- toasts
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- confirm dialog
type ConfirmReq = { text: string; danger?: boolean; ok?: string; resolve: (v: boolean) => void };
const ConfirmCtx = createContext<(text: string, opts?: { danger?: boolean; ok?: string }) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const ask = useCallback(
    (text: string, opts?: { danger?: boolean; ok?: string }) =>
      new Promise<boolean>((resolve) => setReq({ text, ...opts, resolve })),
    [],
  );
  const close = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal title={t('confirmTitle')} onClose={() => close(false)} small>
          <p>{req.text}</p>
          <div className="row end">
            <button className="btn" onClick={() => close(false)}>
              {t('cancel')}
            </button>
            <button className={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)} autoFocus>
              {req.ok ?? t('yes')}
            </button>
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---------------------------------------------------------------- modal
export function Modal({ title, children, onClose, small, wide }: { title: string; children: ReactNode; onClose: () => void; small?: boolean; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${small ? 'modal-small' : ''} ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- small pieces
const statusTone: Record<OrderStatus, string> = {
  new: 'warn',
  confirmed: 'info',
  preparing: 'info',
  shipped: 'info',
  delivered: 'ok',
  cancelled: 'bad',
  accepted: 'info',
  completed: 'ok',
};
export function StatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useI18n();
  return <span className={`badge badge-${statusTone[status] ?? 'muted'}`}>{t(`st_${status}` as TKey)}</span>;
}

export function Badge({ children, tone = 'muted' }: { children: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function Spinner() {
  const { t } = useI18n();
  return <div className="empty">{t('loading')}</div>;
}

export function Thumb({ src, size = 44 }: { src?: string | null; size?: number }) {
  const [bad, setBad] = useState(false);
  return src && !bad ? (
    <img className="thumb" src={src} width={size} height={size} alt="" loading="lazy" onError={() => setBad(true)} />
  ) : (
    <span className="thumb thumb-empty" style={{ width: size, height: size }} />
  );
}

/** Client-side paging for large tables. */
export function usePaging<T>(rows: T[], size = 50) {
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  useEffect(() => {
    if (page > pages) setPage(pages);
  }, [page, pages]);
  return { page, pages, setPage, slice: rows.slice((page - 1) * size, page * size) };
}

export function Pager({ page, pages, setPage, total }: { page: number; pages: number; setPage: (n: number) => void; total: number }) {
  const { t } = useI18n();
  return (
    <div className="pager">
      <span className="muted">
        {total} {t('rows')}
      </span>
      {pages > 1 && (
        <>
          <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            ‹ {t('prev')}
          </button>
          <span>
            {t('page')} {page} / {pages}
          </span>
          <button className="btn btn-sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            {t('next')} ›
          </button>
        </>
      )}
    </div>
  );
}
