// Public account-deletion page (Google Play: deletion outside the app).
// The customer logs in with e-mail + password (Supabase Auth, publishable key
// only); the deletion itself runs on the server in the Edge Function
// `delete-account`, which re-checks the password and never deletes an
// administrator. Nothing is stored in the browser; the session is dropped.
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('delete-form');
const email = $<HTMLInputElement>('email');
const password = $<HTMLInputElement>('password');
const agree = $<HTMLInputElement>('agree');
const submit = $<HTMLButtonElement>('submit');
const errorBox = $('error');

function fail(text: string) {
  errorBox.textContent = text;
  errorBox.classList.remove('hidden');
}

const MESSAGES: Record<string, string> = {
  login: 'Emaili ose fjalëkalimi nuk është i saktë. / Wrong e-mail or password.',
  agree: 'Konfirmoni që e kuptoni fshirjen e përhershme. / Please confirm you understand.',
  admin_cannot_delete: 'Llogaritë e administratorëve nuk fshihen këtu. / Administrator accounts cannot be deleted here.',
  reauth_failed: 'Fjalëkalimi nuk është i saktë. / The password is not correct.',
  rate: 'Shumë përpjekje. Provoni përsëri pas pak minutash. / Too many attempts, try again later.',
  unavailable: 'Fshirja nuk është e disponueshme për momentin. / Deletion is not available right now.',
  failed: 'Llogaria nuk u fshi. Provoni përsëri. / The account was not deleted, please try again.',
};

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  errorBox.classList.add('hidden');
  if (!email.value.trim() || !password.value) return fail(MESSAGES.login);
  if (!agree.checked) return fail(MESSAGES.agree);
  if (!SUPABASE_URL || !KEY) return fail(MESSAGES.unavailable);
  submit.disabled = true;
  try {
    const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    });
    if (!login.ok) return fail(login.status === 429 ? MESSAGES.rate : MESSAGES.login);
    const session = await login.json();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'self', password: password.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      // Not deleted (e.g. administrator): close the session we opened.
      await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: { apikey: KEY, Authorization: `Bearer ${session.access_token}` },
      }).catch(() => undefined);
      const code = String(data.error ?? '');
      return fail(MESSAGES[code] ?? (res.status === 404 ? MESSAGES.unavailable : MESSAGES.failed));
    }
    form.classList.add('hidden');
    $('done').classList.remove('hidden');
  } catch {
    fail(MESSAGES.unavailable);
  } finally {
    password.value = '';
    submit.disabled = false;
  }
});
