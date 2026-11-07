import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const browser = await chromium.launch();
const results = [];
try {
  for (const width of [320, 360, 375, 390, 414, 430, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 640 }, hasTouch: true, serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [], blockedWrites = [], assetErrors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.url().includes('/assets/') && response.status() >= 400) assetErrors.push({ url: response.url(), status: response.status() });
    });
    await page.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        blockedWrites.push(new URL(route.request().url()).pathname);
        return route.abort();
      }
      return route.continue();
    });
    const response = await page.goto('https://vestano.online/', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    const hasReleaseStyles = await page.evaluate(async () => {
      const urls = [...document.querySelectorAll('link[rel="stylesheet"]')].map(el => el.href);
      const styles = (await Promise.all(urls.map(async url => (await fetch(url)).text()))).join('\n');
      return styles.includes('crm-dialog-open') && styles.includes('94dvh');
    });
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      button: document.querySelector('button[type="submit"]').getBoundingClientRect().height,
      inputFont: getComputedStyle(document.querySelector('input')).fontSize,
      scrollLock: getComputedStyle(document.body).overflowY,
      assets: [...document.querySelectorAll('script[src],link[rel="stylesheet"]')].map(el => el.src || el.href),
    }));
    if (response.status() !== 200 || !hasReleaseStyles || dimensions.document > width + 1 || errors.length || assetErrors.length || blockedWrites.length) throw new Error(JSON.stringify({ width, dimensions, hasReleaseStyles, status: response.status(), errors, assetErrors, blockedWrites }));
    if (width <= 768 && (dimensions.button < 44 || dimensions.inputFont !== '16px')) throw new Error(`Mobile release styles missing at ${width}px: ${JSON.stringify(dimensions)}`);
    if (width === 390) {
      await mkdir('tmp/mobile/live', { recursive: true });
      await page.screenshot({ path: 'tmp/mobile/live/login-390.png', fullPage: true });
    }
    results.push({ width, status: response.status(), url: page.url(), hasReleaseStyles, ...dimensions, errors, assetErrors, blockedWrites });
    await context.close();
  }
  await mkdir('tmp/mobile/live', { recursive: true });
  await writeFile('tmp/mobile/live/results.json', JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2));
  console.log(`Live anonymous mobile smoke: ${results.length}/${results.length} passed; no business writes or authenticated sessions.`);
} finally { await browser.close(); }
