import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({
  testDir: '.', testMatch: 'mobile-attendance.spec.mjs', workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/mobile/attendance-results.json' }]],
  outputDir: '../tmp/mobile/attendance-artifacts',
  use: { baseURL: 'http://127.0.0.1:5202', browserName: 'chromium', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5202 --strictPort', cwd: '../frontend', url: 'http://127.0.0.1:5202', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' } },
});
