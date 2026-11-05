import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { PriceTag } from '../../components/PriceTag';
import { ProductImage } from '../../components/ProductImage';
import { Banner, Button, Chip, Empty, Field, Loading, s as ui } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useCart } from '../../lib/cart';
import { useCatalog } from '../../lib/catalog';
import { useI18n } from '../../lib/i18n';
import { colors, maxWidth } from '../../lib/theme';
import { isWholesale, type Product } from '../../lib/types';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export default function CatalogScreen() {
  const { t, pick } = useI18n();
  const { profile, session } = useAuth();
  const { products, categories, loading, error, reload } = useCatalog();
  const { add, quantities } = useCart();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);

  const columns = width < 600 ? 2 : width < 900 ? 3 : 4;
  const cardWidth = (Math.min(width, maxWidth) - 16 * 2 - 12 * (columns - 1)) / columns;

  const visible = useMemo(() => {
    const q = norm(query.trim());
    return products.filter(
      (p) =>
        p.active &&
        (!category || p.category_id === category) &&
        (!q || norm(`${p.name} ${p.name_en} ${p.sku}`).includes(q)),
    );
  }, [products, query, category]);

  if (loading && products.length === 0) return <Loading />;

  const header = (
    <View style={{ gap: 12, marginBottom: 12 }}>
      {!session && <Banner text={t('guestAccount')} />}
      {isWholesale(profile) && <Banner tone="success" text={t('pricesWholesale')} />}
      {profile?.wholesale_status === 'pending' && <Banner tone="warning" text={t('pricesPendingWholesale')} />}
      {error && (
        <View style={{ gap: 8 }}>
          <Banner tone="warning" text={error} />
          <Button title={t('retry')} onPress={reload} variant="secondary" />
        </View>
      )}
      <Field placeholder={t('search')} value={query} onChangeText={setQuery} testID="search" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        <Chip label={t('all')} active={!category} onPress={() => setCategory(null)} />
        {categories
          .filter((c) => c.active)
          .map((c) => (
            <Chip key={c.id} label={pick(c.name_sq, c.name_en)} active={category === c.id} onPress={() => setCategory(c.id)} />
          ))}
      </ScrollView>
    </View>
  );

  const renderItem = ({ item: p }: { item: Product }) => (
    <Pressable
      onPress={() => router.push(`/product/${p.id}`)}
      style={[ui.card, { width: cardWidth, padding: 10, gap: 6 }]}
      testID={`product-${p.sku}`}
    >
      <ProductImage uri={p.images[0]} style={{ width: '100%', aspectRatio: 1, borderRadius: 8 }} />
      <Text numberOfLines={2} style={{ fontWeight: '700', color: colors.text, minHeight: 38 }}>
        {pick(p.name, p.name_en)}
      </Text>
      <Text style={{ color: colors.muted, fontSize: 12 }}>
        {t('code')}: {p.sku}
      </Text>
      <Text style={{ color: p.in_stock ? colors.success : colors.warning, fontSize: 12, fontWeight: '700' }}>
        {p.in_stock ? t('inStock') : t('onOrder')}
      </Text>
      <PriceTag product={p} size={16} />
      <Button
        small
        icon="cart-outline"
        title={quantities[p.id] ? `${t('add')} (${quantities[p.id]})` : t('addToCart')}
        onPress={() => add(p.id)}
        testID={`add-${p.sku}`}
      />
    </Pressable>
  );

  return (
    <FlatList
      key={columns}
      style={ui.screen}
      contentContainerStyle={[ui.inner, { gap: 12 }]}
      columnWrapperStyle={{ gap: 12 }}
      data={visible}
      numColumns={columns}
      keyExtractor={(p) => p.id}
      ListHeaderComponent={header}
      ListEmptyComponent={<Empty text={t('noProducts')} />}
      renderItem={renderItem}
      refreshing={loading}
      onRefresh={reload}
      keyboardShouldPersistTaps="handled"
    />
  );
}
