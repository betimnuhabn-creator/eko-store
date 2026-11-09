import { dispatchNotifications, supabase } from './supabase';

// All three go through admin-only database functions (they check is_admin()).
// Archiving needs the 20261110000000_order_cancel_archive migration. Until it
// has run, the panel works as before: archive features are hidden and cancel
// falls back to the existing status change.

/** true once the archive migration exists in the database (checked live). */
export async function archiveSupported(): Promise<boolean> {
  const { error } = await supabase.from('orders').select('archived_at').limit(1);
  return !error;
}

export async function cancelOrder(id: string, note: string | undefined, archiveDb: boolean) {
  const { error } = archiveDb
    ? await supabase.rpc('admin_cancel_order', { p_order: id, p_note: note ?? null })
    : await supabase.rpc('admin_set_order_status', { p_order: id, p_status: 'cancelled', p_note: note ?? null });
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

export const canCancel = (status: string, archivedAt?: string | null) =>
  !archivedAt && !['cancelled', 'delivered', 'completed'].includes(status);
export const canArchive = (status: string, archivedAt?: string | null) => !archivedAt && status === 'cancelled';
