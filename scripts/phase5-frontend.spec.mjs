import { test, expect } from '../frontend/node_modules/@playwright/test/index.mjs';

const id = '00000000-0000-4000-8000-000000000001';
const profile = { id, employee_id: 'QAADMIN', name: 'Local release QA', email: 'qa@example.test', role: 'admin', active: true, store_id: '00000000-0000-4000-8000-000000000011' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const session = { access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: id, role: 'authenticated', exp: 4070908800 })}.local-only`, refresh_token: 'local-refresh', token_type: 'bearer', expires_at: 4070908800, user: { id, email: profile.email, aud: 'authenticated', role: 'authenticated', user_metadata: {} } };

async function fixture(page) {
  const errors = [], requests = [], failed = [], pending = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => pending.add(request));
  page.on('requestfinished', request => pending.delete(request));
  page.on('requestfailed', request => { pending.delete(request); failed.push({ url: request.url(), error: request.failure()?.errorText }); });
  await page.addInitScript(session => localStorage.setItem('sb-127-auth-token', JSON.stringify(session)), session);
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  const statusOptions = ['no_response', 'interested', 'callback', 'not_interested', 'converted'].map(value => ({ value, label: value.replaceAll('_', ' '), count: 5000 }));
  const datasets = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Release dataset ${index + 1}`, customer_count: 250, created_at: '2026-11-01T09:00:00Z' }));
  const employees = Array.from({ length: 100 }, (_, index) => ({ ...profile, id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`, employee_id: `REL${index + 1}`, name: `Release employee ${index + 1}`, role: 'employee' }));
  const jpeg = await page.evaluate(() => {
    const make = (width, height) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d'), gradient = ctx.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, '#a4c4dd'); gradient.addColorStop(1, '#24475a'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#fff'; ctx.font = `${Math.max(8, Math.floor(width / 14))}px sans-serif`; ctx.fillText('Synthetic release image', width / 12, height / 2);
      return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    };
    return { full: make(1280, 960), thumbnail: make(88, 66) };
  });
  const images = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, original_name: `release-photo-${index + 1}.jpg`, url: `http://127.0.0.1:54321/storage/v1/object/sign/qa/full-${index + 1}.jpg`, thumbnail_url: `http://127.0.0.1:54321/storage/v1/object/sign/qa/thumb-${index + 1}.jpg` }));
  const punches = employees.flatMap((employee, employeeIndex) => Array.from({ length: 40 }, (_, punchIndex) => {
    const day = Math.floor(punchIndex / 4), hour = ['09:00', '13:00', '13:30', '18:00'][punchIndex % 4];
    const date = new Date(Date.UTC(2026, 10, 7 - day)).toISOString().slice(0, 10);
    const punched_at = `${date}T${hour}:00+05:30`;
    return { id: `00000000-0000-4000-8000-${String(employeeIndex * 40 + punchIndex + 1).padStart(12, '0')}`, user_id: employee.id, employee_id: employee.employee_id, employee_name: employee.name, punch_code: employee.employee_id, punched_at, created_at: punched_at, updated_at: '2026-11-07T15:00:00Z', status: '0', serial_number: 'SYNTHETIC-QA' };
  }));
  const customer = number => ({ record: { id: number, display_name: `Release customer ${number}`, response: 'interested', response_label: 'Interested', original_data: { Name: `Release customer ${number}`, Phone: `90000${String(number).padStart(5, '0')}`, City: 'Synthetic City' }, note: 'Synthetic release data' }, datasetId: 1, datasetName: datasets[0].name, fieldRows: [{ label: 'Name', value: `Release customer ${number}` }, { label: 'Phone', value: `90000${String(number).padStart(5, '0')}` }, { label: 'City', value: 'Synthetic City' }] });
  await page.route('http://127.0.0.1:54321/**', async route => {
    const start = performance.now(), request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
    let payload = { results: [], pagination: { page: 1, numPages: 1, count: 0 } };
    if (path.includes('/storage/v1/object/sign/qa/')) {
      const body = Buffer.from(path.includes('/thumb-') ? jpeg.thumbnail : jpeg.full, 'base64');
      await route.fulfill({ body, contentType: 'image/jpeg', headers: { 'timing-allow-origin': '*' } });
      requests.push({ path, responseImageBytes: body.length, fixtureHandlerMs: performance.now() - start }); return;
    }
    if (path.includes('/rest/v1/profiles')) payload = url.searchParams.has('id') ? [profile] : [profile, ...employees];
    else if (path.includes('/auth/v1/user')) payload = session.user;
    else if (path.includes('/auth/v1/')) payload = {};
    else if (path.endsWith('/task-notifications/')) payload = { results: [], unread_count: 0 };
    else if (path.endsWith('/datasets/')) payload = { results: datasets };
    else if (path.endsWith('/dashboard/') || path.endsWith('/reports/summary/')) payload = { totalDatasets: 100, totalCustomers: 25_000, responseStats: statusOptions, recentDatasets: datasets.slice(0, 5), payments: {}, sales: {} };
    else if (path.endsWith('/customers/')) {
      const query = url.searchParams.get('q'), pageNumber = Number(url.searchParams.get('page') || 1);
      payload = { results: Array.from({ length: query ? 1 : 50 }, (_, index) => customer(query ? 24999 : (pageNumber - 1) * 50 + index + 1)), statusOptions, totalCount: 25_000, searchQuery: query || '', pagination: { page: pageNumber, numPages: query ? 1 : 500, count: query ? 1 : 25_000 } };
    }
    else if (path.endsWith('/sales/visits/')) payload = { results: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, client_name: `Release client ${index + 1}`, dataset_name: datasets[0].name, visit_date: '2026-11-07', meeting_time: '10:00:00', location: 'Synthetic City', expense: 15.5, status: 'converted', status_label: 'Converted', total_amount: 1000, paid_amount: 250, pending_amount: 750, payment_status: 'partially_paid', note: 'Synthetic release visit', images: [] })), pagination: { page: 1, numPages: 5000, count: 25_000 } };
    else if (path.endsWith('/sales/summary/')) payload = { totalVisits: 25_000, todaysVisits: 5, monthVisits: 1000, totalVisitExpenses: 387500 };
    else if (path.endsWith('/sales/report/')) payload = { totalVisits: 25_000, totalExpenses: 387500, activeMonths: 6, statuses: [{ value: 'converted', label: 'Converted', count: 25_000 }], recentMonths: Array.from({ length: 6 }, (_, index) => ({ key: `2026-${String(index + 6).padStart(2, '0')}`, label: `Month ${index + 1}`, count: index === 5 ? 5000 : 4000 })) };
    else if (path.endsWith('/admin/tasks/')) payload = { results: [{ id: 1, title: 'Release image task', status: 'submitted', assignee_username: 'REL1', assigned_by_username: 'QAADMIN', created_at: '2026-11-01', assignment_images: images, completion_images: images, current_submission: { id: 1, note: 'Synthetic evidence', images }, submissions: [] }] };
    else if (path.includes('/rest/v1/attendance_records')) {
      const selection = url.searchParams.get('select'), order = url.searchParams.get('order') || '';
      let rows = punches.slice();
      const cursor = url.searchParams.get('or') || '';
      const field = cursor.includes('punched_at') ? 'punched_at' : 'updated_at';
      const cursorTime = cursor.match(new RegExp(`${field}\\.(?:lt|gt)\\.([^,]+)`))?.[1];
      const cursorId = cursor.match(/id\.(?:lt|gt)\.([^,)]+)/)?.[1];
      if (cursorTime) rows = rows.filter(row => field === 'punched_at' ? Date.parse(row[field]) < Date.parse(cursorTime) || Date.parse(row[field]) === Date.parse(cursorTime) && row.id < cursorId : Date.parse(row[field]) > Date.parse(cursorTime) || Date.parse(row[field]) === Date.parse(cursorTime) && row.id > cursorId);
      if (selection === 'id' && url.searchParams.has('id')) rows = rows.filter(row => row.id > url.searchParams.get('id').slice(3));
      rows.sort((a, b) => order.startsWith('punched_at') ? Date.parse(b.punched_at) - Date.parse(a.punched_at) || b.id.localeCompare(a.id) : order.startsWith('updated_at') ? Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.id.localeCompare(b.id) : a.id.localeCompare(b.id));
      rows = rows.slice(0, Number(url.searchParams.get('limit') || 500));
      payload = selection === 'id' ? rows.map(row => ({ id: row.id })) : selection === 'updated_at' ? rows.map(row => ({ updated_at: row.updated_at })) : rows;
    }
    else if (path.includes('/rest/v1/')) payload = [];
    const body = JSON.stringify(payload);
    await route.fulfill({ body, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-credentials': 'true', 'timing-allow-origin': '*' } });
    requests.push({ path, query: Object.fromEntries(url.searchParams), responseJsonBytes: Buffer.byteLength(body), fixtureHandlerMs: performance.now() - start });
  });
  return { errors, requests, failed, pending };
}

