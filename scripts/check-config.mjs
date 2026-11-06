// Checks the Supabase settings the app will be built with — without printing them in full.
//   node scripts/check-config.mjs            (reads .env, then eas.json profiles)
// Exits with an error if a value is missing, malformed, or a SECRET key.
import { existsSync, readFileSync } from 'node:fs';

const sources = [];
if (existsSync('.env')) {
  const vars = Object.fromEntries(readFileSync('.env', 'utf8').split('\n')
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, '')]));
  sources.push(['.env', vars]);
}
if (existsSync('eas.json')) {
  const eas = JSON.parse(readFileSync('eas.json', 'utf8'));
  for (const [name, profile] of Object.entries(eas.build ?? {})) if (profile.env) sources.push([`eas.json → ${name}`, profile.env]);
}

const role = (k) => { try { return JSON.parse(Buffer.from(k.split('.')[1], 'base64url').toString()).role; } catch { return null; } };
const mask = (v) => (v.length > 16 ? `${v.slice(0, 14)}…${v.slice(-4)}` : v);
let errors = 0;
const err = (m) => (errors++, console.log(`  ✖ ${m}`));

if (!sources.length) err('No .env file and no "env" in eas.json profiles.');
for (const [where, v] of sources) {
  console.log(where);
  const url = v.EXPO_PUBLIC_SUPABASE_URL ?? '';
  const key = v.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY || v.EXPO_PUBLIC_SUPABASE_ANON_KEY || '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(url) || /YOUR/i.test(url)) err(`EXPO_PUBLIC_SUPABASE_URL invalid: "${url}" (expected https://<ref>.supabase.co)`);
  else console.log(`  ✔ URL ${url}`);
  if (!key || /YOUR/i.test(key)) err('EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY missing');
  else if (key.startsWith('sb_secret_') || role(key) === 'service_role') err('SECRET KEY DETECTED — never put it in the app. Use sb_publishable_…');
  else if (!key.startsWith('sb_publishable_') && role(key) !== 'anon') err(`key is neither sb_publishable_… nor a legacy anon key (${mask(key)})`);
  else console.log(`  ✔ publishable key ${mask(key)}`);
  for (const name of Object.keys(v)) {
    if (/SERVICE|SECRET/i.test(name)) err(`variable ${name} must not be in the app configuration`);
  }
}
console.log(errors ? `\n${errors} problem(s).` : '\nConfiguration OK.');
process.exit(errors ? 1 : 0);
