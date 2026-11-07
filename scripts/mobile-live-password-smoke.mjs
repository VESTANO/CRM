import { chromium } from '../frontend/node_modules/@playwright/test/index.mjs';

const browser = await chromium.launch();
try {
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 668 }, hasTouch: width < 992, serviceWorkers: 'block' });
    const page = await context.newPage();
    const writes = [];
    await page.route('**/*', route => {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
        writes.push(route.request().method());
        return route.abort();
      }
      return route.continue();
    });
    await page.goto('https://vestano.online/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
    const input = page.locator('#password');
    await input.fill('Synthetic-only-value');
    const show = page.getByRole('button', { name: 'Show password', exact: true });
    if (width < 992) await show.tap(); else await show.click();
    if (await input.getAttribute('type') !== 'text') throw new Error(`${width}px: tap/click did not reveal password`);
    await page.locator('#username').focus();
    if (await input.getAttribute('type') !== 'text') throw new Error(`${width}px: moving focus hid password`);
    await page.getByRole('button', { name: 'Hide password', exact: true }).click();
    if (await input.getAttribute('type') !== 'password') throw new Error(`${width}px: second click did not hide password`);
    if (writes.length) throw new Error(`${width}px: unexpected write request`);
    console.log(`${width}px: visibility toggles and persists; no write request`);
    await context.close();
  }
} finally { await browser.close(); }
