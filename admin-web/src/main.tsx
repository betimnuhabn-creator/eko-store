import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ConfirmProvider, ToastProvider } from './components/ui';
import { Layout } from './components/Layout';
import { AuthProvider, useAuth } from './lib/auth';
import { CatalogProvider, NotificationsProvider } from './lib/data';
import { I18nProvider, useI18n } from './lib/i18n';
import { configProblem } from './lib/supabase';
import { ArchivedOrders } from './pages/ArchivedOrders';
import { Categories } from './pages/Categories';
import { OfferEdit } from './pages/OfferEdit';
import { Offers } from './pages/Offers';
import { Promo } from './pages/Promo';
import { Customers } from './pages/Customers';
import { Dashboard } from './pages/Dashboard';
import { Login } from './pages/Login';
import { OrderDetail } from './pages/OrderDetail';
import { Orders } from './pages/Orders';
import { ProductEdit } from './pages/ProductEdit';
import { Products } from './pages/Products';
import './styles.css';

function Gate() {
  const { t } = useI18n();
  const { state, profile } = useAuth();
  if (configProblem) {
    return (
      <div className="login-page">
        <div className="card login-card alert alert-error">{t(configProblem === 'secret_key' ? 'configSecret' : 'configMissing')}</div>
      </div>
    );
  }
  if (state === 'loading') return <div className="empty">{t('loading')}</div>;
  if (state !== 'admin' || !profile) return <Login />;
  // Everything below is only rendered for a verified administrator.
  return (
    <CatalogProvider>
      <NotificationsProvider userId={profile.id}>
        <Layout>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/:id" element={<ProductEdit />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/orders/:id" element={<OrderDetail />} />
            <Route path="/archived-orders" element={<ArchivedOrders />} />
            <Route path="/offers" element={<Offers />} />
            <Route path="/offers/:id" element={<OfferEdit />} />
            <Route path="/promo" element={<Promo />} />
            <Route path="/customers" element={<Customers />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout>
      </NotificationsProvider>
    </CatalogProvider>
  );
}

// Refuse to run inside a frame on another site (clickjacking protection for
// hosts that cannot send X-Frame-Options / frame-ancestors headers).
let framed = false;
try {
  framed = window.top !== window.self;
} catch {
  framed = true;
}
if (framed) {
  document.body.textContent = 'EKO Store Admin cannot be opened inside a frame.';
  throw new Error('framed');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AuthProvider>
            <HashRouter>
              <Gate />
            </HashRouter>
          </AuthProvider>
        </ConfirmProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
