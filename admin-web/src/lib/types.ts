export type Role = 'retail' | 'wholesale' | 'admin';
export type WholesaleStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type OrderStatus = 'new' | 'confirmed' | 'preparing' | 'shipped' | 'delivered' | 'cancelled' | 'accepted' | 'completed';

/** Statuses an admin can set (the last two exist only on old v0.2 orders). */
export const ORDER_STATUSES: OrderStatus[] = ['new', 'confirmed', 'preparing', 'shipped', 'delivered', 'cancelled'];

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
  /** offers migration */
  promo_tester?: boolean;
  must_change_password?: boolean;
};

export const isWholesale = (p: Pick<Profile, 'role' | 'wholesale_status'>) =>
  p.role !== 'admin' && p.wholesale_status === 'approved';

export type Category = { id: string; name_sq: string; name_en: string; sort_order: number; active: boolean };

/** Row returned by list_products() for an admin (all columns filled). */
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
  price: number | null;
  retail_price: number;
  wholesale_price: number;
  stock: number;
  active: boolean;
  created_at: string;
  updated_at: string;
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
  payment_method: 'cash_on_delivery' | 'bank_transfer';
  delivery_name: string;
  delivery_phone: string;
  delivery_address: string;
  delivery_city: string;
  customer_note: string;
  admin_note: string;
  created_at: string;
  updated_at: string;
  /** absent until the archive migration has run */
  archived_at?: string | null;
  archived_by?: string | null;
  order_items?: OrderItem[];
  profiles?: Pick<Profile, 'email' | 'full_name' | 'business_name' | 'phone'> | null;
};

export type AppNotification = { id: string; type: string; data: Record<string, any>; read_at: string | null; created_at: string };
