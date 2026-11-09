import { PRODUCT_BUCKET, supabase } from './supabase';

const MAX_SIDE = 1600;
const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

export class ImageError extends Error {}

/** Resize in the browser (max 1600 px), convert to JPEG, upload. Returns the public URL. */
export async function uploadProductImage(file: File): Promise<string> {
  if (!ALLOWED.includes(file.type)) throw new ImageError('e_image_type');
  if (file.size > MAX_INPUT_BYTES) throw new ImageError('e_image_size');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff'; // transparent PNGs -> white background
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob: Blob = await new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Image conversion failed'))), 'image/jpeg', 0.85),
  );
  const path = `${new Date().getFullYear()}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  const { error } = await supabase.storage.from(PRODUCT_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
  return supabase.storage.from(PRODUCT_BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Delete an uploaded photo (external URLs are left alone). */
export async function deleteProductImage(publicUrl: string) {
  const marker = `/storage/v1/object/public/${PRODUCT_BUCKET}/`;
  const i = publicUrl.indexOf(marker);
  if (i < 0) return;
  await supabase.storage.from(PRODUCT_BUCKET).remove([decodeURIComponent(publicUrl.slice(i + marker.length))]);
}

export const isHttpsUrl = (u: string) => /^https:\/\/[^\s]+$/i.test(u.trim());
