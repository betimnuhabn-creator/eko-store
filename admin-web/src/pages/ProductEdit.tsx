import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Empty, Spinner, Thumb, useConfirm, useToast } from '../components/ui';
import { useCatalog } from '../lib/data';
import { parseNumber } from '../lib/format';
import { errorText, useI18n, type TKey } from '../lib/i18n';
import { deleteProductImage, ImageError, isHttpsUrl, uploadProductImage } from '../lib/images';
import { deleteProduct, saveProduct } from '../lib/products';

type Form = {
  sku: string;
  name: string;
  name_en: string;
  description: string;
  description_en: string;
  category_id: string;
  unit: string;
  retail: string;
  wholesale: string;
  stock: string;
  active: boolean;
  images: string[];
};
const blank: Form = {
  sku: '', name: '', name_en: '', description: '', description_en: '', category_id: '', unit: 'copë',
  retail: '', wholesale: '', stock: '0', active: true, images: [],
};

export function ProductEdit() {
  const { id = 'new' } = useParams();
  const isNew = id === 'new';
  const { t, pick } = useI18n();
  const toast = useToast();
  const confirm = useConfirm();
  const nav = useNavigate();
  const { byId, categories, loading, reload } = useCatalog();
  const [form, setForm] = useState<Form | null>(isNew ? blank : null);
  const [initial, setInitial] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [url, setUrl] = useState('');
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const original = useRef<string[]>([]);
  const uploadedNow = useRef<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isNew) {
      setInitial(JSON.stringify(blank));
      return;
    }
    if (form) return;
    const p = byId(id);
    if (!p) return;
    original.current = p.images;
    const f: Form = {
      sku: p.sku, name: p.name, name_en: p.name_en, description: p.description, description_en: p.description_en,
      category_id: p.category_id ?? '', unit: p.unit, retail: String(p.retail_price), wholesale: String(p.wholesale_price),
      stock: String(p.stock), active: p.active, images: p.images,
    };
    setForm(f);
    setInitial(JSON.stringify(f));
  }, [id, isNew, byId, form]);

  const dirty = form !== null && JSON.stringify(form) !== initial;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!form) return loading ? <Spinner /> : <Empty text={t('noProducts')} />;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f!, [k]: v }));

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).slice(0, Math.max(0, 10 - form!.images.length));
    for (const file of list) {
      setUploading((n) => n + 1);
      try {
        const u = await uploadProductImage(file);
        uploadedNow.current.add(u);
        setForm((f) => ({ ...f!, images: [...f!.images, u] }));
      } catch (e) {
        toast(`${file.name}: ${e instanceof ImageError ? t(e.message as TKey) : errorText(t, e)}`, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  function removeImage(i: number) {
    const u = form!.images[i];
    set('images', form!.images.filter((_, k) => k !== i));
    // A photo uploaded in this edit and removed again is deleted right away.
    if (uploadedNow.current.has(u)) {
      uploadedNow.current.delete(u);
      deleteProductImage(u).catch(() => {});
    }
  }

  const move = (i: number, to: number) => {
    const imgs = [...form!.images];
    const [x] = imgs.splice(i, 1);
    imgs.splice(to, 0, x);
    set('images', imgs);
  };

  function validate() {
    const e: typeof errors = {};
    if (!form!.sku.trim()) e.sku = t('required');
    if (!form!.name.trim()) e.name = t('required');
    if (!(parseNumber(form!.retail) >= 0)) e.retail = t('invalidPrice');
    if (!(parseNumber(form!.wholesale) >= 0)) e.wholesale = t('invalidPrice');
    const st = parseNumber(form!.stock);
    if (!(st >= 0) || !Number.isInteger(st)) e.stock = t('invalidPrice');
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setBusy(true);
    try {
      const f = form!;
      await saveProduct({
        id: isNew ? null : id,
        sku: f.sku.trim(), name: f.name.trim(), name_en: f.name_en.trim(), description: f.description, description_en: f.description_en,
        category_id: f.category_id || null, unit: f.unit.trim() || 'copë', images: f.images,
        retail_price: parseNumber(f.retail), wholesale_price: parseNumber(f.wholesale), stock: parseNumber(f.stock), active: f.active,
      });
      // Remove stored photos that were taken off the product.
      original.current.filter((u) => !f.images.includes(u)).forEach((u) => deleteProductImage(u).catch(() => {}));
      uploadedNow.current.clear();
      setInitial(JSON.stringify(f));
      toast(t('productSaved'));
      await reload();
      nav('/products');
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    const p = byId(id);
    if (!p || !(await confirm(t('deleteProductConfirm', { name: p.name }), { danger: true, ok: t('delete') }))) return;
    setBusy(true);
    try {
      await deleteProduct(id);
      p.images.forEach((u) => deleteProductImage(u).catch(() => {}));
      toast(t('productDeleted'));
      await reload();
      nav('/products');
    } catch (e) {
      toast(errorText(t, e), 'error');
    } finally {
      setBusy(false);
    }
  }

  const retailN = parseNumber(form.retail);
  const wholesaleN = parseNumber(form.wholesale);
  const field = (k: keyof Form, label: string, props: Record<string, any> = {}) => (
    <label className={errors[k] ? 'has-error' : ''}>
      {label}
      <input value={form[k] as string} onChange={(e) => set(k, e.target.value as any)} {...props} />
      {errors[k] && <span className="field-error">{errors[k]}</span>}
    </label>
  );

  return (
    <form onSubmit={submit}>
      <div className="page-head">
        <h1>
          <Link to="/products" className="muted">
            {t('products')}
          </Link>{' '}
          / {isNew ? t('newProduct') : form.name}
        </h1>
        <div className="row">
          {!isNew && (
            <button type="button" className="btn btn-danger-outline" onClick={remove} disabled={busy}>
              {t('delete')}
            </button>
          )}
          <button type="button" className="btn" onClick={() => nav('/products')}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || uploading > 0} data-testid="save-product">
            {busy ? t('saving') : t('save')}
          </button>
        </div>
      </div>

      <div className="grid-2 wide-left">
        <div className="card form">
          <div className="grid-2 tight">
            {field('sku', t('sku'), { 'data-testid': 'f-sku', autoComplete: 'off' })}
            <label>
              {t('category')}
              <select value={form.category_id} onChange={(e) => set('category_id', e.target.value)} data-testid="f-category">
                <option value="">{t('noCategory')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {pick(c.name_sq, c.name_en)}
                    {c.active ? '' : ` (${t('inactive')})`}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid-2 tight">
            {field('name', t('nameSq'), { 'data-testid': 'f-name' })}
            {field('name_en', t('nameEn'))}
          </div>
          <div className="grid-2 tight">
            <label>
              {t('descriptionSq')}
              <textarea rows={5} value={form.description} onChange={(e) => set('description', e.target.value)} />
            </label>
            <label>
              {t('descriptionEn')}
              <textarea rows={5} value={form.description_en} onChange={(e) => set('description_en', e.target.value)} />
            </label>
          </div>
          <div className="grid-4 tight">
            {field('retail', t('retailPrice'), { inputMode: 'decimal', 'data-testid': 'f-retail' })}
            {field('wholesale', t('wholesalePrice'), { inputMode: 'decimal', 'data-testid': 'f-wholesale' })}
            {field('stock', t('stock'), { inputMode: 'numeric', 'data-testid': 'f-stock' })}
            {field('unit', t('unit'))}
          </div>
          {wholesaleN > retailN && <div className="alert alert-warn">{t('wholesaleAboveRetail')}</div>}
          <label className="check">
            <input type="checkbox" checked={form.active} onChange={(e) => set('active', e.target.checked)} />
            {t('active')} — <span className="muted">{t('activeHint')}</span>
          </label>
        </div>

        <div className="card">
          <h2>
            {t('photos')} <span className="muted small">({form.images.length}/10)</span>
          </h2>
          <div
            className="dropzone"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
            role="button"
            tabIndex={0}
          >
            {uploading > 0 ? t('uploading') : t('dropPhotos')}
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              hidden
              data-testid="f-files"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
          <div className="row">
            <input className="grow" placeholder={t('photoUrl')} value={url} onChange={(e) => setUrl(e.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={!isHttpsUrl(url) || form.images.length >= 10}
              onClick={() => {
                set('images', [...form.images, url.trim()]);
                setUrl('');
              }}
            >
              {t('add')}
            </button>
          </div>
          <div className="photo-grid">
            {form.images.map((u, i) => (
              <div key={u + i} className={`photo ${i === 0 ? 'photo-main' : ''}`}>
                <Thumb src={u} size={120} />
                <div className="photo-actions">
                  {i === 0 ? (
                    <span className="badge badge-ok">{t('mainPhoto')}</span>
                  ) : (
                    <button type="button" className="link" onClick={() => move(i, 0)}>
                      {t('makeMain')}
                    </button>
                  )}
                  <span>
                    <button type="button" className="icon-btn" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="left">
                      ‹
                    </button>
                    <button type="button" className="icon-btn" disabled={i === form.images.length - 1} onClick={() => move(i, i + 1)} aria-label="right">
                      ›
                    </button>
                    <button type="button" className="icon-btn danger" onClick={() => removeImage(i)} aria-label={t('delete')}>
                      🗑
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </form>
  );
}
