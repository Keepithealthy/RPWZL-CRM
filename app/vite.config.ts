/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * SEC-06: the browser bundle may only carry the publishable key. A build fails when VITE_SUPABASE_PUBLISHABLE_KEY is a secret
 * key (sb_secret_...) or a legacy JWT whose role is service_role. The key value itself is never printed.
 */
export function secretKeyProblem(key: string | undefined): string | null {
  const k = (key ?? '').trim();
  if (k.startsWith('sb_secret_')) return 'is a secret key (sb_secret_...)';
  const parts = k.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from((parts[1] as string).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { role?: unknown };
      if (payload.role === 'service_role') return 'is a service_role JWT';
    } catch { /* not a JWT */ }
  }
  return null;
}

// Static SPA: `npm run build` writes dist/, deployable to any static host (see vercel.json and public/_redirects).
export default defineConfig(({ mode }) => {
  const problem = secretKeyProblem(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_PUBLISHABLE_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY);
  if (problem) throw new Error(`VITE_SUPABASE_PUBLISHABLE_KEY ${problem}: only the publishable key may be built into the app.`);
  return {
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
  };
});
