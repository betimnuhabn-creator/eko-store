import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { ProductImage } from '../../../components/ProductImage';
import { Button, Card, Checkbox, Chip, Empty, Field, H2, Loading, Row, Screen } from '../../../components/ui';
import { useCatalog } from '../../../lib/catalog';
import { confirmAction, showMessage } from '../../../lib/dialog';
import { parseNumber } from '../../../lib/format';
import { errorText, useI18n } from '../../../lib/i18n';
import { deleteProductImage, pickImage, uploadProductImage } from '../../../lib/images';
import { goBack } from '../../../lib/nav';
import { supabase } from '../../../lib/supabase';
import { colors } from '../../../lib/theme';

type Form = {
  sku: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category_id: string | null;
  unit: string;
  retail_price: string;
  wholesale_price: string;
  stock: string;
  active: boolean;
  images: string[];
};

const empty: Form = {
  sku: '', name: '', name_en: '', description: '', description_en: '', category_id: null,
  unit: 'copë', retail_price: '', wholesale_price: '', stock: '0', active: true, images: [],
};

function ProductEditor() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === 'new';
  const { t, pick } = useI18n();
  const { byId, categories, reload, loading } = useCatalog();
  const [form, setForm] = useState<Form | null>(isNew ? empty : null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const original = useRef<string[]>([]);

  useEffect(() => {
    if (isNew || form) return;
    const p = byId(String(id));
    if (!p) return;
    original.current = p.images;
    setForm({
      sku: p.sku, name: p.name, name_en: p.name_en, description: p.description, description_en: p.description_en,
      category_id: p.category_id, unit: p.unit, retail_price: String(p.retail_price ?? ''),
      wholesale_price: String(p.wholesale_price ?? ''), stock: String(p.stock ?? 0), active: p.active, images: p.images,
    });
  }, [id, isNew, byId, form]);

  if (!form) return loading ? <Loading /> : <Empty text={t('noProducts')} />;
  const set = <K extends keyof Form>(k: K) => (v: Form[K]) => setForm((f) => ({ ...f!, [k]: v }));

  async function addPhoto(source: 'library' | 'camera') {
    try {
      const picked = await pickImage(source);
      if (!picked) return;
      setUploading(true);
      const publicUrl = await uploadProductImage(picked.uri, picked.width);
      setForm((f) => ({ ...f!, images: [...f!.images, publicUrl] }));
    } catch (e) {
      showMessage(t('error'), errorText(t, e));
    } finally {
      setUploading(false);
    }
  }

  function addUrl() {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) return;
    setForm((f) => ({ ...f!, images: [...f!.images, u] }));
    setUrl('');
  }

  const move = (i: number, d: number) =>
    setForm((f) => {
      const imgs = [...f!.images];
      const j = i + d;
      if (j < 0 || j >= imgs.length) return f;
      [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
      return { ...f!, images: imgs };
    });

  async function save() {
    const retail = parseNumber(form!.retail_price);
    const wholesale = parseNumber(form!.wholesale_price);
    const stock = parseInt(form!.stock || '0', 10);
    if (!form!.sku.trim() || !form!.name.trim()) return showMessage(t('error'), t('e_SKU_AND_NAME_REQUIRED'));
    if (!(retail >= 0) || !(wholesale >= 0)) return showMessage(t('error'), t('e_INVALID_PRICE'));
    setBusy(true);
    const { error } = await supabase.rpc('admin_save_product', {
      p: {
        ...form,
        id: isNew ? null : id,
        retail_price: retail,
        wholesale_price: wholesale,
        stock: Number.isFinite(stock) ? stock : 0,
      },
    });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    // Clean up uploaded photos that were removed.
    original.current.filter((u) => !form!.images.includes(u)).forEach((u) => deleteProductImage(u).catch(() => {}));
    await reload();
    showMessage(t('productSaved'));
    goBack('/admin/products');
  }

  async function remove() {
    if (!(await confirmAction(t('delete'), t('deleteProductConfirm'), t('delete'), t('cancel')))) return;
    setBusy(true);
    const { error } = await supabase.rpc('admin_delete_product', { p_id: id });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    form!.images.forEach((u) => deleteProductImage(u).catch(() => {}));
    await reload();
    goBack('/admin/products');
  }

  return (
    <Screen style={{ maxWidth: 760 }}>
      <Stack.Screen options={{ title: isNew ? t('newProduct') : t('editProduct') }} />
      <Card>
        <H2>{t('photos')}</H2>
        <ScrollView horizontal contentContainerStyle={{ gap: 10 }}>
          {form.images.map((u, i) => (
            <View key={u + i} style={{ gap: 4, alignItems: 'center' }}>
              <ProductImage uri={u} style={{ width: 96, height: 96, borderRadius: 8, borderWidth: i === 0 ? 2 : 0, borderColor: colors.brand }} />
              <Row style={{ gap: 2 }}>
                <Pressable onPress={() => move(i, -1)} style={{ padding: 4 }}>
                  <Ionicons name="chevron-back" size={18} color={colors.brand} />
                </Pressable>
                <Pressable onPress={() => setForm((f) => ({ ...f!, images: f!.images.filter((_, k) => k !== i) }))} style={{ padding: 4 }}>
                  <Ionicons name="trash-outline" size={18} color={colors.danger} />
                </Pressable>
                <Pressable onPress={() => move(i, 1)} style={{ padding: 4 }}>
                  <Ionicons name="chevron-forward" size={18} color={colors.brand} />
                </Pressable>
              </Row>
            </View>
          ))}
        </ScrollView>
        <Row>
          <Button small variant="secondary" icon="images-outline" title={t('addPhoto')} onPress={() => addPhoto('library')} loading={uploading} />
          {Platform.OS !== 'web' && (
            <Button small variant="secondary" icon="camera-outline" title={t('takePhoto')} onPress={() => addPhoto('camera')} disabled={uploading} />
          )}
        </Row>
        <Row style={{ flexWrap: 'nowrap' }}>
          <View style={{ flex: 1 }}>
            <Field placeholder={t('photoUrl')} value={url} onChangeText={setUrl} onSubmitEditing={addUrl} />
          </View>
          <Button small variant="secondary" icon="add" title={t('add')} onPress={addUrl} />
        </Row>
      </Card>

      <Card>
        <Field label={t('sku')} value={form.sku} onChangeText={set('sku')} testID="p-sku" />
        <Field label={t('nameSq')} value={form.name} onChangeText={set('name')} autoCapitalize="sentences" testID="p-name" />
        <Field label={t('nameEn')} value={form.name_en} onChangeText={set('name_en')} autoCapitalize="sentences" />
        <Field label={t('descriptionSq')} value={form.description} onChangeText={set('description')} multiline autoCapitalize="sentences" />
        <Field label={t('descriptionEn')} value={form.description_en} onChangeText={set('description_en')} multiline autoCapitalize="sentences" />
        <Text style={{ fontWeight: '600', color: colors.text, fontSize: 13 }}>{t('category')}</Text>
        <Row>
          <Chip label={t('noCategory')} active={!form.category_id} onPress={() => set('category_id')(null)} />
          {categories.map((c) => (
            <Chip key={c.id} label={pick(c.name_sq, c.name_en)} active={form.category_id === c.id} onPress={() => set('category_id')(c.id)} />
          ))}
        </Row>
      </Card>

      <Card>
        <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Field label={`${t('retailPrice')} (€)`} value={form.retail_price} onChangeText={set('retail_price')} keyboardType="decimal-pad" testID="p-retail" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={`${t('wholesalePrice')} (€)`} value={form.wholesale_price} onChangeText={set('wholesale_price')} keyboardType="decimal-pad" testID="p-wholesale" />
          </View>
        </Row>
        <Row style={{ flexWrap: 'nowrap', alignItems: 'flex-start' }}>
          <View style={{ flex: 1 }}>
            <Field label={t('stock')} value={form.stock} onChangeText={(v) => set('stock')(v.replace(/\D/g, ''))} keyboardType="number-pad" testID="p-stock" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label={t('unit')} value={form.unit} onChangeText={set('unit')} />
          </View>
        </Row>
        <Checkbox checked={form.active} onChange={set('active')} label={t('active')} />
      </Card>

      <Button title={t('save')} icon="save-outline" onPress={save} loading={busy} disabled={uploading} testID="p-save" />
      {!isNew && <Button variant="ghost" icon="trash-outline" title={t('delete')} onPress={remove} disabled={busy} style={{ alignSelf: 'center' }} />}
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <ProductEditor />
    </AdminOnly>
  );
}
