import { test, expect } from '@playwright/test';

async function isolatedComponents(page) {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await page.route('**/phase4-harness', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="stylesheet" href="/node_modules/bootstrap/dist/css/bootstrap.min.css"><link rel="stylesheet" href="/src/styles/app.css"></head><body><button id="outside">Background action</button><div id="root"></div><script type="module">
    import RefreshRuntime from '/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOMClient from '/node_modules/.vite/deps/react-dom_client.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom.js';
    window.harness = { React, root: ReactDOMClient.createRoot(document.getElementById('root')), flushSync: ReactDOM.flushSync };
  </script></body></html>` }));
  await page.goto('/phase4-harness');
  await page.waitForFunction(() => Boolean(window.harness));
}

test('Phase 4: session expiry cannot be undone by an older pending session refresh', async ({ page }) => {
  await isolatedComponents(page);
  await page.evaluate(async () => {
    const { authApi } = await import('/src/services/api.js');
    const { crmSupabase } = await import('/src/services/crmSupabase.js');
    const { AuthProvider, useAuth } = await import('/src/hooks/useAuth.jsx');
    authApi.session = () => new Promise(resolve => { window.resolveSession = resolve; });
    crmSupabase.auth.onAuthStateChange = () => ({ data: { subscription: { unsubscribe() {} } } });
    function Status() { const auth = useAuth(); return window.harness.React.createElement('p', { id: 'auth-status' }, auth.isLoading ? 'loading' : auth.user?.id || 'signed out'); }
    window.harness.root.render(window.harness.React.createElement(AuthProvider, {}, window.harness.React.createElement(Status)));
  });
  await expect(page.locator('#auth-status')).toHaveText('loading');
  await page.waitForFunction(() => Boolean(window.resolveSession));
  await page.evaluate(() => window.dispatchEvent(new Event('crm:session-expired')));
  await expect(page.locator('#auth-status')).toHaveText('signed out');
  await page.evaluate(() => window.resolveSession({ data: { user: { id: 'previous-account' } } }));
  await page.waitForTimeout(50);
  await expect(page.locator('#auth-status')).toHaveText('signed out');
});

test('Phase 4: confirmation traps escaped focus, skips hidden controls, restores focus and releases listeners', async ({ page }, testInfo) => {
  await isolatedComponents(page);
  await page.evaluate(async () => {
    const { default: ConfirmationDialog } = await import('/src/components/ConfirmationDialog.jsx');
    const { React, root, flushSync } = window.harness;
    window.renderDialog = open => flushSync(() => root.render(React.createElement(ConfirmationDialog, {
      open, title: 'Review task', actionLabel: 'Approve', details: React.createElement('button', { style: { display: 'none' } }, 'Hidden action'),
      onCancel: () => window.renderDialog(false), onConfirm: () => window.renderDialog(false),
    })));
    window.renderDialog(false);
  });
  await page.locator('#outside').focus();
  await page.evaluate(() => window.renderDialog(true));
  const dialog = page.getByRole('dialog', { name: 'Review task' });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.evaluate(() => document.getElementById('outside').focus());
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole('button', { name: 'Approve', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#outside')).toBeFocused();
  expect(await page.evaluate(() => document.body.classList.contains('crm-dialog-open'))).toBe(false);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const snapshot = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const counters = await cdp.send('Memory.getDOMCounters');
    const { metrics } = await cdp.send('Performance.getMetrics');
    return { ...counters, heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize').value };
  };
  // Warm the component before measuring retained resources, rather than module initialization.
  await page.evaluate(async () => { for (let index = 0; index < 5; index += 1) { window.renderDialog(true); await new Promise(requestAnimationFrame); window.renderDialog(false); } });
  const before = await snapshot();
  await page.evaluate(async () => { for (let index = 0; index < 100; index += 1) { window.renderDialog(true); await new Promise(requestAnimationFrame); window.renderDialog(false); } });
  const after = await snapshot();
  await testInfo.attach('dialog-retained-resources.json', { body: JSON.stringify({ cycles: 100, before, after }), contentType: 'application/json' });
  expect(after.jsEventListeners).toBeLessThanOrEqual(before.jsEventListeners);
  expect(after.nodes).toBeLessThanOrEqual(before.nodes + 5);
  expect(after.heapBytes).toBeLessThan(before.heapBytes + 2_000_000);
  expect(await page.evaluate(() => document.body.classList.contains('crm-dialog-open'))).toBe(false);
});

async function appFixture(page, { role = 'admin', selectedStore = false } = {}) {
  const id = '00000000-0000-4000-8000-000000000001';
  const profile = { id, employee_id: 'QAADMIN', name: 'Local QA', email: 'qa@example.test', role, active: true, store_id: role === 'super_admin' ? null : '00000000-0000-4000-8000-000000000011' };
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: id, role: 'authenticated', exp: 4070908800 })}.local-only`, refresh_token: 'local-refresh', token_type: 'bearer', expires_at: 4070908800, user: { id, email: profile.email, aud: 'authenticated', role: 'authenticated', user_metadata: {} } };
  const reads = [], mutations = [];
  await page.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), session);
  if (selectedStore) await page.addInitScript(() => sessionStorage.setItem('crm-super-admin-store', '00000000-0000-4000-8000-000000000011'));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  await page.route('http://127.0.0.1:54321/**', route => {
    const path = new URL(route.request().url()).pathname;
    reads.push(path);
    let payload = [];
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    if (path.endsWith('/datasets/1/customers/1/')) {
      if (route.request().method() === 'PATCH') {
        mutations.push(route.request().postDataJSON());
        return route.fulfill({ status: 409, json: { detail: 'This customer was updated by another user. Reload before saving.' }, headers: { 'access-control-allow-origin': '*' } });
      }
      payload = { dataset: { id: 1, name: 'Local QA' }, record: { id: 1, revision: 7, display_name: 'Alice', response: 'interested', note: 'Original note' }, responseChoices: [{ value: 'interested', label: 'Interested' }], fieldRows: [{ label: 'Name', value: 'Alice' }], changeHistory: [] };
    }
    else if (path.includes('/rest/v1/profiles')) payload = role === 'super_admin' && selectedStore && !new URL(route.request().url()).searchParams.has('id') ? [] : [profile];
    else if (path.includes('/auth/v1/user')) payload = session.user;
    else if (path.includes('/auth/v1/')) payload = {};
    else if (path.endsWith('/dashboard/') || path.endsWith('/reports/summary/')) payload = { totalDatasets: 0, totalCustomers: 0, responseStats: [], recentDatasets: [], payments: {}, sales: {} };
    else if (path.endsWith('/task-notifications/')) payload = { results: [], unreadCount: 0 };
    else if (path.endsWith('/customers/')) payload = { results: [], statusOptions: [], totalCount: 0, pagination: { page: 1, numPages: 1, count: 0 } };
    else if (path.endsWith('/sales/report/')) payload = { totalVisits: 0, totalExpenses: 0, activeMonths: 0, statuses: [], recentMonths: [] };
    else if (path.includes('/functions/v1/')) payload = { results: [], pagination: { page: 1, numPages: 1, count: 0 } };
    return route.fulfill({ json: payload, headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true' } });
  });
  return { reads, mutations };
}

test('Phase 4: daily work dialog exposes all field names and contains keyboard focus', async ({ page }) => {
  await appFixture(page);
  await page.goto('/attendance/timesheet');
  const trigger = page.getByRole('button', { name: '+ New entry', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'New work entry' });
  for (const label of ['Date', 'Project', 'Work details', 'Category *', 'Start', 'End', 'Break hours', 'Work status', 'Comments', 'Billable']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(1);
  await dialog.getByLabel('Project', { exact: true }).fill('Keyboard QA');
  await dialog.getByRole('button', { name: 'Submit entry' }).focus();
  await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Submit entry' })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.classList.contains('crm-dialog-open'))).toBe(false);
});

test('Phase 4: report hover fetches aggregates without downloading visit history', async ({ page }) => {
  const { reads } = await appFixture(page);
  await page.goto('/dashboard');
  await page.locator('.app-sidebar').getByRole('link', { name: 'Reports', exact: true }).hover();
  await expect.poll(() => reads.some(path => path.endsWith('/sales/report/'))).toBe(true);
  expect(reads.filter(path => path.endsWith('/sales/visits/'))).toHaveLength(0);
});

test('Phase 4: customer conflict sends its loaded revision and preserves the editable draft', async ({ page }) => {
  const { mutations } = await appFixture(page);
  await page.goto('/datasets/1/customers/1/edit');
  const note = page.getByLabel('Note', { exact: true });
  await expect(note).toHaveValue('Original note');
  await note.fill('Keep my unsaved changes');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'another user' })).toBeVisible();
  await expect(note).toBeVisible();
  await expect(note).toHaveValue('Keep my unsaved changes');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  expect(mutations).toEqual([{ response: 'interested', callback_date: '', note: 'Keep my unsaved changes', expected_revision: 7 }]);
  await page.reload();
  await expect(note).toHaveValue('Original note');
});

