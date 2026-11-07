import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({
  testDir: '.', testMatch: 'phase5-frontend.spec.mjs', workers: 1, retries: 0, timeout: 120_000,
  reporter: [['list'], ['json', { outputFile: '../tmp/phase5/frontend-production-browser-results.json' }]],
  outputDir: '../tmp/phase5/frontend-production-browser-artifacts',
  use: { baseURL: 'http://127.0.0.1:5198', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: { command: 'node scripts/phase5-frontend-server.mjs', cwd: '..', url: 'http://127.0.0.1:5198/health', reuseExistingServer: false },
});