for (const base of ['/CRM/', '/review-crm/', '/']) test(`Phase 5 production artifact: ${base} deep routing, assets and worker`, async ({ page, request }, testInfo) => {
  const state = await fixture(page);
  const response = await page.goto(`${base}customers`);
  expect(response.status()).toBe(404); // Pages fallback preserves path and serves index.
  await expect(page.getByRole('heading', { name: 'All Customers', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Release customer' })).toHaveCount(50);
  const assets = await page.evaluate(() => [...document.querySelectorAll('link[rel="icon"],link[rel="manifest"]')].map(link => ({ rel: link.rel, href: link.href })));
  const results = [];
  for (const asset of assets) { const response = await request.get(asset.href); results.push({ ...asset, status: response.status(), type: response.headers()['content-type'] }); expect(response.status(), asset.href).toBe(200); }
  const manifestUrl = assets.find(asset => asset.rel === 'manifest').href;
  const manifest = await (await request.get(manifestUrl)).json();
  expect(new URL(manifest.scope, manifestUrl).pathname).toBe(base);
  expect(new URL(manifest.start_url, manifestUrl).pathname).toBe(base);
  expect((await request.get(new URL(manifest.icons[0].src, manifestUrl).href)).status()).toBe(200);
  if (base === '/') expect((await request.get('/static/images/customer-crm.svg')).status(), 'root-scope worker icon').toBe(200);
  const worker = await page.evaluate(async base => {
    const registration = await navigator.serviceWorker.register(`${base}service-worker.js`, { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    return { scope: registration.scope, script: registration.active?.scriptURL || registration.installing?.scriptURL };
  }, base);
  expect(new URL(worker.scope).pathname).toBe(base);
  await testInfo.attach('artifact-smoke.json', { body: JSON.stringify({ base, deepLinkStatus: response.status(), results, worker, errors: state.errors }), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
});

test('Phase 5 production build: bounded fixture rendering and local browser measurements', async ({ page }, testInfo) => {
  const state = await fixture(page), results = [];
  const measure = async (name, action, ready) => {
    const before = state.requests.length, started = performance.now();
    await action(); await ready();
    await expect.poll(() => [...state.pending].filter(request => !request.url().includes('/realtime/')).length).toBe(0);
    results.push({ name, actionToReadyMs: performance.now() - started, api: state.requests.slice(before) });
  };
  await measure('cold_initial_dashboard', () => page.goto('/CRM/'), () => expect(page.getByRole('heading', { name: /^CRM Dashboard/ })).toBeVisible());
  const cold = await page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()), paint: performance.getEntriesByType('paint').map(entry => entry.toJSON()), resources: performance.getEntriesByType('resource').map(entry => ({ name: entry.name, initiatorType: entry.initiatorType, duration: entry.duration, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, transferSize: entry.transferSize })) }));
  const go = async (path, heading) => {
    const sidebar = page.locator('.app-sidebar');
    if (['customers', 'datasets'].includes(path) && !await sidebar.locator(`a[href="/CRM/${path}"]`).count()) await sidebar.getByRole('button', { name: 'Customer Lists', exact: true }).click();
    await sidebar.locator(`a.sidebar-link[href="/CRM/${path}"]`).click();
    await expect(page.getByRole('heading', { name: heading, exact: typeof heading === 'string' })).toBeVisible();
  };
  await measure('customers_first_50_of_25000', () => go('customers', 'All Customers'), () => expect(page.getByRole('row').filter({ hasText: 'Release customer' })).toHaveCount(50));
  await measure('customer_search', async () => { await page.getByLabel('Search by client name').fill('24999'); await page.getByRole('button', { name: 'Search', exact: true }).click(); }, () => expect(page.getByRole('row').filter({ hasText: 'Release customer 24999' })).toHaveCount(1));
  await measure('dataset_list_100_entries_5_visible', () => go('datasets', 'Customer Lists'), () => expect(page.getByRole('row').filter({ hasText: 'Release dataset' })).toHaveCount(5));
  await measure('sales_first_5_of_25000', () => go('sales', 'Client Visits'), () => expect(page.locator('.sales-visits-table tbody tr')).toHaveCount(5));
  await measure('sales_report_25000_summary', () => go('reports', 'Reports'), () => expect(page.getByRole('heading', { name: 'Sales Insights', exact: true })).toBeVisible());
  await measure('attendance_4000_punches_100_employees_10_days', () => go('attendance', 'Attendance'), async () => {
    await expect(page.getByRole('button', { name: 'Download XLSX', exact: true })).toBeEnabled();
    await expect(page.locator('.attendance-metrics .summary-card').filter({ hasText: 'Punches' })).toContainText('4000');
    await expect.poll(() => state.requests.some(request => request.path.includes('/rest/v1/attendance_records') && request.query?.updated_at && request.query?.or?.includes('id.gt.00000000-0000-4000-8000-000000004000'))).toBe(true);
  });
  await measure('task_gallery_20_evidence_thumbnails', () => go('notifications', 'Notifications'), () => expect(page.getByRole('button', { name: 'Open Before photo 1: release-photo-1.jpg', exact: true })).toBeVisible());
  await measure('full_image_decode_1280x960', () => page.getByRole('button', { name: 'Open Before photo 1: release-photo-1.jpg', exact: true }).click(), () => expect(page.locator('.task-image-full')).toHaveJSProperty('naturalWidth', 1280));
  await page.getByRole('button', { name: 'Close image preview' }).click();
  await measure('warm_dashboard_navigation', () => go('dashboard', /^CRM Dashboard/), () => expect(page.getByRole('heading', { name: /^CRM Dashboard/ })).toBeVisible());
  const staticFailures = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.responseStatus >= 400).map(entry => ({ name: entry.name, status: entry.responseStatus })));
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({ name: entry.name, duration: entry.duration, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, transferSize: entry.transferSize })));
  await testInfo.attach('production-browser-performance.json', { body: JSON.stringify({ environment: 'Local gzip static server; minified Pages production build; instant synthetic API transport, no CPU/network throttle or hosted latency. Customer/sales counts describe fixture totals, not a real hosted database. Attendance returns4000 actual synthetic punch rows; image gallery uses real generated JPEG bytes, not provider delivery.', viewport: page.viewportSize(), cold, results, resources, staticFailures, failedRequests: state.failed, errors: state.errors }), contentType: 'application/json' });
  expect(state.errors).toEqual([]);
  // Leaving a live attendance route intentionally aborts its incremental read.
  // Preserve these separately in evidence rather than treating cancellation as
  // a transport outage or silently claiming no failed network events.
  expect(state.failed.filter(request => request.error !== 'net::ERR_ABORTED')).toEqual([]);
  expect(staticFailures).toEqual([]);
});
