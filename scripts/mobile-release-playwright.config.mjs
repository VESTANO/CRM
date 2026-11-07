import { defineConfig } from '../frontend/node_modules/@playwright/test/index.mjs';

export default defineConfig({
  testDir: '..',
  testMatch: ['**/frontend/e2e/mobile-shell.spec.js', '**/frontend/e2e/mobile-auth.spec.js', '**/frontend/e2e/mobile-password-toggle.spec.js', '**/scripts/mobile-release-*.spec.mjs'],
  testIgnore: ['**/node_modules/**', '**/tmp/**', '**/.venv/**'],
  workers: 1, retries: 0, timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list'], ['json', { outputFile: '../tmp/mobile/release-results.json' }]],
  outputDir: '../tmp/mobile/release-artifacts',
  use: { baseURL: 'http://127.0.0.1:5206', browserName: 'chromium', hasTouch: true, reducedMotion: 'reduce', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5206 --strictPort --config ../../../scripts/mobile-release-vite.config.mjs',
    cwd: '../tmp/mobile-ui-live/frontend', url: 'http://127.0.0.1:5206', reuseExistingServer: false,
    env: { VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-only' },
  },
});
