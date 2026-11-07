import { test, expect } from '@playwright/test';
import { mobileWidths, shellFixture } from './helpers/mobile-shell-fixture.js';

for (const width of [...mobileWidths, 1440]) test(`${width}px password eye toggles on click and touch`, async ({ page }) => {
  await page.setViewportSize({ width, height: 668 });
  const app = await shellFixture(page, { signedIn: false });
  await page.goto('/login');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('Synthetic-only-password');
  const show = page.getByRole('button', { name: 'Show password', exact: true });
  await expect(password).toHaveAttribute('type', 'password');
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  if (width <= 768) await show.tap(); else await show.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(page.getByRole('button', { name: 'Hide password', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Username or email').focus();
  await expect(password).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(password).toHaveAttribute('type', 'password');
  expect(app.mutations).toEqual([]);
});

test('password setup fields toggle independently with keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 668 });
  const app = await shellFixture(page);
  await page.goto('/login#type=recovery');
  const first = page.getByLabel('New password', { exact: true });
  const second = page.getByLabel('Confirm password', { exact: true });
  await first.fill('Synthetic-only-password');
  await second.fill('Synthetic-only-password');
  const showButtons = page.getByRole('button', { name: 'Show password', exact: true });
  await showButtons.first().focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('type', 'text');
  await expect(second).toHaveAttribute('type', 'password');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(first).toHaveAttribute('type', 'password');
  expect(app.mutations).toEqual([]);
});
