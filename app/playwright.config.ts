import { defineConfig } from '@playwright/test';

// E2E runs against `vite preview` (built with the LOCAL Supabase URL and key from app/.env.local) and the local stack
// (`npx supabase start`, synthetic seed data only). The global setup resets the local database and creates the local
// test users, so a run always starts from the same state. Tests share one database: one worker, files in order.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    locale: 'pl-PL',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    // Playwright's own browser download is not needed when a system Chrome exists (E2E_CHROME overrides the path).
    launchOptions: { executablePath: process.env.E2E_CHROME ?? '/usr/bin/google-chrome', args: ['--no-sandbox'] },
  },
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
