import React from 'react';
import { TKey, useI18n } from '../lib/i18n';
import type { OrderStatus } from '../lib/types';
import { Badge } from './ui';

const tone: Record<OrderStatus, 'info' | 'success' | 'warning' | 'danger' | 'muted'> = {
  new: 'warning',
  confirmed: 'info',
  preparing: 'info',
  shipped: 'info',
  delivered: 'success',
  cancelled: 'danger',
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const { t } = useI18n();
  return <Badge label={t(`st_${status}` as TKey)} tone={tone[status]} />;
}
