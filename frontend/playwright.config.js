import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e', testIgnore:'**/mobile-*.spec.js', fullyParallel: false, workers: 1, retries: 0,
  timeout: 30000, reporter: [['list'],['json',{outputFile:'../tmp/phase2/playwright-results.json'}]],
  outputDir:'../tmp/phase2/browser-artifacts',
  use:{baseURL:'http://127.0.0.1:5182',browserName:'chromium',trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5182 --strictPort',url:'http://127.0.0.1:5182',reuseExistingServer:false,
    env:{VITE_CRM_SUPABASE_URL:'http://127.0.0.1:54321',VITE_CRM_SUPABASE_PUBLISHABLE_KEY:'local-test-key'}},
});
