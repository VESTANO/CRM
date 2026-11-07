import { test, expect } from '../../../../frontend/node_modules/@playwright/test/index.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const storeId = '00000000-0000-4000-8000-000000000011';
const allFeatures = { customers: true, sales: true, attendance: true, callbacks: true, reminders: true, reports: true, tasks: true };

async function fixture(page, role, features = allFeatures, selectedStore = false) {
  const profile = { id, employee_id: 'QAUSER', name: 'Store QA', email: 'qa@example.test', active: true, role, store_id: role === 'super_admin' ? null : storeId };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: id, role: 'authenticated', exp: 4070908800 })}.local-only`, refresh_token: 'local-only', token_type: 'bearer', expires_at: 4070908800, user: { id, email: profile.email, aud: 'authenticated', role: 'authenticated', user_metadata: {} } };
  const writes = [];
  await page.addInitScript(({ session, selectedStore }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    if (selectedStore) sessionStorage.setItem('crm-super-admin-store', selectedStore);
  }, { session, selectedStore: selectedStore ? storeId : '' });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await page.route('http://127.0.0.1:54321/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-headers': '*' } });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    let payload = { results: [] };
    if (path.includes('/rest/v1/profiles')) payload = [profile];
    else if (path.includes('/auth/v1/user')) payload = session.user;
    else if (path.includes('/auth/v1/')) payload = {};
    else if (path.endsWith('/store/features/')) payload = { features };
    else if (path.endsWith('/admin/stores/')) payload = { results: [{ id: storeId, name: 'Kochi Store', features }] };
    else if (path.includes('/admin/stores/') && path.endsWith('/features/')) payload = { id: storeId, name: 'Kochi Store', features: request.postDataJSON().features };
    else if (path.includes('/rest/v1/')) payload = [];
    return route.fulfill({ json: payload, headers });
  });
  return writes;
}

for (const width of [390, 1440]) test(`Super Admin creates a store with contact details and module access at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 650 });
  const writes = await fixture(page, 'super_admin');
  await page.goto('/admin-panel/stores');
  await page.getByRole('button', { name: 'Add store' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add store' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Store name').fill('New Store');
  await dialog.getByLabel('Contact person').fill('Manager');
  await dialog.getByLabel('Email').fill('manager@example.test');
  await dialog.getByLabel('Phone number').fill('+91 9876543210');
  await dialog.getByLabel('Street address').fill('1 Test Road');
  await dialog.getByLabel('City').fill('Kochi');
  await dialog.getByLabel('State or region').fill('Kerala');
  await dialog.getByLabel('Postal code').fill('682001');
  await dialog.getByRole('switch', { name: 'Attendance, timesheets and overtime' }).uncheck();
  await dialog.getByRole('switch', { name: 'Sales visits and targets' }).uncheck();
  await dialog.getByRole('button', { name: 'Create store' }).click();
  await expect.poll(() => writes.find(item => item.path.endsWith('/admin/stores/'))).toBeTruthy();
  const body = writes.find(item => item.path.endsWith('/admin/stores/')).body;
  expect(body).toMatchObject({ name: 'New Store', contact_email: 'manager@example.test', contact_phone: '+91 9876543210', features: { attendance: false, sales: false } });
});

test('disabled store modules disappear from navigation and reject direct pages', async ({ page }) => {
  await fixture(page, 'admin', { ...allFeatures, attendance: false, sales: false });
  await page.goto('/sales');
  await expect(page.getByText('This feature is not enabled for your store.')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByText('Sales', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByText('Attendance', { exact: true })).toHaveCount(0);
  await page.goto('/attendance/timesheet');
  await expect(page.getByText('This feature is not enabled for your store.')).toBeVisible();
});

test('only Super Admin can open and save existing-store access popup', async ({ page }) => {
  const writes = await fixture(page, 'super_admin');
  await page.goto('/admin-panel/stores');
  await page.getByRole('button', { name: 'Manage access' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage access: Kochi Store' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('switch', { name: 'Attendance, timesheets and overtime' }).uncheck();
  await dialog.getByRole('button', { name: 'Save access' }).click();
  await expect.poll(() => writes.find(item => item.path.endsWith('/features/'))).toBeTruthy();
  expect(writes.find(item => item.path.endsWith('/features/')).body.features.attendance).toBe(false);
});

test('Store Admin cannot change module access', async ({ page }) => {
  const writes = await fixture(page, 'admin');
  await page.goto('/admin-panel/stores');
  await expect(page.getByRole('button', { name: 'Manage access' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add store' })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('store access changes update navigation without a page reload', async ({ page }) => {
  const features = { ...allFeatures };
  await fixture(page, 'admin', features);
  await page.goto('/admin-panel/stores');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByText('Sales', { exact: true })).toBeVisible();
  const before = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  features.sales = false;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(navigation.getByText('Sales', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(before);
});
