import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import logo from '../eko-mark.png';
import { useAuth } from '../lib/auth';
import { useNotifications } from '../lib/data';
import { dateTime } from '../lib/format';
import { useI18n, type TKey } from '../lib/i18n';

const NAV: { to: string; key: TKey; icon: string }[] = [
  { to: '/', key: 'dashboard', icon: '▦' },
  { to: '/orders', key: 'orders', icon: '🧾' },
  { to: '/products', key: 'products', icon: '📦' },
  { to: '/categories', key: 'categories', icon: '🏷' },
  { to: '/customers', key: 'customers', icon: '👥' },
];

function Bell() {
  const { t } = useI18n();
  const { items, unread, text, link, markAllRead, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  return (
    <div className="bell-wrap">
      <button className="icon-btn bell" aria-label={t('notifications')} onClick={() => setOpen((o) => !o)} data-testid="bell">
        🔔{unread > 0 && <span className="bell-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" onMouseLeave={() => setOpen(false)}>
          <div className="row between">
            <strong>{t('notifications')}</strong>
            {unread > 0 && (
              <button className="link" onClick={markAllRead}>
                {t('markAllRead')}
              </button>
            )}
          </div>
          {items.length === 0 && <div className="muted pad">{t('noNotifications')}</div>}
          <ul>
            {items.slice(0, 30).map((n) => (
              <li key={n.id} className={n.read_at ? '' : 'unread'}>
                <button
                  className="bell-item"
                  onClick={() => {
                    if (!n.read_at) markRead(n.id);
                    const to = link(n);
                    if (to) nav(to);
                    setOpen(false);
                  }}
                >
                  <span>{text(n)}</span>
                  <small className="muted">{dateTime(n.created_at)}</small>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { profile, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  return (
    <div className={`shell ${menu ? 'menu-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src={logo} alt="" width={34} height={34} />
          <div>
            <strong>EKO STORE</strong>
            <small>{t('appTitle').split('·')[1]?.trim()}</small>
          </div>
        </div>
        <nav onClick={() => setMenu(false)}>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-icon" aria-hidden>
                {n.icon}
              </span>
              {t(n.key)}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn burger" aria-label="menu" onClick={() => setMenu((m) => !m)}>
            ☰
          </button>
          <div className="grow" />
          <Bell />
          <button className="btn btn-sm" onClick={() => setLang(lang === 'sq' ? 'en' : 'sq')} aria-label="language">
            {lang === 'sq' ? 'EN' : 'SQ'}
          </button>
          <span className="muted user" title={profile?.email}>
            {profile?.full_name || profile?.email}
          </span>
          <button className="btn btn-sm" onClick={() => signOut()} data-testid="logout">
            {t('logout')}
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
