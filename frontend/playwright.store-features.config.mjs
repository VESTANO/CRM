import { defineConfig } from '../../../frontend/node_modules/@playwright/test/index.mjs';

export default defineConfig({
  testDir: './e2e', testMatch: '**/store-features.spec.mjs', workers: 1, timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5206', browserName: 'chromium', hasTouch: true },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5206 --strictPort',
    url: 'http://127.0.0.1:5206', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-only' },
  },
});
