import { test, expect } from '../frontend/node_modules/@playwright/test/index.mjs';
const widths = [320, 360, 375, 390, 414, 430, 768, 1440];
const longName = 'Alexandria Demonstration Employee With A Very Long Display Name';
const longToken = 'ExtremelyLongUnbrokenValueForMobileOverflowVerification'.repeat(3);
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

async function fixture(page, role = 'admin', options = {}) {
  const profile = { id: uid(1), employee_id: 'MOBILEQA', name: longName, email: `${longToken}@example.test`, department: longToken, manager: longName, active: true, role, store_id: role === 'super_admin' ? null : uid(11), created_at: '2026-11-01', shift_start_time: '09:00', shift_end_time: '18:00', profile_image: options.profileImage || null };
  const employee = { ...profile, id: uid(2), employee_id: 'EMPLOYEEWITHAVERYLONGIDENTIFIER', name: longName, role: 'employee', store_id: uid(11), active: !options.inactiveEmployee };
  const mappingEmployee = { ...employee, id: uid(3), employee_id: 'ACTIVE-MAP-TARGET', active: true };
  const punchOwner = options.inactiveEmployee ? mappingEmployee : employee;
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: uid(1), role: 'authenticated', exp: 4070908800 })}.local-only`, refresh_token: 'local-refresh', token_type: 'bearer', expires_at: 4070908800, user: { id: uid(1), email: profile.email, aud: 'authenticated', role: 'authenticated', user_metadata: {} } };
  const entry = { id: uid(44), user_id: role === 'employee' ? profile.id : employee.id, employee_id: role === 'employee' ? profile.employee_id : employee.employee_id, employee_name: employee.name, work_date: '2026-11-07', project: longToken, details: longToken, comments: longToken, category: 'Project Work', start_time: '09:00', end_time: '18:00', total_hours: 8, approval_status: 'Submitted', work_status: 'Completed' };
  const punches = ['09:00', '13:00', '14:00', '18:00'].map((hour, index) => ({ id: uid(100 + index), user_id: punchOwner.id, employee_id: punchOwner.employee_id, employee_name: punchOwner.name, punch_code: punchOwner.employee_id, punched_at: `2026-11-07T${hour}:00+05:30`, updated_at: '2026-11-07T15:00:00Z', created_at: '2026-11-07T15:00:00Z' }));
  const errors = [], mutations = [], reads = [];
  let timesheetReviewed = false, overtimeReviewed = false, entryDeleted = false, employeeDeleted = false;
  let profileReadsFail = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), session);
  if (options.selectedStore) await page.addInitScript(storeId => sessionStorage.setItem('crm-super-admin-store', storeId), uid(11));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await page.route('http://127.0.0.1:54321/**', route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-headers': '*' } });
    if (request.method() !== 'GET') mutations.push({ path, body: request.postDataJSON(), storeId: request.headers()['x-crm-store-id'] || '' });
    else reads.push({ path, query: Object.fromEntries(url.searchParams) });
    let payload = { results: [], pagination: { page: 1, numPages: 1, count: 0 } };
    if (path.includes('/rest/v1/profiles')) {
      if (url.searchParams.has('id') && profileReadsFail) return route.fulfill({ status: 403, json: { message: 'Local fixture: attendance profile refresh unavailable.' }, headers });
      const members = [...(role === 'super_admin' ? [] : [profile]), ...(!employeeDeleted ? [employee] : []), ...(options.inactiveEmployee ? [mappingEmployee] : [])];
      payload = url.searchParams.has('id') ? [profile] : members;
    }
    else if (path.includes('/rest/v1/timesheet_entries')) payload = timesheetReviewed || entryDeleted ? [] : [entry];
    else if (path.includes('/rest/v1/attendance_records')) payload = url.searchParams.get('select') === 'updated_at' ? [{ updated_at: punches[0].updated_at }] : punches;
    else if (path.endsWith('/rpc/get_store_dashboard_totals')) payload = { hours: 1234.5, overtime: 12.5, employees: 100, pending: 3 };
    else if (path.endsWith('/rpc/create_timesheet_entry')) payload = entry;
    else if (path.endsWith('/rpc/update_timesheet_entry')) { Object.assign(entry, { project: request.postDataJSON().p_project }); payload = entry; }
    else if (path.endsWith('/rpc/delete_timesheet_entry')) { entryDeleted = true; payload = {}; }
    else if (path.endsWith('/rpc/review_timesheet_entry')) { timesheetReviewed = true; payload = { ...entry, approval_status: 'Rejected' }; }
    else if (path.endsWith('/rpc/update_profile_image')) payload = {};
    else if (path.endsWith('/rpc/map_attendance_employee')) payload = 4;
    else if (path.endsWith('/functions/v1/admin-users')) { if (request.postDataJSON().action === 'delete') employeeDeleted = true; payload = {}; }
    else if (path.endsWith('/auth/v1/otp')) payload = {};
    else if (path.includes('/auth/v1/user')) payload = session.user;
    else if (path.includes('/auth/v1/')) payload = {};
    else if (path.endsWith('/task-notifications/')) payload = { results: [], unread_count: 0 };
    else if (path.endsWith('/overtime/')) payload = { requests: overtimeReviewed ? [] : [{ id: 1, employeeName: longName, username: longToken, workDate: '2026-11-07', officialEndTime: '18:00', declaredLeaveTime: '2026-11-07T14:00:00Z', actualPunchOut: '2026-11-07T14:00:00Z', requestedMinutes: 90, status: 'pending' }], approvedMinutes: 0 };
    else if (path.includes('/overtime/1/')) { overtimeReviewed = true; payload = {}; }
    else if (path.endsWith('/callbacks/')) payload = { results: [], counts: {} };
    else if (path.includes('/rest/v1/')) payload = [];
    return route.fulfill({ json: payload, headers });
  });
  return { errors, mutations, reads, failProfileReads: value => { profileReadsFail = value; } };
}

async function layout(page, route, width) {
  return page.evaluate(({ route, width }) => {
    const content = document.querySelector('.content-wrap');
    const controls = [...content.querySelectorAll('button, input:not([type="checkbox"]), select, textarea')].filter(element => element.getClientRects().length && !element.closest('[hidden]'));
    return { route, width, documentWidth: document.documentElement.scrollWidth, innerWidth, controls: controls.map(element => { const rect = element.getBoundingClientRect(); return { name: element.getAttribute('aria-label') || element.labels?.[0]?.textContent || element.textContent?.trim().slice(0, 60) || element.id, height: rect.height, width: rect.width, fontSize: getComputedStyle(element).fontSize, tag: element.tagName }; }), overflowingText: [...content.querySelectorAll('strong,h2,h3,p')].filter(element => !element.closest('.table-responsive') && element.getBoundingClientRect().right > innerWidth + 1).map(element => element.textContent.slice(0, 80)) };
  }, { route, width });
}
async function verifyLayout(page, route, width, samples) {
  const sample = await layout(page, route, width); samples.push(sample);
  expect.soft(sample.documentWidth, `${route} document overflow`).toBeLessThanOrEqual(width);
  expect.soft(sample.overflowingText, `${route} long text overflow`).toEqual([]);
  if (width <= 768) expect.soft(sample.controls.filter(control => control.height < 43.9 || control.width < 43.9), `${route} touch targets under44px`).toEqual([]);
}
async function showTableAction(page, label) {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  await expect(button).toBeVisible();
  await button.scrollIntoViewIfNeeded(); return button;
}

for (const width of widths) test(`${width}px attendance pages, timesheet modal, approvals, overtime and profile`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 740 });
  const state = await fixture(page), samples = [];
  for (const [route, heading] of [['/attendance', 'Attendance'], ['/attendance/overview', 'Attendance overview'], ['/attendance/employees', 'Attendance employees'], ['/attendance/profile', 'My profile']]) {
    await page.goto(route); await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    if (route === '/attendance/profile') {
      await expect(page.getByRole('heading', { name: longName, exact: true })).toBeVisible();
      await expect(page.getByLabel('Profile image', { exact: true })).toHaveCount(1);
      if ([320, 390, 768, 1440].includes(width)) { const path = testInfo.outputPath(`profile-${width}.png`); await page.screenshot({ path, fullPage: true }); await testInfo.attach('profile', { path, contentType: 'image/png' }); }
      const image = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 20; canvas.height = 20; canvas.getContext('2d').fillRect(0, 0, 20, 20); return canvas.toDataURL('image/png').split(',')[1]; });
      await page.getByLabel('Profile image', { exact: true }).setInputFiles({ name: 'mobile-profile.png', mimeType: 'image/png', buffer: Buffer.from(image, 'base64') });
      await page.getByRole('button', { name: 'Save profile image', exact: true }).click();
      await expect(page.getByText('Profile image saved.', { exact: true })).toBeVisible();
    }
    await verifyLayout(page, route, width, samples);
  }
  await page.goto('/attendance/timesheet');
  await page.getByRole('button', { name: '+ New entry', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New work entry' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Project', { exact: true }).fill(longToken);
  await dialog.getByLabel('Work details', { exact: true }).fill(longToken);
  await verifyLayout(page, 'timesheet entry modal', width, samples);
  // Short viewport is a keyboard-space stress case, not a physical keyboard test.
  await page.setViewportSize({ width, height: 420 });
  await dialog.getByLabel('Comments', { exact: true }).fill('Visible while keyboard-sized space is constrained');
  await dialog.getByRole('button', { name: 'Submit entry', exact: true }).scrollIntoViewIfNeeded();
  const bounds = await dialog.locator('.modal-content').boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(421);
  if ([320, 390, 768, 1440].includes(width)) { const path = testInfo.outputPath(`timesheet-short-${width}.png`); await page.screenshot({ path }); await testInfo.attach('timesheet-short-viewport', { path, contentType: 'image/png' }); }
  await dialog.getByRole('button', { name: 'Submit entry', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.mutations.some(row => row.path.endsWith('/rpc/create_timesheet_entry'))).toBe(true);
  await page.setViewportSize({ width, height: 740 });
  for (const route of ['/attendance/approvals', '/attendance/overtime']) {
    await page.goto(route);
    const reject = await showTableAction(page, 'Reject'); await reject.click();
    const review = page.getByRole('dialog'); await expect(review).toBeVisible();
    await review.getByRole('textbox').fill('Mobile feedback: please correct this entry.');
    await verifyLayout(page, `${route} rejection`, width, samples);
    await page.keyboard.press('Escape'); await expect(review).not.toBeVisible();
    await expect(reject).toBeFocused();
    await reject.click(); await review.getByRole('textbox').fill('Mobile feedback: please correct this entry.');
    await review.getByRole('button', { name: 'Confirm rejection', exact: true }).click();
    await expect(review).not.toBeVisible();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflowY)).not.toBe('hidden');
  }
  await testInfo.attach('attendance-layout.json', { body: JSON.stringify(samples), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
});

for (const width of widths) test(`${width}px global employee editor and password visibility`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 740 });
  const state = await fixture(page, 'super_admin', { selectedStore: true }), samples = [];
  await page.goto('/attendance/employees');
  await page.getByRole('button', { name: '+ Add employee', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill(longName);
  await page.getByLabel('Username / login email', { exact: true }).fill(`${longToken}@example.test`);
  await page.getByLabel('Temporary password', { exact: true }).fill('LocalOnlyPassword123');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Temporary password', { exact: true })).toHaveAttribute('type', 'text');
  await verifyLayout(page, 'global employee editor', width, samples);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await testInfo.attach('employee-layout.json', { body: JSON.stringify(samples), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
});

for (const width of widths) test(`${width}px employee overtime request form and restrictions`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 740 });
  const state = await fixture(page, 'employee'), samples = [];
  await page.goto('/overtime');
  await expect(page.getByRole('button', { name: 'Request OT', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
  await verifyLayout(page, 'employee overtime form', width, samples);
  await page.getByLabel('Working date', { exact: true }).fill('2026-11-07');
  await page.getByLabel('Expected / declared leaving time', { exact: true }).fill('2026-11-07T19:30');
  await page.getByRole('button', { name: 'Request OT', exact: true }).click();
  expect(state.mutations.filter(row => row.path.endsWith('/overtime/'))).toHaveLength(1);
  await page.goto('/attendance/profile');
  await expect(page.getByRole('button', { name: 'Reset password by email OTP', exact: true })).toHaveCount(0);
  await testInfo.attach('overtime-layout.json', { body: JSON.stringify(samples), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
});

for (const width of widths) test(`${width}px remaining popup variants and scoped workforce access`, async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const samples = [], actors = [];
  const actor = async (role, options = {}) => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, viewport: { width, height: 740 } });
    actors.push(context);
    const page = await context.newPage();
    return { page, state: await fixture(page, role, options) };
  };
  try {
    const scoped = await actor('super_admin', { selectedStore: true, inactiveEmployee: true });
    await scoped.page.goto('/attendance/employees');
    const removeEmployee = await showTableAction(scoped.page, 'Delete');
    await removeEmployee.click();
    let dialog = scoped.page.getByRole('dialog', { name: 'Delete employee account?' });
    await expect(dialog).toBeVisible(); await verifyLayout(scoped.page, 'inactive employee deletion', width, samples);
    await scoped.page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await removeEmployee.click(); await dialog.getByRole('button', { name: 'Delete employee', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(scoped.state.mutations.filter(row => row.path.endsWith('/functions/v1/admin-users') && row.body.action === 'delete')).toHaveLength(1);
    expect(scoped.state.mutations.find(row => row.path.endsWith('/functions/v1/admin-users') && row.body.action === 'delete').storeId).toBe(uid(11));
    expect(scoped.state.reads.some(row => row.path.includes('/rest/v1/profiles') && row.query.store_id === `eq.${uid(11)}`)).toBe(true);
    await scoped.page.goto('/attendance');
    await expect(scoped.page.getByRole('heading', { name: 'eSSL network push settings', exact: true })).toBeVisible();
    await expect(scoped.page.getByLabel('Machine punch code', { exact: true })).toBeEnabled();
    await scoped.page.getByLabel('Machine punch code', { exact: true }).selectOption('ACTIVE-MAP-TARGET');
    await scoped.page.getByLabel('Employee name', { exact: true }).selectOption(uid(3));
    await scoped.page.getByRole('button', { name: 'Link employee', exact: true }).click();
    await expect(scoped.page.getByText('4 punches linked successfully.', { exact: true })).toBeVisible();
    // The deleted synthetic employee is gone; the settings form still remains
    // bounded and its available options reflect the latest transport response.
    await verifyLayout(scoped.page, 'scoped eSSL and mapping controls', width, samples);

    const global = await actor('super_admin');
    await global.page.goto('/attendance/employees');
    await expect(global.page.getByRole('heading', { name: 'Open a store to manage employees', exact: true })).toBeVisible();
    await expect(global.page.getByRole('link', { name: 'Open Stores', exact: true })).toHaveAttribute('href', '/admin-panel/stores');
    await expect(global.page.getByRole('button', { name: '+ Add employee', exact: true })).toHaveCount(0);
    expect(global.state.reads.filter(row => row.path.includes('/rest/v1/profiles') && !row.query.id)).toHaveLength(0);
    await verifyLayout(global.page, 'unscoped Super Admin store prompt', width, samples);

    const employee = await actor('employee');
    await employee.page.goto('/attendance/timesheet');
    const edit = await showTableAction(employee.page, 'Edit'); await edit.click();
    dialog = employee.page.getByRole('dialog', { name: 'Edit work entry', exact: true });
    await expect(dialog.getByLabel('Project', { exact: true })).toHaveValue(longToken);
    await dialog.getByLabel('Project', { exact: true }).fill('Mobile edited project');
    await verifyLayout(employee.page, 'prefilled timesheet edit', width, samples);
    await dialog.getByRole('button', { name: 'Submit entry', exact: true }).click(); await expect(dialog).not.toBeVisible();
    const removeEntry = await showTableAction(employee.page, 'Delete'); await removeEntry.click();
    dialog = employee.page.getByRole('dialog', { name: 'Delete timesheet entry?', exact: true });
    await verifyLayout(employee.page, 'timesheet delete confirmation', width, samples);
    await employee.page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await removeEntry.click(); await dialog.getByRole('button', { name: 'Delete entry', exact: true }).click(); await expect(dialog).not.toBeVisible();
    expect(employee.state.mutations.filter(row => row.path.endsWith('/rpc/delete_timesheet_entry'))).toHaveLength(1);
    // Inject a synthetic profile UPDATE into the real subscribed callback.
    // Actual hosted Realtime delivery is deliberately not claimed here.
    employee.state.failProfileReads(true);
    await employee.page.evaluate(async () => {
      const { crmSupabase } = await import('/src/services/crmSupabase.js');
      const channel = crmSupabase.getChannels().find(item => item.topic.includes('attendance-account:'));
      if (!channel) throw new Error('Attendance profile subscription missing');
      for (const binding of channel.bindings.postgres_changes || []) if (binding.filter.table === 'profiles') binding.callback({ eventType: 'UPDATE', new: {}, old: {} });
    });
    await expect(employee.page.getByRole('heading', { name: 'Unable to open Attendance', exact: true })).toBeVisible();
    await verifyLayout(employee.page, 'Attendance unavailable and retry', width, samples);
    employee.state.failProfileReads(false);
    await employee.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(employee.page.getByRole('heading', { name: 'My timesheet', exact: true })).toBeVisible();

    const admin = await actor('admin', { profileImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=' });
    await admin.page.goto('/attendance/approvals');
    await (await showTableAction(admin.page, 'Approve')).click();
    dialog = admin.page.getByRole('dialog', { name: 'Approve timesheet entry?', exact: true });
    await verifyLayout(admin.page, 'timesheet approval confirmation', width, samples);
    await dialog.getByRole('button', { name: 'Confirm approval', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await admin.page.goto('/attendance/overtime');
    await (await showTableAction(admin.page, 'Approve')).click();
    dialog = admin.page.getByRole('dialog', { name: 'Approve overtime request?', exact: true });
    await verifyLayout(admin.page, 'overtime approval confirmation', width, samples);
    await dialog.getByRole('button', { name: 'Confirm approval', exact: true }).click(); await expect(dialog).not.toBeVisible();
    await admin.page.goto('/attendance/profile');
    await admin.page.getByRole('button', { name: 'Remove image', exact: true }).click();
    await expect(admin.page.getByText('Profile image removed.', { exact: true })).toBeVisible();
    await admin.page.getByRole('button', { name: 'Reset password by email OTP', exact: true }).click();
    await expect(admin.page.getByText(/Password reset email sent to/)).toBeVisible();
    await verifyLayout(admin.page, 'profile remove and local OTP feedback', width, samples);
    expect(admin.state.mutations.filter(row => row.path.endsWith('/auth/v1/otp'))).toHaveLength(1);
    await admin.page.goto('/attendance/employees');
    await expect(admin.page.getByRole('button', { name: '+ Add employee', exact: true })).toHaveCount(0);
    await expect(admin.page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await testInfo.attach('attendance-popup-variants.json', { body: JSON.stringify(samples), contentType: 'application/json' });
    for (const item of [scoped, global, employee, admin]) expect(item.state.errors).toEqual([]);
  } finally { for (const context of actors) await context.close(); }
});
