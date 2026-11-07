import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: '**/store-features.spec.mjs', workers: 1, timeout: 60000,
  outputDir: '../tmp/store-access/browser',
  use: { baseURL: 'http://127.0.0.1:5207', browserName: 'chromium', hasTouch: true, screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5207 --strictPort',
    url: 'http://127.0.0.1:5207', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-only' },
  },
});
