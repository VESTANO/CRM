import { test, expect } from '../frontend/node_modules/@playwright/test/index.mjs';

const widths = [320, 360, 375, 390, 414, 430, 768, 1440];
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const longName = 'Alexandria Release Employee With A Very Long Display Name';
const longText = 'LongUnbrokenReleaseValueForResponsiveAttendance'.repeat(3);

async function fixture(page, role, { selectedStore = true } = {}) {
  const profile = { id: uid(1), employee_id: 'RELEASEQA', name: longName, email: `${longText}@example.test`, department: longText, manager: longName, active: true, role, store_id: role === 'super_admin' ? null : uid(11), shift_start_time: '09:00', shift_end_time: '18:00' };
  const inactive = { ...profile, id: uid(2), employee_id: 'INACTIVE-RELEASE', role: 'employee', active: false, store_id: uid(11) };
  const active = { ...profile, id: uid(3), employee_id: 'ACTIVE-RELEASE', role: 'employee', active: true, store_id: uid(11) };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: uid(1), role: 'authenticated', exp: 4070908800 })}.local-only`, refresh_token: 'local-release', token_type: 'bearer', expires_at: 4070908800, user: { id: uid(1), email: profile.email, aud: 'authenticated', role: 'authenticated', user_metadata: {} } };
  const owner = role === 'employee' ? profile : active;
  const entry = { id: uid(44), user_id: owner.id, employee_id: owner.employee_id, employee_name: owner.name, work_date: '2026-11-07', project: longText, details: longText, comments: longText, category: 'Project Work', start_time: '09:00', end_time: '18:00', total_hours: 8, approval_status: 'Submitted', work_status: 'Completed' };
  const punches = ['09:00', '13:00', '14:00', '18:00'].map((hour, index) => ({ id: uid(100 + index), user_id: active.id, employee_id: active.employee_id, employee_name: active.name, punch_code: active.employee_id, punched_at: `2026-11-07T${hour}:00+05:30`, updated_at: '2026-11-07T15:00:00Z', created_at: '2026-11-07T15:00:00Z' }));
  const overtime = [1, 2].map(id => ({ id, employeeName: longName, username: longText, workDate: '2026-11-07', officialEndTime: '18:00', declaredLeaveTime: '2026-11-07T14:00:00Z', actualPunchOut: '2026-11-07T14:00:00Z', requestedMinutes: 90, status: 'pending' }));
  const errors = [], mutations = [], reads = [];
  let entryGone = false, inactiveGone = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ session, selected }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify(session));
    if (selected) sessionStorage.setItem('crm-super-admin-store', selected);
  }, { session, selected: role === 'super_admin' && selectedStore ? uid(11) : null });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await page.route('http://127.0.0.1:54321/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-headers': '*' } });
    const body = request.method() !== 'GET' ? request.postDataJSON() : null;
    if (body) mutations.push({ path, body, storeId: request.headers()['x-crm-store-id'] || '' });
    else reads.push({ path, query: Object.fromEntries(url.searchParams) });
    let payload = { results: [], pagination: { page: 1, numPages: 1, count: 0 } };
    if (path.includes('/rest/v1/profiles')) payload = url.searchParams.has('id') ? [profile] : [...(role === 'super_admin' ? [] : [profile]), ...(!inactiveGone ? [inactive] : []), active];
    else if (path.includes('/rest/v1/timesheet_entries')) payload = entryGone ? [] : [entry];
    else if (path.includes('/rest/v1/attendance_records')) payload = url.searchParams.get('select') === 'updated_at' ? [{ updated_at: punches[0].updated_at }] : punches;
    else if (path.endsWith('/rpc/get_store_dashboard_totals')) payload = { hours: 1234.5, overtime: 12, employees: 100, pending: 3 };
    else if (path.endsWith('/rpc/create_timesheet_entry')) payload = entry;
    else if (path.endsWith('/rpc/update_timesheet_entry')) { entry.project = body.p_project; payload = entry; }
    else if (path.endsWith('/rpc/delete_timesheet_entry')) { entryGone = true; payload = {}; }
    else if (path.endsWith('/rpc/review_timesheet_entry')) { entryGone = true; payload = { ...entry, approval_status: body.p_approval_status }; }
    else if (path.endsWith('/rpc/update_profile_image')) payload = {};
    else if (path.endsWith('/rpc/map_attendance_employee')) payload = 4;
    else if (path.endsWith('/functions/v1/admin-users')) { if (body.action === 'delete') inactiveGone = true; payload = {}; }
    else if (path.endsWith('/overtime/')) payload = { requests: overtime, approvedMinutes: 0 };
    else if (/\/overtime\/[12]\/(reject|approve)\/$/.test(path)) { overtime.find(item => item.id === Number(path.split('/').at(-3))).status = path.includes('/approve/') ? 'approved' : 'rejected'; payload = {}; }
    else if (path.endsWith('/task-notifications/')) payload = { results: [], unread_count: 0 };
    else if (path.endsWith('/callbacks/')) payload = { results: [], counts: {} };
    else if (path.endsWith('/auth/v1/otp')) payload = {};
    else if (path.includes('/auth/v1/user')) payload = session.user;
    else if (path.includes('/auth/v1/')) payload = {};
    else if (path.includes('/rest/v1/')) payload = [];
    return route.fulfill({ json: payload, headers });
  });
  return { errors, mutations, reads, restoreEntry: () => { entryGone = false; } };
}

async function inspect(page, name, width, samples) {
  const sample = await page.locator('.content-wrap').evaluate((content, name) => ({
    name, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth,
    controls: [...content.querySelectorAll('button,input:not([type="checkbox"]),select,textarea')].filter(element => element.getClientRects().length && !element.closest('[hidden]')).map(element => { const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.textContent?.trim().slice(0, 60), width: box.width, height: box.height }; }),
    overflowText: [...content.querySelectorAll('strong,p,h2,h3')].filter(element => !element.closest('.table-responsive') && element.getBoundingClientRect().right > innerWidth + 1).map(element => element.textContent.slice(0, 80)),
  }), name);
  samples.push(sample);
  expect.soft(sample.documentWidth, name).toBeLessThanOrEqual(width);
  expect.soft(sample.overflowText, name).toEqual([]);
  if (width <= 768) expect.soft(sample.controls.filter(control => control.width < 43.9 || control.height < 43.9), `${name}44px controls`).toEqual([]);
}
async function action(page, name) {
  const button = page.getByRole('button', { name, exact: true }).first();
  await expect(button).toBeVisible(); await button.scrollIntoViewIfNeeded(); return button;
}

for (const width of widths) test(`Release UI ${width}px attendance routes and original review/delete contracts`, async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const contexts = [], samples = [];
  const actor = async role => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width, height: 740 } }); contexts.push(context);
    const page = await context.newPage(); return { page, state: await fixture(page, role) };
  };
  try {
    const admin = await actor('admin');
    for (const [route, heading] of [['/attendance', 'Attendance'], ['/attendance/overview', 'Attendance overview'], ['/attendance/employees', 'Attendance employees'], ['/attendance/profile', 'My profile']]) {
      await admin.page.goto(route); await expect(admin.page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      await inspect(admin.page, route, width, samples);
    }
    await expect(admin.page.getByRole('button', { name: '+ Add employee', exact: true })).toHaveCount(0);
    await expect(admin.page.getByLabel('Profile image', { exact: true })).toHaveCount(1);
    await admin.page.goto('/attendance/timesheet'); await admin.page.getByRole('button', { name: '+ New entry', exact: true }).click();
    let modal = admin.page.getByRole('dialog', { name: 'New work entry', exact: true });
    await modal.getByLabel('Project', { exact: true }).fill(longText); await modal.getByLabel('Work details', { exact: true }).fill(longText);
    await inspect(admin.page, 'original daily-entry modal', width, samples);
    await admin.page.setViewportSize({ width, height: 420 });
    await modal.getByLabel('Comments', { exact: true }).fill('Original live workflow, short viewport.');
    await modal.getByRole('button', { name: 'Submit entry', exact: true }).focus();
    await admin.page.keyboard.press('Tab'); await expect(modal.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    const bounds = await modal.locator('.modal-content').boundingBox(); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(421);
    await admin.page.keyboard.press('Escape'); await expect(modal).not.toBeVisible();
    expect(await admin.page.evaluate(() => getComputedStyle(document.body).overflowY)).not.toBe('hidden');
    await admin.page.setViewportSize({ width, height: 740 });
    await admin.page.goto('/attendance/approvals'); await (await action(admin.page, 'Review')).click();
    const reviewDialog = admin.page.getByRole('dialog', { name: 'Review timesheet', exact: true });
    await expect(reviewDialog).toBeVisible();
    await inspect(admin.page, 'timesheet review popup', width, samples);
    const dialogBounds = await reviewDialog.locator('.modal-content').boundingBox();
    expect(dialogBounds.x).toBeGreaterThanOrEqual(0);
    expect(dialogBounds.x + dialogBounds.width).toBeLessThanOrEqual(width + 1);
    await expect(admin.page.locator('body')).toHaveClass(/crm-dialog-open/);
    await admin.page.setViewportSize({ width, height: 420 });
    await expect.poll(async () => (await reviewDialog.locator('.modal-content').boundingBox()).y).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => { const bounds = await reviewDialog.locator('.modal-content').boundingBox(); return bounds.y + bounds.height; }).toBeLessThanOrEqual(421);
    await expect(reviewDialog.getByRole('button', { name: 'Close review' })).toBeInViewport();
    await expect(reviewDialog.getByRole('button', { name: 'Approve' })).toBeInViewport();
    await admin.page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(reviewDialog).not.toBeVisible();
    await expect(admin.page.locator('body')).not.toHaveClass(/crm-dialog-open/);
    await admin.page.setViewportSize({ width, height: 740 });
    expect(admin.state.mutations.filter(row => row.path.endsWith('/rpc/review_timesheet_entry'))).toHaveLength(0);
    await (await action(admin.page, 'Review')).click(); await admin.page.getByLabel('Approval comment', { exact: true }).fill('  Original rejection comment  ');
    await admin.page.getByRole('button', { name: 'Reject', exact: true }).click();
    expect(admin.state.mutations.find(row => row.path.endsWith('/rpc/review_timesheet_entry')).body).toEqual({ p_id: uid(44), p_approval_status: 'Rejected', p_approval_comment: '  Original rejection comment  ' });
    admin.state.restoreEntry(); await admin.page.goto('/attendance/approvals'); await (await action(admin.page, 'Review')).click(); await admin.page.getByRole('button', { name: 'Approve', exact: true }).click();
    expect(admin.state.mutations.filter(row => row.path.endsWith('/rpc/review_timesheet_entry')).at(-1).body.p_approval_status).toBe('Approved');
    await admin.page.goto('/attendance/overtime'); await inspect(admin.page, 'original OT review table', width, samples);
    let nativeCount = 0;
    admin.page.once('dialog', async dialog => { expect(dialog.type()).toBe('prompt'); nativeCount += 1; await dialog.dismiss(); });
    await (await action(admin.page, 'Reject')).click(); expect(nativeCount).toBe(1);
    expect(admin.state.mutations.filter(row => row.path.endsWith('/overtime/1/reject/'))).toHaveLength(0);
    admin.page.once('dialog', async dialog => { expect(dialog.type()).toBe('prompt'); await dialog.accept('  Original OT feedback  '); });
    await (await action(admin.page, 'Reject')).click();
    await expect.poll(() => admin.state.mutations.filter(row => row.path.endsWith('/overtime/1/reject/')).length).toBe(1);
    expect(admin.state.mutations.find(row => row.path.endsWith('/overtime/1/reject/')).body).toEqual({ message: '  Original OT feedback  ' });
    await (await action(admin.page, 'Approve')).click();
    await expect.poll(() => admin.state.mutations.filter(row => row.path.endsWith('/overtime/2/approve/')).length).toBe(1);

    const employee = await actor('employee');
    await employee.page.goto('/attendance/timesheet'); await (await action(employee.page, 'Edit')).click();
    modal = employee.page.getByRole('dialog', { name: 'Edit work entry', exact: true });
    await expect(modal.getByLabel('Project', { exact: true })).toHaveValue(longText);
    await modal.getByLabel('Project', { exact: true }).fill('Release mobile edit'); await modal.getByRole('button', { name: 'Submit entry', exact: true }).click(); await expect(modal).not.toBeVisible();
    expect(employee.state.mutations.find(row => row.path.endsWith('/rpc/update_timesheet_entry')).body.p_project).toBe('Release mobile edit');
    employee.page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); });
    await (await action(employee.page, 'Delete')).click(); expect(employee.state.mutations.filter(row => row.path.endsWith('/rpc/delete_timesheet_entry'))).toHaveLength(0);
    employee.page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); });
    await (await action(employee.page, 'Delete')).click(); await expect.poll(() => employee.state.mutations.filter(row => row.path.endsWith('/rpc/delete_timesheet_entry')).length).toBe(1);
    expect(employee.state.mutations.find(row => row.path.endsWith('/rpc/delete_timesheet_entry')).body).toEqual({ p_id: uid(44) });
    await employee.page.goto('/overtime'); await inspect(employee.page, 'original employee OT request form', width, samples);
    await expect(employee.page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await employee.page.getByLabel('Working date', { exact: true }).fill('2026-11-07'); await employee.page.getByLabel('Expected / declared leaving time', { exact: true }).fill('2026-11-07T19:30');
    const expectedTime = await employee.page.evaluate(() => new Date('2026-11-07T19:30').toISOString());
    await employee.page.getByRole('button', { name: 'Request OT', exact: true }).click(); await expect.poll(() => employee.state.mutations.filter(row => row.path.endsWith('/overtime/')).length).toBe(1);
    expect(employee.state.mutations.find(row => row.path.endsWith('/overtime/')).body).toEqual({ workDate: '2026-11-07', declaredLeaveTime: expectedTime });
    await testInfo.attach('release-attendance-layout.json', { body: JSON.stringify({ baseline: 'origin/main9af7870 native prompts, inline TS review and existing endpoints', samples }), contentType: 'application/json' });
    expect(admin.state.errors).toEqual([]); expect(employee.state.errors).toEqual([]);
  } finally { for (const context of contexts) await context.close(); }
});

for (const width of widths) test(`Release UI ${width}px original Super Admin employee controls and native deletion`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 740 }); const state = await fixture(page, 'super_admin'), samples = [];
  await page.goto('/attendance/employees'); await page.getByRole('button', { name: '+ Add employee', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(longName); await page.getByLabel('Temporary password', { exact: true }).fill('LocalOnlyPassword123');
  await page.getByRole('button', { name: 'Show password', exact: true }).click(); await expect(page.getByLabel('Temporary password', { exact: true })).toHaveAttribute('type', 'text');
  await inspect(page, 'original selected-store employee editor', width, samples); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.dismiss(); }); await (await action(page, 'Delete')).click();
  expect(state.mutations.filter(row => row.path.endsWith('/functions/v1/admin-users'))).toHaveLength(0);
  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); }); await (await action(page, 'Delete')).click();
  await expect.poll(() => state.mutations.filter(row => row.path.endsWith('/functions/v1/admin-users')).length).toBe(1);
  expect(state.mutations.find(row => row.path.endsWith('/functions/v1/admin-users'))).toMatchObject({ body: { action: 'delete', userId: uid(2) }, storeId: uid(11) });
  await page.goto('/attendance'); await expect(page.getByRole('heading', { name: 'eSSL network push settings', exact: true })).toBeVisible();
  await inspect(page, 'original Super Admin device and mapping cards', width, samples);
  await testInfo.attach('release-employee-layout.json', { body: JSON.stringify(samples), contentType: 'application/json' }); expect(state.errors).toEqual([]);
});

for (const width of [320, 390, 768, 1440]) test(`Release UI ${width}px timesheet feedback has its own column`, async ({ page }) => {
  await page.setViewportSize({ width, height: 740 });
  const state = await fixture(page, 'employee');
  const feedback = 'Please correct the work details before resubmitting. ' + longText;
  await page.route('http://127.0.0.1:54321/rest/v1/timesheet_entries**', route => route.fulfill({
    json: [{ id: uid(44), user_id: uid(1), employee_id: 'RELEASEQA', employee_name: longName,
      work_date: '2026-11-07', project: 'Test', details: 'Testing', start_time: '09:30', end_time: '17:30',
      total_hours: 7.5, approval_status: 'Rejected', approval_comment: feedback, work_status: 'Completed' }],
    headers: { 'access-control-allow-origin': '*' },
  }));
  await page.goto('/attendance/timesheet');
  const table = page.locator('#timesheet-results table');
  await expect(table.getByRole('columnheader', { name: 'Admin feedback' })).toBeVisible();
  const cells = table.locator('tbody tr').first().locator('td');
  await expect(cells.nth(5)).toHaveText('Rejected');
  await expect(cells.nth(6)).toContainText(feedback);
  await expect(cells.nth(5)).not.toContainText(feedback);
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await expect(page.locator('text=Refreshing…')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect(state.errors).toEqual([]);
});

test('Store Admin cannot see or open Super Admin creation', async ({ page }) => {
  await fixture(page, 'admin');
  await page.goto('/admin-panel/stores');
  await expect(page.getByRole('heading', { name: 'Stores', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add Super Admin' })).toHaveCount(0);
  await page.goto('/admin-panel/users/add?role=super_admin');
  await expect(page).toHaveURL(/\/admin-panel\/stores$/);
  await expect(page.getByRole('heading', { name: 'Add Super Admin' })).toHaveCount(0);
});

test('Super Admin retains its account creation control', async ({ page }) => {
  await fixture(page, 'super_admin');
  await page.goto('/admin-panel/stores');
  await expect(page.getByRole('link', { name: 'Add Super Admin' })).toBeVisible();
  await page.getByRole('link', { name: 'Add Super Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Add Super Admin' })).toBeVisible();
});

test('A transient missing Super Admin route chunk recovers once', async ({ page }) => {
  await fixture(page, 'super_admin');
  let failures = 0;
  await page.route('**/src/pages/AdminUsers.jsx*', route => {
    if (failures++ === 0) return route.fulfill({ status: 404, body: 'Temporarily missing route chunk' });
    return route.continue();
  });
  await page.goto('/admin-panel/users?role=super_admin');
  await expect(page.getByRole('heading', { name: 'Super Admins', exact: true })).toBeVisible();
  expect(failures).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0);
});

test('Super Admin navigation prefetch keeps its role filter', async ({ page }) => {
  const state = await fixture(page, 'super_admin');
  await page.goto('/admin-panel/stores');
  await page.evaluate(async () => {
    const { prefetchNavigation } = await import('/src/services/navigationPrefetch.js');
    await prefetchNavigation('/admin-panel/users?role=super_admin', { id: 'release-qa', is_admin: true });
  });
  expect(state.reads.some(row => row.path.endsWith('/admin/users/') && row.query.role === 'super_admin')).toBe(true);
});

test('Super Admin sees a separate Admin Panel for each selected store', async ({ page }) => {
  const state = await fixture(page, 'super_admin', { selectedStore: false });
  const seenScopes = [];
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/summary/**', route => {
    const store = route.request().headers()['x-crm-store-id'] || 'global';
    seenScopes.push(store);
    return route.fulfill({ json: { metrics: { totalUsers: store === uid(11) ? 1 : 3, activeUsers: 1, totalDatasets: 0, totalCustomers: 0 }, users: [], recentDatasets: [], recentUsers: [] }, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/targets/**', route => route.fulfill({ json: [], headers: { 'access-control-allow-origin': '*' } }));
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/stores/**', route => route.fulfill({ json: { results: [{ id: uid(11), name: 'Store A' }, { id: uid(12), name: 'Store B' }] }, headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/admin-panel');
  await expect(page).toHaveURL(/\/admin-panel\/stores$/);
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Admin Panel' })).toHaveCount(0);
  expect(seenScopes).toEqual([]);
  await page.goto('/admin-panel/users/add');
  await expect(page).toHaveURL(/\/admin-panel\/stores$/);
  await page.getByRole('article').filter({ hasText: 'Store A' }).getByRole('button', { name: 'Open store' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.goto('/admin-panel');
  await expect(page.getByRole('heading', { name: 'Admin Panel', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Admin Panel' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Add User' })).toHaveAttribute('href', `/admin-panel/users/add?store=${uid(11)}`);
  await expect(page.locator('.metric-grid').first()).toContainText('1');
  await page.getByRole('link', { name: 'Add User' }).click();
  await page.getByLabel('Username').fill('RELEASE-USER');
  await page.getByLabel('Email').fill('release-user@example.test');
  await page.getByLabel('Password', { exact: true }).fill('LocalOnlyPassword123');
  await page.getByLabel('Confirm password').fill('LocalOnlyPassword123');
  await page.getByRole('button', { name: 'Create User' }).click();
  await expect.poll(() => state.mutations.some(row => row.path.endsWith('/admin/users/'))).toBe(true);
  expect(state.mutations.find(row => row.path.endsWith('/admin/users/')).body.store_id).toBe(uid(11));
  await page.goto('/admin-panel');
  await page.getByRole('button', { name: 'Back to stores' }).click();
  await page.goto('/admin-panel');
  await expect(page).toHaveURL(/\/admin-panel\/stores$/);
  await page.getByRole('article').filter({ hasText: 'Store B' }).getByRole('button', { name: 'Open store' }).click();
  await page.goto('/admin-panel');
  await expect(page.locator('.metric-grid').first()).toContainText('3');
  await expect(page.getByRole('link', { name: 'Add User' })).toHaveAttribute('href', `/admin-panel/users/add?store=${uid(12)}`);
  expect(seenScopes).not.toContain('global');
  expect(seenScopes).toContain(uid(11));
  expect(seenScopes).toContain(uid(12));
});

test('Super Admin mobile Admin Panel appears only inside a store', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await fixture(page, 'super_admin', { selectedStore: false });
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/summary/**', route => route.fulfill({
    json: { metrics: { totalUsers: 0, activeUsers: 0, totalDatasets: 0, totalCustomers: 0 }, users: [], recentDatasets: [], recentUsers: [] },
    headers: { 'access-control-allow-origin': '*' },
  }));
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/targets/**', route => route.fulfill({ json: [], headers: { 'access-control-allow-origin': '*' } }));
  await page.route('http://127.0.0.1:54321/functions/v1/crm-api/api/admin/stores/**', route => route.fulfill({ json: { results: [{ id: uid(11), name: 'Store A' }] }, headers: { 'access-control-allow-origin': '*' } }));
  await page.goto('/admin-panel/stores');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav.getByRole('link', { name: 'Admin Panel' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Open store' }).click();
  await page.goto('/admin-panel');
  await page.getByRole('button', { name: 'Open navigation menu' }).click();
  await expect(nav.getByRole('link', { name: 'Admin Panel' })).toBeVisible();
  await nav.getByRole('link', { name: 'Admin Panel' }).click();
  await expect(page.getByRole('heading', { name: 'Admin Panel', exact: true })).toBeVisible();
});

for (const width of [320, 390, 1440]) test(`Store creation dialog ${width}px keeps required details and focus`, async ({ page }) => {
  await page.setViewportSize({ width, height: 420 });
  const state = await fixture(page, 'super_admin', { selectedStore: false });
  await page.goto('/admin-panel/stores');
  await page.getByRole('button', { name: 'Add store' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add store' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Store name')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Add store' }).click();
  await dialog.getByRole('button', { name: 'Create store' }).click();
  expect(state.mutations.filter(row => row.path.endsWith('/admin/stores/'))).toHaveLength(0);
  for (const [label, value] of [
    ['Store name', 'Release QA Store'], ['Contact person', 'Release QA'],
    ['Email', 'qa@example.test'], ['Phone number', '+91 9876543210'],
    ['Street address', '1 Test Road'], ['City', 'Kochi'],
    ['State or region', 'Kerala'], ['Postal code', '682001'],
  ]) await dialog.getByLabel(label, { exact: true }).fill(value);
  const bounds = await dialog.locator('.modal-content').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(421);
  await expect(dialog.getByRole('button', { name: 'Create store' })).toBeInViewport();
  await dialog.getByRole('button', { name: 'Create store' }).click();
  await expect.poll(() => state.mutations.filter(row => row.path.endsWith('/admin/stores/')).length).toBe(1);
  expect(state.mutations.find(row => row.path.endsWith('/admin/stores/')).body).toEqual({
    name: 'Release QA Store', contact_person: 'Release QA', contact_email: 'qa@example.test',
    contact_phone: '+91 9876543210', address_line1: '1 Test Road', city: 'Kochi', state: 'Kerala', postal_code: '682001',
  });
  await expect(dialog).not.toBeVisible();
  expect(state.errors).toEqual([]);
});

test('Store Admin cannot open store creation dialog', async ({ page }) => {
  await fixture(page, 'admin');
  await page.goto('/admin-panel/stores');
  await expect(page.getByRole('button', { name: 'Add store' })).toHaveCount(0);
});
