import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({
  testDir: '../frontend/e2e', testMatch: 'phase4-performance.spec.js', workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/phase4/performance-playwright-results.json' }]],
  outputDir: '../tmp/phase4/performance-browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5196', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5196 --strictPort', cwd: '../frontend', url: 'http://127.0.0.1:5196', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' } },
});
