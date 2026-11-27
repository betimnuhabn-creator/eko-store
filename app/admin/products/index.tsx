import { router, Stack, useFocusEffect } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { AdminOnly } from '../../../components/AdminOnly';
import { ProductImage } from '../../../components/ProductImage';
import { Badge, Button, Card, Empty, Field, ListItem, Screen } from '../../../components/ui';
import { useCatalog } from '../../../lib/catalog';
import { money } from '../../../lib/format';
import { useI18n } from '../../../lib/i18n';
import { colors } from '../../../lib/theme';

function ProductsAdmin() {
  const { t, pick } = useI18n();
  const { products, reload, loading } = useCatalog();
  const [q, setQ] = useState('');
  useFocusEffect(useCallback(() => void reload(), [reload]));

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter((p) => !s || `${p.name} ${p.name_en} ${p.sku}`.toLowerCase().includes(s));
  }, [products, q]);

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: t('manageProducts') }} />
      <Button icon="add-circle-outline" title={t('newProduct')} onPress={() => router.push('/admin/products/new')} testID="new-product" />
      <Field placeholder={t('search')} value={q} onChangeText={setQ} />
      {list.length === 0 ? (
        <Empty text={t('noProducts')} />
      ) : (
        <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
          {list.map((p) => (
            <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff' }}>
              <ProductImage uri={p.images[0]} style={{ width: 52, height: 52, marginLeft: 10, borderRadius: 6 }} />
              <View style={{ flex: 1 }}>
                <ListItem
                  title={pick(p.name, p.name_en)}
                  subtitle={`${p.sku} · ${money(p.retail_price)} / ${money(p.wholesale_price)} · ${t('stock')}: ${p.stock}`}
                  right={!p.active ? <Badge label={t('inactive')} tone="muted" /> : undefined}
                  onPress={() => router.push(`/admin/products/${p.id}`)}
                />
              </View>
            </View>
          ))}
        </Card>
      )}
      <Text style={{ color: colors.muted, textAlign: 'center' }}>{list.length}</Text>
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <ProductsAdmin />
    </AdminOnly>
  );
}
