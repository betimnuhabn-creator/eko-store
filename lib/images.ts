import { decode } from 'base64-arraybuffer';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from './supabase';

const BUCKET = 'product-images';
const MAX_WIDTH = 1400;

/** Let the admin pick (or take) a photo. Returns a local URI or null. */
export async function pickImage(source: 'library' | 'camera'): Promise<{ uri: string; width: number } | null> {
  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return null;
  }
  const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 1, allowsEditing: false };
  const res = source === 'camera'
    ? await ImagePicker.launchCameraAsync(opts)
    : await ImagePicker.launchImageLibraryAsync(opts);
  if (res.canceled || !res.assets?.[0]) return null;
  return { uri: res.assets[0].uri, width: res.assets[0].width };
}

/** Resize to max 1400px wide, compress to JPEG and upload. Returns the public URL. */
export async function uploadProductImage(uri: string, width: number): Promise<string> {
  const ctx = ImageManipulator.manipulate(uri);
  if (width > MAX_WIDTH) ctx.resize({ width: MAX_WIDTH, height: null });
  const ref = await ctx.renderAsync();
  const out = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  if (!out.base64) throw new Error('Image conversion failed');
  const base64 = out.base64.replace(/^data:image\/\w+;base64,/, '');
  const path = `${new Date().getFullYear()}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, decode(base64), {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

/** Remove an uploaded file (ignores external URLs). */
export async function deleteProductImage(publicUrl: string) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = publicUrl.indexOf(marker);
  if (i < 0) return;
  await supabase.storage.from(BUCKET).remove([publicUrl.slice(i + marker.length)]);
}
