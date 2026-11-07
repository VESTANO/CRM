import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builds = [['/CRM/', 'frontend-dist'], ['/review-crm/', 'frontend-custom-dist'], ['/', 'frontend-root-dist']];
const evidence = [];
for (const [base, folder] of builds) {
  const outDir = resolve(root, 'tmp/phase5', folder);
  const result = spawnSync(process.execPath, [resolve(root, 'frontend/node_modules/vite/bin/vite.js'), 'build', '--mode', 'pages', '--base', base, '--outDir', outDir, '--emptyOutDir'], {
    cwd: resolve(root, 'frontend'), stdio: 'inherit',
    env: { ...process.env, VITE_CRM_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_CRM_SUPABASE_PUBLISHABLE_KEY: 'local-test-key' },
  });
  if (result.status !== 0) process.exit(result.status || 1);
  copyFileSync(resolve(outDir, 'index.html'), resolve(outDir, '404.html'));
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) walk(resolve(dir, item.name), `${prefix}${item.name}/`);
      else { const bytes = readFileSync(resolve(dir, item.name)); files.push({ file: `${prefix}${item.name}`, bytes: bytes.length, gzipBytes: gzipSync(bytes).length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
    }
  };
  walk(outDir);
  evidence.push({ base, output: outDir, environment: 'loopback API only; production-mode minified Pages assets', files });
}
mkdirSync(resolve(root, 'tmp/phase5'), { recursive: true });
writeFileSync(resolve(root, 'tmp/phase5/frontend-build-artifacts.json'), JSON.stringify(evidence, null, 2));
