import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testMatch: 'phase4-frontend.spec.js', workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/phase4/frontend-playwright-results.json' }]],
  outputDir: '../tmp/phase4/frontend-browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5184', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5184 --strictPort', url: 'http://127.0.0.1:5184', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' } },
});
