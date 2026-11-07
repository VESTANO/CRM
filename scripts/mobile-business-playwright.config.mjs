import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({
  testDir: '../frontend/e2e', testMatch: 'mobile-business.spec.js', workers: 1, retries: 0, timeout: 180_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/mobile-business/playwright-results.json' }]],
  outputDir: '../tmp/mobile-business/browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5203', browserName: 'chromium', hasTouch: true, reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5203 --strictPort', cwd: '../frontend', url: 'http://127.0.0.1:5203', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' } },
});
