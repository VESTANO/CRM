import { defineConfig } from '@playwright/test';

// Dedicated QA server: this never claims the developer server's port and
// writes artifacts separately, so a full browser regression run is isolated.
export default defineConfig({
  testDir: './e2e', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30000,
  reporter: [['list'], ['json', { outputFile: '../tmp/qa/playwright-results.json' }]],
  outputDir: '../tmp/qa/browser-artifacts',
  use: {
    baseURL: 'http://127.0.0.1:5190', browserName: 'chromium',
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5190 --strictPort',
    // A prior interrupted test run can leave this dedicated QA server alive;
    // reusing only this non-development port keeps retries deterministic.
    url: 'http://127.0.0.1:5190', reuseExistingServer: true,
    env: {
      VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key',
    },
  },
});