test('Phase 4: hidden workspaces pause health probes and offline recovery preserves an unsaved form', async ({ page }) => {
  const { reads } = await appFixture(page);
  await page.goto('/datasets/1/customers/1/edit');
  const note = page.getByLabel('Note', { exact: true });
  await note.fill('Draft survives connection loss');
  await page.clock.install();
  const healthReads = () => reads.filter(path => path.endsWith('/auth/v1/health')).length;
  await page.evaluate(() => {
    window.testHidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const before = healthReads();
  await page.clock.fastForward(20_000);
  expect(healthReads()).toBe(before);
  await page.evaluate(() => { window.testHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(healthReads).toBeGreaterThan(before);
  await page.context().setOffline(true);
  await expect(page.getByRole('heading', { name: 'No internet connection' })).toBeVisible();
  await expect(note).toHaveValue('Draft survives connection loss');
  await page.context().setOffline(false);
  await expect(note).toBeVisible();
  await expect(note).toHaveValue('Draft survives connection loss');
});

test('Phase 4: employee administration form exposes accessible names and password visibility', async ({ page }) => {
  await appFixture(page, { role: 'super_admin', selectedStore: true });
  await page.goto('/attendance/employees');
  await page.getByRole('button', { name: '+ Add employee', exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Create employee', exact: true }) });
  for (const label of ['Employee ID', 'Name', 'Username / login email', 'Department', 'Manager', 'Role', 'Start', 'End', 'Temporary password']) await expect(form.getByLabel(label, { exact: true })).toHaveCount(1);
  const password = form.getByLabel('Temporary password');
  await expect(password).toHaveAttribute('type', 'password');
  await form.getByRole('button', { name: 'Show password' }).click();
  await expect(password).toHaveAttribute('type', 'text');
  await form.getByRole('button', { name: 'Hide password' }).click();
  await expect(password).toHaveAttribute('type', 'password');
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).not.toBeVisible();
});

test('Phase 4: repeated cross-module SPA navigation retains bounded resources and pauses hidden work', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors = [], pendingRequests = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().startsWith('http://127.0.0.1:54321/')) pendingRequests.add(request); });
  page.on('requestfinished', request => pendingRequests.delete(request));
  page.on('requestfailed', request => pendingRequests.delete(request));
  await page.addInitScript(() => {
    const setInterval = window.setInterval.bind(window), clearInterval = window.clearInterval.bind(window);
    window.phase4Intervals = new Set();
    window.setInterval = (callback, delay, ...args) => {
      const id = setInterval(callback, delay, ...args); window.phase4Intervals.add(id); return id;
    };
    window.clearInterval = id => { window.phase4Intervals.delete(id); clearInterval(id); };
    window.phase4DocumentId = Math.random();
  });
  const { reads } = await appFixture(page);
  await page.goto('/dashboard');
  const initialDocumentId = await page.evaluate(() => window.phase4DocumentId);
  const routes = [
    ['/customers', 'All Customers'], ['/datasets', 'Customer Lists'], ['/callbacks', 'Callbacks'],
    ['/reminders', 'Reminders'], ['/reports', 'Reports'], ['/attendance', 'Attendance'],
    ['/notifications', 'Notifications'], ['/dashboard', /^CRM Dashboard/],
  ];
  const navigate = async ([path, title]) => {
    const sidebar = page.locator('.app-sidebar');
    if (['/customers', '/datasets'].includes(path) && !await sidebar.locator(`a[href="${path}"]`).count()) await sidebar.getByRole('button', { name: 'Customer Lists', exact: true }).click();
    await sidebar.locator(`a.sidebar-link[href="${path}"]`).click();
    await expect(page.getByRole('heading', { name: title, exact: typeof title === 'string' })).toBeVisible();
    await expect.poll(() => pendingRequests.size).toBe(0);
  };
  // Load every lazy module/provider once before measuring retained resources.
  for (const route of routes) await navigate(route);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const snapshot = async () => {
    await expect.poll(() => pendingRequests.size).toBe(0);
    await cdp.send('HeapProfiler.collectGarbage');
    const counters = await cdp.send('Memory.getDOMCounters');
    const { metrics } = await cdp.send('Performance.getMetrics');
    const app = await page.evaluate(async () => {
      const { getApiPerformanceSnapshot } = await import('/src/services/api.js');
      const { crmSupabase } = await import('/src/services/crmSupabase.js');
      return { intervals: window.phase4Intervals.size, channels: crmSupabase.getChannels().length, cacheEntries: getApiPerformanceSnapshot().cacheEntries, documentId: window.phase4DocumentId };
    });
    return { ...counters, heapBytes: metrics.find(metric => metric.name === 'JSHeapUsedSize').value, ...app, pendingRequests: pendingRequests.size };
  };
  const before = await snapshot();
  for (let cycle = 0; cycle < 8; cycle += 1) for (const route of routes) await navigate(route);
  // Pause health and feed polling in the same document after all route cycles.
  await page.evaluate(() => {
    window.phase4Hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.phase4Hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => pendingRequests.size).toBe(0);
  const hiddenReadsBefore = reads.length;
  await page.waitForTimeout(5500);
  const hiddenAdditionalRequests = reads.length - hiddenReadsBefore;
  await page.evaluate(() => { window.phase4Hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  const after = await snapshot();
  const evidence = { cycles: 8, routesPerCycle: routes.length, measuredNavigations: routes.length * 8, warmupNavigations: routes.length, before, after, hiddenObservationMs: 5500, hiddenAdditionalRequests, errors };
  await testInfo.attach('cross-module-retained-resources.json', { body: JSON.stringify(evidence), contentType: 'application/json' });
  expect(after.documentId).toBe(initialDocumentId);
  expect(after.jsEventListeners).toBeLessThanOrEqual(before.jsEventListeners + 10);
  expect(after.nodes).toBeLessThanOrEqual(before.nodes + 20);
  expect(after.heapBytes).toBeLessThan(before.heapBytes + 5_000_000);
  expect(after.intervals).toBeLessThanOrEqual(before.intervals + 1);
  expect(after.channels).toBeLessThanOrEqual(before.channels);
  expect(after.cacheEntries).toBeLessThanOrEqual(200);
  expect(after.pendingRequests).toBe(0);
  expect(hiddenAdditionalRequests).toBe(0);
  expect(errors).toEqual([]);
});
