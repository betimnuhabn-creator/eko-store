// Notification categories shown on the "Njoftimet" screen.
// Classification is by notification type only (nothing is stored or changed in
// the database), so existing notifications are sorted automatically.
import type { TKey } from './i18n';

export type NotificationCategory = 'orders' | 'offers' | 'new_products' | 'prices';

export const NOTIFICATION_CATEGORIES: { key: NotificationCategory; label: TKey }[] = [
  { key: 'orders', label: 'notifCatOrders' },
  { key: 'offers', label: 'notifCatOffers' },
  { key: 'new_products', label: 'notifCatNewProducts' },
  { key: 'prices', label: 'notifCatPrices' },
];

/** Promotional types get their own category; everything else (order status,
 *  new order, cancellations, account / wholesale messages) is "Porositë". */
export function categoryOf(type: string): NotificationCategory {
  switch (type) {
    case 'promo_offer':
      return 'offers';
    case 'promo_new_product':
      return 'new_products';
    case 'promo_price_down':
    case 'promo_price_up':
      return 'prices';
    default:
      return 'orders';
  }
}

export function isCategory(v: unknown): v is NotificationCategory {
  return v === 'orders' || v === 'offers' || v === 'new_products' || v === 'prices';
}
