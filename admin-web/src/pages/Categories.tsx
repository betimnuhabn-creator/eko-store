import { useState } from 'react';
import { Badge, Empty, Modal, useConfirm, useToast } from '../components/ui';
import { useCatalog } from '../lib/data';
import { errorText, useI18n } from '../lib/i18n';
import { supabase } from '../lib/supabase';
import type { Category } from '../lib/types';

type Draft = { id: string | null; name_sq: string; name_en: string; sort_order: string; active: boolean };

export function Categories() {
  const { t } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const { categories, products, reload } = useCatalog();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const count = (id: string) => products.filter((p) => p.category_id === id).length;

  async function save() {
    if (!draft || !draft.name_sq.trim()) return toast(t('e_NAME_REQUIRED'), 'error');
    setBusy(true);
    const { error } = await supabase.rpc('admin_save_category', {
      p: { ...draft, sort_order: parseInt(draft.sort_order || '0', 10) || 0 },
    });
    setBusy(false);
    if (error) return toast(errorText(t, error), 'error');
    toast(t('saved'));
    setDraft(null);
    reload();
  }

  async function remove(c: Category) {
    if (!(await confirm(t('deleteCategoryConfirm', { name: c.name_sq }), { danger: true, ok: t('delete') }))) return;
    const { error } = await supabase.rpc('admin_delete_category', { p_id: c.id });
    if (error) return toast(errorText(t, error), 'error');
    toast(t('saved'));
    reload();
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('categories')}</h1>
        <button className="btn btn-primary" onClick={() => setDraft({ id: null, name_sq: '', name_en: '', sort_order: String((categories.at(-1)?.sort_order ?? 0) + 10), active: true })} data-testid="new-category">
          + {t('newCategory')}
        </button>
      </div>
      <div className="card">
        {categories.length === 0 ? (
          <Empty text={t('none')} />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>{t('sortOrder')}</th>
                <th>{t('nameSq')}</th>
                <th>{t('nameEn')}</th>
                <th className="num">{t('productsInCategory')}</th>
                <th>{t('status')}</th>
                <th className="num">{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>{c.sort_order}</td>
                  <td>{c.name_sq}</td>
                  <td>{c.name_en || '—'}</td>
                  <td className="num">{count(c.id)}</td>
                  <td>{c.active ? <Badge tone="ok">{t('active')}</Badge> : <Badge>{t('inactive')}</Badge>}</td>
                  <td className="num">
                    <button className="btn btn-sm" onClick={() => setDraft({ id: c.id, name_sq: c.name_sq, name_en: c.name_en, sort_order: String(c.sort_order), active: c.active })}>
                      {t('edit')}
                    </button>{' '}
                    <button className="btn btn-sm btn-danger-outline" onClick={() => remove(c)}>
                      {t('delete')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {draft && (
        <Modal title={draft.id ? t('edit') : t('newCategory')} onClose={() => setDraft(null)} small>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label>
              {t('nameSq')}
              <input value={draft.name_sq} onChange={(e) => setDraft({ ...draft, name_sq: e.target.value })} autoFocus data-testid="c-name-sq" />
            </label>
            <label>
              {t('nameEn')}
              <input value={draft.name_en} onChange={(e) => setDraft({ ...draft, name_en: e.target.value })} data-testid="c-name-en" />
            </label>
            <label>
              {t('sortOrder')}
              <input value={draft.sort_order} inputMode="numeric" onChange={(e) => setDraft({ ...draft, sort_order: e.target.value.replace(/[^\d-]/g, '') })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              {t('active')}
            </label>
            <div className="row end">
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                {t('cancel')}
              </button>
              <button className="btn btn-primary" disabled={busy} data-testid="c-save">
                {t('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
