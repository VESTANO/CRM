import {defineConfig} from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({testDir:'..',testMatch:['**/frontend/e2e/mobile-*.spec.js','**/scripts/mobile-attendance.spec.mjs','**/scripts/mobile-tasks.spec.mjs'],
  testIgnore:['**/node_modules/**','**/tmp/**','**/.venv/**'],workers:1,retries:0,timeout:180000,
  reporter:[['list'],['json',{outputFile:'../tmp/mobile/all-results.json'}]],outputDir:'../tmp/mobile/all-artifacts',
  use:{baseURL:'http://127.0.0.1:5205',browserName:'chromium',hasTouch:true,reducedMotion:'reduce',trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5205 --strictPort',cwd:'../frontend',url:'http://127.0.0.1:5205',reuseExistingServer:false,
    env:{VITE_CRM_SUPABASE_URL:'http://127.0.0.1:54321',VITE_CRM_SUPABASE_PUBLISHABLE_KEY:'local-only'}}});
