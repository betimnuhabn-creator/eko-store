import { dispatchNotifications, supabase } from './supabase';

// Admin order actions, shared by the admin screens. All of them go through
// admin-only database functions (each checks is_admin() in the database).
//
// Archiving needs the 20261110000000_order_cancel_archive migration. Until it
// has been run, the app keeps working as before: archive features are hidden
// and "cancel" falls back to the existing status change.

/** true once the archive migration exists in the database (checked live, no restart needed). */
export async function archiveSupported(): Promise<boolean> {
  const { error } = await supabase.from('orders').select('archived_at').limit(1);
  return !error;
}

export async function cancelOrder(id: string, note: string | null, archiveDb: boolean) {
  const { error } = archiveDb
    ? await supabase.rpc('admin_cancel_order', { p_order: id, p_note: note })
    : await supabase.rpc('admin_set_order_status', { p_order: id, p_status: 'cancelled', p_note: note });
  if (error) throw error;
  dispatchNotifications(); // the customer is told the order was cancelled
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
