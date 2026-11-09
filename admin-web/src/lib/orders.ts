import { dispatchNotifications, supabase } from './supabase';

// All three go through admin-only database functions (they check is_admin()).

export async function cancelOrder(id: string, note?: string) {
  const { error } = await supabase.rpc('admin_cancel_order', { p_order: id, p_note: note ?? null });
  if (error) throw error;
  dispatchNotifications(); // the customer gets an "order cancelled" notification
}

export async function archiveOrder(id: string) {
  const { error } = await supabase.rpc('admin_archive_order', { p_order: id });
  if (error) throw error;
}

export async function restoreOrder(id: string) {
  const { error } = await supabase.rpc('admin_restore_order', { p_order: id });
  if (error) throw error;
}

export const canCancel = (status: string, archivedAt: string | null) =>
  !archivedAt && !['cancelled', 'delivered', 'completed'].includes(status);
export const canArchive = (status: string, archivedAt: string | null) => !archivedAt && status === 'cancelled';
