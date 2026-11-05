export type Role = 'retail' | 'wholesale' | 'admin';
export type WholesaleStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'shipped' | 'delivered' | 'cancelled'
  /** v0.2 statuses, only on old orders */
  | 'accepted' | 'completed';
export type PaymentMethod = 'cash_on_delivery' | 'bank_transfer';

export const ORDER_STATUSES: OrderStatus[] = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'];

/** Wholesale prices apply only to accounts an administrator has approved. */
export const isWholesale = (p: { role: Role; wholesale_status: WholesaleStatus } | null | undefined) =>
  !!p && p.role !== 'admin' && p.wholesale_status === 'approved';

/** What kind of account this is, for display. */
export const accountKind = (p: { role: Role; wholesale_status: WholesaleStatus }): Role =>
  p.role === 'admin' ? 'admin' : isWholesale(p) ? 'wholesale' : 'retail';

export type Profile = {
  id: string;
  email: string;
  full_name: string;
  phone: string;
  role: Role;
  wholesale_status: WholesaleStatus;
  business_name: string;
  business_number: string;
  address: string;
  city: string;
  language: 'sq' | 'en';
  created_at: string;
};

export type Category = { id: string; name_sq: string; name_en: string; sort_order: number; active: boolean };

export type Product = {
  id: string;
  sku: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category_id: string | null;
  unit: string;
  images: string[];
  in_stock: boolean;
  /** Price for the current user. null for guests. */
  price: number | null;
  /** Admin only */
  retail_price: number | null;
  wholesale_price: number | null;
  stock: number | null;
  active: boolean;
  created_at: string;
};

export type OrderItem = {
  id: string;
  product_id: string | null;
  product_name: string;
  sku: string;
  unit: string;
  quantity: number;
  unit_price: number;
};

export type Order = {
  id: string;
  order_number: number;
  customer_id: string | null;
  status: OrderStatus;
  price_tier: 'retail' | 'wholesale';
  total: number;
  item_count: number;
  payment_method: PaymentMethod;
  delivery_name: string;
  delivery_phone: string;
  delivery_address: string;
  delivery_city: string;
  customer_note: string;
  admin_note: string;
  created_at: string;
  updated_at: string;
  order_items?: OrderItem[];
  profiles?: Pick<Profile, 'email' | 'full_name' | 'business_name' | 'phone'> | null;
};

export type AppNotification = {
  id: string;
  type: string;
  data: Record<string, any>;
  read_at: string | null;
  created_at: string;
};
