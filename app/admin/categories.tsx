import { Stack } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { AdminOnly } from '../../components/AdminOnly';
import { Badge, Button, Card, Checkbox, Field, H2, ListItem, Row, Screen } from '../../components/ui';
import { useCatalog } from '../../lib/catalog';
import { confirmAction, showMessage } from '../../lib/dialog';
import { errorText, useI18n } from '../../lib/i18n';
import { supabase } from '../../lib/supabase';
import type { Category } from '../../lib/types';

type Draft = { id: string | null; name_sq: string; name_en: string; sort_order: string; active: boolean };
const blank: Draft = { id: null, name_sq: '', name_en: '', sort_order: '0', active: true };

function Categories() {
  const { t, pick } = useI18n();
  const { categories, reload } = useCatalog();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const edit = (c: Category) =>
    setDraft({ id: c.id, name_sq: c.name_sq, name_en: c.name_en, sort_order: String(c.sort_order), active: c.active });

  async function save() {
    if (!draft?.name_sq.trim()) return showMessage(t('error'), t('required'));
    setBusy(true);
    const { error } = await supabase.rpc('admin_save_category', {
      p: { ...draft, sort_order: parseInt(draft.sort_order || '0', 10) || 0 },
    });
    setBusy(false);
    if (error) return showMessage(t('error'), errorText(t, error));
    setDraft(null);
    reload();
  }

  async function remove() {
    if (!draft?.id) return;
    if (!(await confirmAction(t('delete'), t('deleteCategoryConfirm'), t('delete'), t('cancel')))) return;
    const { error } = await supabase.rpc('admin_delete_category', { p_id: draft.id });
    if (error) return showMessage(t('error'), errorText(t, error));
    setDraft(null);
    reload();
  }

  return (
    <Screen style={{ maxWidth: 640 }}>
      <Stack.Screen options={{ title: t('manageCategories') }} />
      {draft ? (
        <Card>
          <H2>{draft.id ? t('edit') : t('newCategory')}</H2>
          <Field label={t('categoryNameSq')} value={draft.name_sq} onChangeText={(v) => setDraft({ ...draft, name_sq: v })} autoCapitalize="sentences" />
          <Field label={t('categoryNameEn')} value={draft.name_en} onChangeText={(v) => setDraft({ ...draft, name_en: v })} autoCapitalize="sentences" />
          <Field label={t('sortOrder')} value={draft.sort_order} onChangeText={(v) => setDraft({ ...draft, sort_order: v.replace(/[^\d-]/g, '') })} keyboardType="number-pad" />
          <Checkbox checked={draft.active} onChange={(v) => setDraft({ ...draft, active: v })} label={t('active')} />
          <Row>
            <Button title={t('save')} onPress={save} loading={busy} />
            <Button variant="secondary" title={t('cancel')} onPress={() => setDraft(null)} />
            {draft.id && <Button variant="ghost" icon="trash-outline" title={t('delete')} onPress={remove} />}
          </Row>
        </Card>
      ) : (
        <Button icon="add-circle-outline" title={t('newCategory')} onPress={() => setDraft(blank)} />
      )}
      <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        {categories.map((c) => (
          <View key={c.id}>
            <ListItem
              title={pick(c.name_sq, c.name_en)}
              subtitle={`${c.name_sq} / ${c.name_en || '—'} · #${c.sort_order}`}
              right={!c.active ? <Badge label={t('inactive')} tone="muted" /> : undefined}
              onPress={() => edit(c)}
            />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

export default function Page() {
  return (
    <AdminOnly>
      <Categories />
    </AdminOnly>
  );
}
