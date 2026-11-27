// Password-reset landing page (opened from the Supabase "Reset password" e-mail).
//
// Supabase verifies the e-mail link and redirects here with a one-time
// recovery session in the URL fragment (#access_token=…&refresh_token=…&type=recovery),
// or with #error=…&error_code=otp_expired when the link is expired / already used.
// The page then
//   * offers to open the Android app (ekostore://reset-password#…, same tokens), or
//   * lets the customer set the new password here (Supabase Auth REST API,
//     publishable key only), then signs the account out everywhere.
// Tokens are removed from the address bar immediately and never sent elsewhere.

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
const KEY = String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY ?? '');
const MIN_LENGTH = 6; // same as the app and Supabase "Minimum password length"

const $ = (id: string) => document.getElementById(id)!;
function show(id: string) {
  for (const s of ['loading', 'invalid', 'confirmed', 'reset', 'done']) $(s).classList.toggle('hidden', s !== id);
}

const fragment = window.location.hash.replace(/^#/, '');
const params = new URLSearchParams(fragment);
const query = new URLSearchParams(window.location.search);
const get = (k: string) => params.get(k) ?? query.get(k);
// Remove the one-time tokens from the address bar / history right away.
history.replaceState(null, '', window.location.pathname);

const accessToken = get('access_token');
const errorCode = get('error_code') ?? get('error');
const type = get('type');

async function auth(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}/auth/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

function errorMessage(code: string | undefined, status: number): string {
  if (code === 'same_password') return 'Fjalëkalimi i ri duhet të jetë i ndryshëm nga i vjetri. / The new password must differ from the old one.';
  if (code === 'weak_password') return 'Fjalëkalimi është shumë i dobët. Përdorni më shumë karaktere, shkronja dhe numra. / The password is too weak.';
  if (status === 401 || status === 403 || code === 'session_not_found' || code === 'bad_jwt')
    return 'Lidhja ka skaduar. Kërkoni një lidhje të re në aplikacion. / The link has expired — request a new one.';
  if (status === 429) return 'Shumë përpjekje. Provoni përsëri pas pak minutash. / Too many attempts, try again in a few minutes.';
  return 'Fjalëkalimi nuk u ruajt. Provoni përsëri. / The password was not saved, please try again.';
}

async function start() {
  if (!SUPABASE_URL || !KEY) {
    $('invalid-text').textContent = 'Faqja nuk është konfiguruar. / This page is not configured.';
    return show('invalid');
  }
  if (errorCode || !accessToken) return show('invalid');
  if (type && type !== 'recovery') return show('confirmed'); // e.g. sign-up confirmation links

  // The link must still be valid before we offer anything.
  let ok = false;
  try {
    ok = (await auth('user')).ok;
  } catch {
    $('invalid-text').textContent = 'Nuk ka lidhje me internetin. Provoni përsëri. / No internet connection, please retry.';
    return show('invalid');
  }
  if (!ok) return show('invalid');

  ($('open-app') as HTMLAnchorElement).href = `ekostore://reset-password#${fragment}`;
  show('reset');

  const pw1 = $('pw1') as HTMLInputElement;
  const pw2 = $('pw2') as HTMLInputElement;
  const err = $('error');
  const save = $('save') as HTMLButtonElement;
  ($('show') as HTMLInputElement).addEventListener('change', (e) => {
    const t = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    pw1.type = t;
    pw2.type = t;
  });
  const fail = (m: string) => {
    err.textContent = m;
    err.classList.remove('hidden');
  };

  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    if (pw1.value.length < MIN_LENGTH) return fail('Fjalëkalimi duhet të ketë të paktën 6 karaktere. / At least 6 characters.');
    if (pw1.value !== pw2.value) return fail('Fjalëkalimet nuk përputhen. / The passwords do not match.');
    save.disabled = true;
    try {
      const res = await auth('user', { method: 'PUT', body: JSON.stringify({ password: pw1.value }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        save.disabled = false;
        return fail(errorMessage(body.error_code ?? body.code, res.status));
      }
      // Sign out every session of this account (other phones / browsers too).
      await auth('logout?scope=global', { method: 'POST' }).catch(() => undefined);
      pw1.value = pw2.value = '';
      show('done');
    } catch {
      save.disabled = false;
      fail('Nuk ka lidhje me internetin. Provoni përsëri. / No internet connection, please retry.');
    }
  });
}

start();
