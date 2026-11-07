import {defineConfig} from '../frontend/node_modules/@playwright/test/index.mjs';
export default defineConfig({testDir:'../frontend/e2e',testMatch:['mobile-shell.spec.js','mobile-auth.spec.js'],workers:1,retries:0,timeout:60000,
  reporter:[['list'],['json',{outputFile:'../tmp/mobile/shell-results.json'}]],outputDir:'../tmp/mobile/shell-artifacts',
  use:{baseURL:'http://127.0.0.1:5201',browserName:'chromium',hasTouch:true,trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'npm run dev -- --host 127.0.0.1 --port 5201 --strictPort',cwd:'../frontend',url:'http://127.0.0.1:5201',reuseExistingServer:false,
    env:{VITE_CRM_SUPABASE_URL:'http://127.0.0.1:54321',VITE_CRM_SUPABASE_PUBLISHABLE_KEY:'local-only'}}});
