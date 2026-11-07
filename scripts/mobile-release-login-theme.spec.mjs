import { test, expect } from '../frontend/node_modules/@playwright/test/index.mjs';
import { shellFixture, pageOverflow } from '../frontend/e2e/helpers/mobile-shell-fixture.js';

for (const width of [320, 360, 390, 414, 768, 1440]) test(`${width}px login matches the workspace theme`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 740 });
  const app = await shellFixture(page, { signedIn: false });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Username or email')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  const colors = await page.evaluate(() => ({
    brand: getComputedStyle(document.querySelector('.login-brand-panel')).backgroundColor,
    page: getComputedStyle(document.querySelector('.workspace-login')).backgroundColor,
    action: getComputedStyle(document.querySelector('.login-submit')).backgroundColor,
    headingFont: getComputedStyle(document.querySelector('.login-card h1')).fontFamily,
  }));
  expect(colors.brand).toBe('rgb(17, 29, 50)');
  expect(colors.page).toBe('rgb(245, 247, 251)');
  expect(colors.action).toBe('rgb(53, 99, 233)');
  expect(colors.headingFont).toContain('Segoe UI');
  expect((await pageOverflow(page)).offenders).toEqual([]);
  if (width === 390 || width === 1440) await testInfo.attach(`login-${width}.png`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect(app.mutations).toEqual([]);
});

for (const role of ['employee', 'admin', 'super_admin']) test(`${role} keeps its existing post-login route`, async ({ page }) => {
  const app = await shellFixture(page, { role });
  await page.goto('/login');
  await expect(page).toHaveURL(role === 'super_admin' ? /\/admin-panel\/stores$/ : /\/dashboard$/);
  expect(app.mutations).toEqual([]);
});
