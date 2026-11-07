import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: 'mobile-tasks.spec.mjs', workers: 1, retries: 0, timeout: 45_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/mobile-tasks/results.json' }]],
  outputDir: '../tmp/mobile-tasks/browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5204', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5204 --strictPort',
    cwd: fileURLToPath(new URL('../frontend/', import.meta.url)), url: 'http://127.0.0.1:5204', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' } },
});
