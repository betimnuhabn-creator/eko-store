import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Relative base + hash routing: the built files work from any folder or host
// (GitHub Pages, Netlify, Cloudflare Pages, an existing web server...).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const supabase = (env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const wss = supabase.replace(/^http/, 'ws');
  // Content-Security-Policy: scripts only from this site; network only to the
  // EKO Supabase project. Product photos may come from any https URL.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https: ${supabase}`,
    `connect-src 'self' ${supabase} ${wss}`,
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
  return {
    base: './',
    plugins: [
      react(),
      {
        name: 'eko-csp',
        transformIndexHtml: (html) => html.replace('%CSP%', csp),
      },
    ],
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
      // Second page: password reset landing page for customers (link in the e-mail).
      rollupOptions: { input: { main: 'index.html', reset: 'reset-password.html' } },
    },
    server: { port: 5173 },
  };
});
