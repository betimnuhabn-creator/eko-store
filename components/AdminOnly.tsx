import React from 'react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { Empty, Loading } from './ui';

export function AdminOnly({ children }: { children: React.ReactNode }) {
  const { ready, session, profile, isAdmin } = useAuth();
  const { t } = useI18n();
  if (!ready || (session && !profile)) return <Loading />;
  if (!isAdmin) return <Empty icon="lock-closed-outline" text={t('noAccess')} />;
  return <>{children}</>;
}
