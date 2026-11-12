import { clearReminderDevice, reminderWorkerUrl } from "./reminderPush.js";
import axios from "axios";
import { salesRequestParams } from "../utils/sales.js";
import { crmSupabase, CRM_SUPABASE_PUBLISHABLE_KEY, CRM_SUPABASE_URL } from "./crmSupabase.js";
import { clearCrmProfileCache, readCrmProfile } from "./crmProfile.js";

import { clearAttendanceReadCache } from "./attendanceSupabase.js";
import { activeStoreId, subscribeStore } from "./storeContext.js";
import { prepareWorkbook, uploadStagedImport } from "../utils/workbookImport.js";

const crmApiUrl = `${CRM_SUPABASE_URL}/functions/v1/crm-api/api`;
const pendingImports = new Map();
const getCache = new Map();
let cacheScope = "anonymous";
const requestDiagnostics = [];
const cacheDiagnostics = { hits: 0, misses: 0, deduplicated: 0, staleRenders: 0 };
// Navigation should feel instant when a user returns to a CRM page. Mutations
// use their own endpoints, while read data is refreshed after this short,
// session-only window.
const GET_CACHE_TTL = 120_000;
let cacheGeneration = 0;
const STALE_CACHE_TTL = 10 * 60_000;
export const API_TIMEOUT_MS = 15_000;

// XLSX is a large dependency.  It is only needed while importing or exporting a
// workbook, so keep it out of the application shell and normal page loads.
let xlsxModule;
let currentUserCache = null;
let currentUserRequest = null;
function loadXlsx() {
  xlsxModule ??= import("xlsx");
  return xlsxModule;
}

export const apiClient = axios.create({
  baseURL: crmApiUrl,
  // Never leave a page in a pending state because a network connection or an
  // Edge Function stopped responding. Page-level error handling receives a
  // normal rejected request after this limit.
  timeout: API_TIMEOUT_MS,
  withCredentials: false,
  headers: {
    apikey: CRM_SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  },
});

const csrfHeaders = () => ({});

function cacheKey(url, params = {}) {
  const query = Object.entries(params || {})
    .filter(([, value]) => value !== undefined)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
  return `${cacheScope}|${activeStoreId()}|${url}?${query}`;
}

export function setApiCacheScope(userId) {
  const nextScope = userId ? `user:${userId}` : "anonymous";
  if (nextScope === cacheScope) return;
  cacheScope = nextScope;
  clearApiCache();
  pendingImports.clear();
}

export function clearApiCache() {
  getCache.clear();
  cacheGeneration += 1;
}

subscribeStore(() => { clearApiCache(); pendingImports.clear(); clearAttendanceReadCache(); });

export function invalidateApiCache(...urlPrefixes) {
  if (!urlPrefixes.length) {
    clearApiCache();
    return;
  }
  const scopedPrefix = `${cacheScope}|${activeStoreId()}|`;
  for (const key of getCache.keys()) {
    if (!key.startsWith(scopedPrefix)) continue;
    const url = key.slice(scopedPrefix.length).split("?")[0];
    if (urlPrefixes.some((prefix) => url.startsWith(prefix))) getCache.delete(key);
  }
}

function cachedGet(url, config = {}, maxAge = GET_CACHE_TTL) {
  const key = cacheKey(url, config.params);
  const generation = cacheGeneration;
  const storeId = activeStoreId();
  const cached = getCache.get(key);
  const now = Date.now();
  if (cached?.response && now - cached.createdAt < maxAge) {
    cacheDiagnostics.hits += 1;
    // Keep recently used pages when the bounded session cache evicts old reads.
    getCache.delete(key);
    getCache.set(key, cached);
    return Promise.resolve(cached.response);
  }
  if (cached?.request) {
    cacheDiagnostics.deduplicated += 1;
    return cached.request;
  }
  cacheDiagnostics.misses += 1;
  // Search terms and pagination keys can otherwise grow for an entire shift.
  for (const [oldKey, entry] of getCache) {
    if (!entry.request && now - entry.createdAt >= STALE_CACHE_TTL) getCache.delete(oldKey);
  }
  while (getCache.size >= 200) getCache.delete(getCache.keys().next().value);
  const entry = { ...cached, requestedAt: now };
  const request = apiClient.get(url, { ...config, crmStoreId: storeId })
    .then((response) => {
      // Mutation invalidation or eviction can replace a request without changing
      // the account/store generation. Only its own entry may publish a result.
      if (generation === cacheGeneration && getCache.get(key) === entry) getCache.set(key, { response, createdAt: Date.now() });
      return response;
    })
    .catch((error) => {
      // A failed background refresh must not erase safe, previously rendered
      // data. It remains available until the stale-display window expires.
      if (generation === cacheGeneration && getCache.get(key) === entry) {
        if (cached?.response) getCache.set(key, cached);
        else getCache.delete(key);
      }
      throw error;
    });
  entry.request = request;
  getCache.set(key, entry);
  return request;
}

// Components can render a recently fetched response synchronously on mount,
// avoiding even a one-frame loading flash when returning to a page.
export function peekCachedResponse(url, config = {}, maxAge = STALE_CACHE_TTL) {
  const cached = getCache.get(cacheKey(url, config.params));
  const response = cached?.response && Date.now() - cached.createdAt < maxAge ? cached.response : null;
  if (response && Date.now() - cached.createdAt >= GET_CACHE_TTL) cacheDiagnostics.staleRenders += 1;
  return response;
}

export function getApiPerformanceSnapshot() {
  return {
    scope: cacheScope,
    cacheEntries: getCache.size,
    cache: { ...cacheDiagnostics },
    recentRequests: requestDiagnostics.slice(-100),
  };
}

function invalidateForMutation(url = "") {
  const path = String(url).split("?")[0];
  if (path.startsWith("/auth/") || path.startsWith("/push/")) return;
  if (path.startsWith("/import/") || path.startsWith("/datasets/")) {
    invalidateApiCache("/dashboard/", "/datasets/", "/customers/", "/callbacks/");
    return;
  }
  if (path.startsWith("/customers/") || /\/customers\//.test(path) || path.startsWith("/callbacks/")) {
    invalidateApiCache("/dashboard/", "/datasets/", "/customers/", "/callbacks/", "/sales/clients/");
    return;
  }
  if (path.startsWith("/sales/")) {
    invalidateApiCache("/dashboard/", "/sales/", "/targets/", "/admin/targets/");
    return;
  }
  if (path.startsWith("/reminders/")) { invalidateApiCache("/reminders/"); return; }
  if (path.startsWith("/task-notifications/")) { invalidateApiCache("/task-notifications/"); return; }
  if (path.startsWith("/tasks/") || path.startsWith("/admin/tasks/")) {
    invalidateApiCache("/tasks/", "/admin/tasks/");
    if (typeof window !== "undefined") window.dispatchEvent(new Event("crm:tasks-updated"));
    return;
  }
  if (path.startsWith("/admin/targets/")) {
    invalidateApiCache("/targets/", "/dashboard/", "/datasets/", "/admin/targets/", "/admin/summary/");
    return;
  }
  if (path.startsWith("/admin/designations/")) {
    invalidateApiCache("/admin/designations/");
    return;
  }
  if (path.startsWith("/admin/users/")) {
    invalidateApiCache("/admin/", "/datasets/", "/dashboard/", "/targets/");
    return;
  }
  if (path.startsWith("/overtime/")) {
    invalidateApiCache("/overtime/", "/reminders/");
    return;
  }
  if (path.startsWith("/attendance/")) { invalidateApiCache("/attendance/"); return; }
  if (path.startsWith("/payroll/")) { invalidateApiCache("/payroll/"); return; }
  clearApiCache();
}

const multipartHeaders = () => ({
  headers: {
    "Content-Type": undefined,
  },
});

apiClient.interceptors.request.use(async (config) => {
  config.crmStartedAt = performance.now();
  const storeId = config.crmStoreId === undefined ? activeStoreId() : config.crmStoreId;
  config.crmStoreId = storeId;
  config.headers.set("apikey", CRM_SUPABASE_PUBLISHABLE_KEY);
  const { data, error } = await crmSupabase.auth.getSession();
  if (error) throw error;
  if (data.session?.access_token) config.headers.set("Authorization", `Bearer ${data.session.access_token}`);
  else config.headers.delete("Authorization");
  if (storeId) config.headers.set("x-crm-store-id", storeId);
  else config.headers.delete("x-crm-store-id");
  return config;
});

function apiError(detail, status = 400) {
  const error = new Error(detail);
  error.response = { status, data: { detail } };
  return error;
}

async function currentCrmUser() {
  const { data: sessionData, error: sessionError } = await crmSupabase.auth.getSession();
  if (sessionError) throw sessionError;
  const session = sessionData.session;
  if (!session?.user?.id) return null;
  if (currentUserCache?.id === session.user.id && Date.now() - currentUserCache.createdAt < 5_000) return currentUserCache.user;
  if (currentUserRequest?.id === session.user.id) return currentUserRequest.promise;
  const promise = (async () => {
    const profile = await readCrmProfile(session.user.id);
    if (!profile?.active) {
      await crmSupabase.auth.signOut();
      return null;
    }
    const isAdmin = ["admin", "super_admin"].includes(String(profile.role || "").toLowerCase());
    const user = {
      id: profile.id,
      username: profile.employee_id || profile.email || "user",
      email: profile.email || "",
      name: profile.name || profile.employee_id || "",
      is_staff: isAdmin,
      is_superuser: profile.role === "super_admin",
      is_admin: isAdmin,
      is_active: Boolean(profile.active),
      date_joined: profile.created_at,
      store_id: profile.store_id || "",
    };
    currentUserCache = { id: session.user.id, user, createdAt: Date.now() };
    return user;
  })();
  currentUserRequest = { id: session.user.id, promise };
  try {
    return await promise;
  } finally {
    if (currentUserRequest?.promise === promise) currentUserRequest = null;
  }
}

export const authApi = {
  session: async () => {
    const user = await currentCrmUser();
    return { data: { isAuthenticated: Boolean(user), user, csrfToken: "" } };
  },
  login: async (credentials) => {
    const identity = String(credentials.username || "").trim();
    if (!identity || !credentials.password) throw apiError("Enter your username and password.");
    try {
      const { data: legacy } = await apiClient.post("/auth/legacy-login/", {
        identity,
        password: credentials.password,
      });
      const { error: sessionError } = await crmSupabase.auth.setSession({
        access_token: legacy.access_token,
        refresh_token: legacy.refresh_token,
      });
      if (sessionError) throw apiError(sessionError.message || "Unable to start your CRM session.", 401);
      const user = await currentCrmUser();
      if (!user) throw apiError("This account is inactive or has no CRM profile.", 403);
      return { data: { user, csrfToken: "" } };
    } catch (error) {
      // New CRM accounts do not have a legacy credential. Both the legacy
      // endpoint's 404 and its intentionally non-enumerating 401 should fall
      // through to the account's normal Supabase password sign-in.
      if (![401, 404].includes(error.response?.status)) throw error;
    }
    let email = identity;
    if (!identity.includes("@")) {
      const { data, error } = await crmSupabase.rpc("resolve_login_email", { identity });
      if (error) throw apiError(error.message || "Unable to look up that employee ID.");
      email = data || "";
    }
    if (!email) throw apiError("That username or employee ID is not registered.");
    const { data, error } = await crmSupabase.auth.signInWithPassword({ email, password: credentials.password });
    if (error) throw apiError(error.message || "Invalid username or password.", 401);
    const user = await currentCrmUser();
    if (!user) throw apiError("This account is inactive or has no CRM profile.", 403);
    return { data: { user, csrfToken: "" } };
  },
  requestPasswordReset: async (identity) => {
    const normalizedIdentity = String(identity || "").trim();
    if (!normalizedIdentity) throw apiError("Enter your employee ID.");
    const { data, error } = await crmSupabase.functions.invoke("password-reset", {
      body: { identity: normalizedIdentity },
    });
    if (error) throw apiError("We couldn't send a reset link right now. Please try again shortly.");
    return { data: data || { ok: true } };
  },
  logout: async () => {
    if ("serviceWorker" in navigator) {
      await clearReminderDevice({
        serviceWorker: navigator.serviceWorker, workerUrl: reminderWorkerUrl(import.meta.env.BASE_URL),
        removeSubscription: (endpoint) => apiClient.delete("/push/subscriptions/", { data: { endpoint } }),
      }).catch(() => {});
    }
    const { error } = await crmSupabase.auth.signOut();
    clearAttendanceReadCache();
    clearCrmProfileCache();
    if (error) throw error;
    currentUserCache = null;
    currentUserRequest = null;
    return { data: { ok: true } };
  },
};

function maskImportValue(value) {
  if (value === null || value === undefined || value === "") return "";
  let text = String(value).replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, (_match, local, domain) => {
    const masked = local.length <= 2 ? "*".repeat(local.length) : `${local[0]}***${local.at(-1)}`;
    return `${masked}@${domain}`;
  });
  const digits = (text.match(/\d/g) || []).length;
  if (digits >= 7) {
    let seen = 0;
    text = text.split("").reverse().map((character) => {
      if (!/\d/.test(character)) return character;
      seen += 1;
      return seen <= 2 ? character : "X";
    }).reverse().join("");
  }
  return text;
}

export const overtimeApi = {
  list: () => cachedGet("/overtime/"),
  create: (payload, csrfToken) => apiClient.post("/overtime/", payload, csrfHeaders(csrfToken)),
  review: (requestId, action, payload, csrfToken) => apiClient.post(`/overtime/${requestId}/${action}/`, payload, csrfHeaders(csrfToken)),
};

export const attendanceApi = {
  list: (params = {}) => cachedGet("/attendance/", { params }, 15_000),
  leaves: (params = {}) => cachedGet("/attendance/leaves/", { params }, 15_000),
  createLeave: (payload, csrfToken) => apiClient.post("/attendance/leaves/", payload, csrfHeaders(csrfToken)),
  removeLeave: (leaveId, csrfToken) => apiClient.delete("/attendance/leaves/" + leaveId + "/", csrfHeaders(csrfToken)),
  manualEmployees: (date) => cachedGet("/attendance/manual/employees/", { params: { date } }, 5_000),
  manualRecords: (date) => cachedGet("/attendance/manual/records/", { params: { date } }, 5_000),
  createManual: async (payload) => {
    const response = await apiClient.post("/attendance/manual/", payload);
    invalidateApiCache("/attendance/manual/");
    return response;
  },
};

export const dashboardApi = {
  summary: () => cachedGet("/dashboard/"),
};

export const datasetsApi = {
  list: () => cachedGet("/datasets/"),
  detail: (datasetId, params = {}) => cachedGet(`/datasets/${datasetId}/`, { params }),
  rename: (datasetId, name, csrfToken) => (
    apiClient.patch(`/datasets/${datasetId}/manage/`, { name }, csrfHeaders(csrfToken))
  ),
  remove: (datasetId, csrfToken) => (
    apiClient.delete(`/datasets/${datasetId}/manage/`, csrfHeaders(csrfToken))
  ),
  export: async (datasetId, params = {}) => {
    const { data } = await apiClient.get(`/datasets/${datasetId}/export/`, { params });
    const XLSX = await loadXlsx();
    const workbook = XLSX.utils.book_new();
    const usedNames = new Set();
    for (const sheet of data.sheets || []) {
      let name = String(sheet.name || "Customers").replace(/[\\/?*:[\]]/g, " ").slice(0, 31) || "Customers";
      let candidate = name;
      let suffix = 2;
      while (usedNames.has(candidate.toLowerCase())) {
        const suffixText = ` ${suffix++}`;
        candidate = `${name.slice(0, 31 - suffixText.length)}${suffixText}`;
      }
      usedNames.add(candidate.toLowerCase());
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sheet.headers || [], ...(sheet.rows || [])]), candidate);
    }
    if (!workbook.SheetNames.length) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["No records"]]), "Customers");
    const filename = String(data.filename || "customers").replace(/[\\/:*?"<>|]/g, "_").trim() || "customers";
    XLSX.writeFile(workbook, `${filename}.xlsx`);
    return { data };
  },
};

apiClient.interceptors.response.use(
  (response) => {
    requestDiagnostics.push({
      method: String(response.config.method || "get").toUpperCase(),
      url: response.config.url,
      status: response.status,
      durationMs: Math.round(performance.now() - (response.config.crmStartedAt || performance.now())),
    });
    if (requestDiagnostics.length > 100) requestDiagnostics.splice(0, requestDiagnostics.length - 100);
    if (String(response.config.method || "get").toLowerCase() !== "get") invalidateForMutation(response.config.url);
    return response;
  },
  async (error) => {
    if (error.config) {
      requestDiagnostics.push({
        method: String(error.config.method || "get").toUpperCase(),
        url: error.config.url,
        status: error.response?.status || 0,
        durationMs: Math.round(performance.now() - (error.config.crmStartedAt || performance.now())),
      });
      if (requestDiagnostics.length > 100) requestDiagnostics.splice(0, requestDiagnostics.length - 100);
    }
    if (error.code === "ECONNABORTED" || /timeout/i.test(String(error.message || ""))) {
      error.response ??= { status: 408, data: { detail: "The CRM request took too long. Please retry." } };
    } else if (!error.response) {
      error.response = { status: 0, data: { detail: "The CRM service is unreachable. Check your connection and retry." } };
    }
    if (error.response?.status === 401 && typeof window !== "undefined") {
      // Do not delay every failed API request on a secondary sign-out call.
      void crmSupabase.auth.signOut().catch(() => {});
      window.dispatchEvent(new Event("crm:session-expired"));
    }
    return Promise.reject(error);
  }
);

export const customersApi = {
  // People commonly move between the status tabs. Keep each recently viewed
  // customer result available long enough for those revisits to be instant;
  // customer edits still naturally refresh after this short window.
  list: (params = {}) => cachedGet("/customers/", { params }, 120_000),
  detail: (datasetId, recordId) => cachedGet(`/datasets/${datasetId}/customers/${recordId}/`),
  detailById: (recordId) => cachedGet(`/customers/${recordId}/`),
  history: (datasetId, recordId, cursor) => cachedGet(`/datasets/${datasetId}/customers/${recordId}/history/`, { params: { before_time: cursor.time, before_id: cursor.id } }),
  update: (datasetId, recordId, data, csrfToken) => (
    apiClient.patch(`/datasets/${datasetId}/customers/${recordId}/`, data, csrfHeaders(csrfToken))
  ),
  remove: (datasetId, recordId, csrfToken) => (
    apiClient.delete(`/datasets/${datasetId}/customers/${recordId}/`, csrfHeaders(csrfToken))
  ),
};

export const callbacksApi = {
  list: (params = {}) => cachedGet("/callbacks/", { params: { preset: "today", date: "", sort: "asc", ...params } }),
  complete: (recordId, response, csrfToken, expectedRevision) => (
    apiClient.post(`/callbacks/${recordId}/complete/`, { response, expected_revision: expectedRevision }, csrfHeaders(csrfToken))
  ),
};

export const importApi = {
  inspect: async (formData) => {
    const file = formData.get("excel_file");
    const datasetName = String(formData.get("dataset_name") || "").trim();
    if (!datasetName || datasetName.length > 255) throw apiError("Enter a dataset name up to 255 characters.");
    if (!(file instanceof File) || !file.size) throw apiError("Choose an .xlsx workbook to inspect.");
    if (!file.name.toLowerCase().endsWith(".xlsx")) throw apiError("Upload an .xlsx workbook.");
    if (file.size > 20 * 1024 * 1024) throw apiError("The workbook must be 20 MB or smaller.");
    let workbook;
    const fileBytes = await file.arrayBuffer();
    let XLSX;
    try {
      XLSX = await loadXlsx();
      workbook = XLSX.read(fileBytes, { type: "array", cellDates: true });
    } catch {
      throw apiError("The uploaded file is not a readable .xlsx workbook.");
    }
    let prepared;
    try { prepared = prepareWorkbook(XLSX, workbook); }
    catch (error) { throw apiError(error.message); }
    const sheets = prepared.sheets.map((sheet) => ({ ...sheet,
      preview_headers: sheet.column_names,
      preview_rows: sheet.records.slice(0, 5).map((row) => sheet.field_keys.map((key) => maskImportValue(row.original_data[key]))),
    }));
    const digest = await crypto.subtle.digest("SHA-256", fileBytes);
    const fingerprint = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const token = crypto.randomUUID();
    const filename = file.name.split(/[\\/]/).pop();
    const inspection = { filename, sheet_names: sheets.map((sheet) => sheet.name), sheets, warnings: prepared.warnings };
    pendingImports.set(token, { datasetName, filename, fingerprint, sheets: prepared.sheets, storeId: activeStoreId() });
    return { data: { datasetName, pendingImportToken: token, inspection: { ...inspection, sheets: sheets.map(({ records, ...sheet }) => sheet) } } };
  },
  confirm: async (pendingImportToken) => {
    const pending = pendingImports.get(pendingImportToken);
    if (!pending) throw apiError("The inspected workbook has expired. Please upload it again.");
    if (pending.storeId !== activeStoreId()) throw apiError("The selected store has changed. Inspect this workbook again in the correct store.");
    const storeConfig = { crmStoreId: pending.storeId };
    // A lost commit response is safe: retrying returns the same dataset. Keep
    // the inspected token on failure so the user can retry without data loss.
    const response = await uploadStagedImport(pending, (path, body) => apiClient.post(path, body, { ...storeConfig, timeout: 120000 }));
    pendingImports.delete(pendingImportToken);
    return response;
  },
};

export const remindersApi = {
  list: () => cachedGet("/reminders/"),
  create: (payload, csrfToken) => apiClient.post("/reminders/", payload, csrfHeaders(csrfToken)),
  update: (reminderId, payload, csrfToken) => apiClient.patch(`/reminders/${reminderId}/`, payload, csrfHeaders(csrfToken)),
  remove: (reminderId, csrfToken) => apiClient.delete(`/reminders/${reminderId}/`, csrfHeaders(csrfToken)),
  pushConfig: () => apiClient.get("/push/config/"),
  pushStatus: () => apiClient.get("/push/subscriptions/"),
  subscribePush: (subscription, csrfToken) => apiClient.post("/push/subscriptions/", subscription, csrfHeaders(csrfToken)),
  removePush: (endpoint, csrfToken) => apiClient.delete("/push/subscriptions/", { ...csrfHeaders(csrfToken), data: { endpoint } }),
};

export const tasksApi = {
  list: ({ fresh = false } = {}) => cachedGet("/tasks/", {}, fresh ? 0 : GET_CACHE_TTL),
  update: (taskId, payload, csrfToken) => apiClient.patch(`/tasks/${taskId}/`, payload, payload instanceof FormData ? multipartHeaders() : csrfHeaders(csrfToken)),
};

export const taskNotificationsApi = {
  list: () => cachedGet("/task-notifications/", {}, 0),
  markRead: (id) => apiClient.patch(`/task-notifications/${id}/`, {}),
  markAllRead: (throughId) => apiClient.post("/task-notifications/read/", { through_id: throughId }),
};

export const targetsApi = {
  list: () => cachedGet("/targets/"),
};

export const salesApi = {
  list: (params = {}) => cachedGet("/sales/visits/", { params: salesRequestParams(params) }),
  report: () => cachedGet("/sales/report/"),
  summary: () => cachedGet("/sales/summary/"),
  clients: (datasetId, query = "", page = 1, selected = "") => cachedGet("/sales/clients/", { params: { dataset: datasetId, q: query, page, selected: selected || undefined } }),
  detail: (visitId) => cachedGet(`/sales/visits/${visitId}/`),
  create: (payload, csrfToken) => apiClient.post(
    "/sales/visits/",
    payload,
    payload instanceof FormData ? multipartHeaders(csrfToken) : csrfHeaders(csrfToken)
  ),
  update: (visitId, payload, csrfToken) => apiClient.patch(
    `/sales/visits/${visitId}/`,
    payload,
    payload instanceof FormData ? multipartHeaders(csrfToken) : csrfHeaders(csrfToken)
  ),
  remove: (visitId, csrfToken) => apiClient.delete(`/sales/visits/${visitId}/`, csrfHeaders(csrfToken)),
};

export const adminApi = {
  // Admin reads are user-scoped and mutations invalidate them immediately.
  // A short freshness window prevents a full reload on every back-navigation.
  summary: () => cachedGet("/admin/summary/", {}, 30_000),
  listUsers: (storeId = "", role = "") => cachedGet("/admin/users/", (storeId || role) ? { params: { ...(storeId ? { store: storeId } : {}), ...(role ? { role } : {}) } } : {}),
  stores: ({ fresh = false } = {}) => cachedGet("/admin/stores/", {}, fresh ? 0 : 30_000),
  createStore: (payload, csrfToken) => apiClient.post("/admin/stores/", payload, csrfHeaders(csrfToken)),
  updateStoreFeatures: (storeId, features, limits, csrfToken) => apiClient.patch(`/admin/stores/${storeId}/features/`, { features, ...limits }, csrfHeaders(csrfToken)),
  designations: (storeId = "") => cachedGet("/admin/designations/", storeId ? { params: { store: storeId } } : {}),
  createDesignation: (name, storeId, csrfToken) => apiClient.post("/admin/designations/", { name }, { ...csrfHeaders(csrfToken), params: storeId ? { store: storeId } : {} }),
  createUser: (payload, csrfToken) => apiClient.post("/admin/users/", payload, csrfHeaders(csrfToken)),
  detail: (userId) => cachedGet(`/admin/users/${userId}/`),
  update: (userId, payload, csrfToken) => apiClient.patch(`/admin/users/${userId}/`, payload, csrfHeaders(csrfToken)),
  action: (userId, action, payload, csrfToken) => apiClient.post(`/admin/users/${userId}/${action}/`, payload, csrfHeaders(csrfToken)),
  datasets: (userId) => cachedGet(`/admin/users/${userId}/datasets/`),
  tasks: (params = {}, { fresh = false } = {}) => cachedGet("/admin/tasks/", { params }, fresh ? 0 : GET_CACHE_TTL),
  salesPerformance: (month = "") => cachedGet("/admin/sales-performance/", month ? { params: { month } } : {}, 30_000),
  userPerformance: (month = "") => cachedGet("/admin/user-performance/", month ? { params: { month } } : {}, 30_000),
  createTask: (payload, csrfToken) => apiClient.post("/admin/tasks/", payload, payload instanceof FormData ? multipartHeaders() : csrfHeaders(csrfToken)),
  updateTask: (taskId, payload, csrfToken) => apiClient.patch(`/admin/tasks/${taskId}/`, payload, payload instanceof FormData ? multipartHeaders() : csrfHeaders(csrfToken)),
  targets: (params = {}) => cachedGet("/admin/targets/", { params }, 30_000),
  saveTarget: (payload, csrfToken) =>
    apiClient.post(
      "/admin/targets/",
      payload,
      csrfHeaders(csrfToken)
    ),

  updateTarget: (targetId, payload, csrfToken) =>
    apiClient.patch(
      `/admin/targets/${targetId}/`,
      payload,
      csrfHeaders(csrfToken)
    ),
};

export const storeFeaturesApi = {
  get: ({ fresh = false } = {}) => cachedGet("/store/features/", {}, fresh ? 0 : 30_000).catch((error) => {
    if (error.response?.status === 404) return { data: { features: {}, legacy: true } };
    throw error;
  }),
};

export const payrollApi = {
  list: () => cachedGet("/payroll/payments/", {}, 0),
  employees: () => cachedGet("/payroll/employees/", {}, 0),
  settings: () => cachedGet("/payroll/settings/", {}, 0),
  updateSettings: (payload, csrfToken) => apiClient.patch("/payroll/settings/", payload, csrfHeaders(csrfToken)),
  salaryStructures: () => cachedGet("/payroll/salary-structures/", {}, 0),
  createSalaryStructure: (payload, csrfToken) => apiClient.post("/payroll/salary-structures/", payload, csrfHeaders(csrfToken)),
  expensePreview: (employeeId, payrollMonth) => cachedGet("/payroll/expense-preview/", { params: { employee_id: employeeId, month: payrollMonth } }, 0),
  expenses: () => cachedGet("/payroll/expenses/", {}, 0),
  createExpense: (payload, csrfToken) => apiClient.post("/payroll/expenses/", payload, csrfHeaders(csrfToken)),
  reviewExpense: (id, payload, csrfToken) => apiClient.post(`/payroll/expenses/${id}/review/`, payload, csrfHeaders(csrfToken)),
  advances: () => cachedGet("/payroll/advances/", {}, 0),
  createAdvance: (payload, csrfToken) => apiClient.post("/payroll/advances/", payload, csrfHeaders(csrfToken)),
  reviewAdvance: (id, payload, csrfToken) => apiClient.post(`/payroll/advances/${id}/review/`, payload, csrfHeaders(csrfToken)),
  calculate: (payload, csrfToken) => apiClient.post("/payroll/calculate/", payload, csrfHeaders(csrfToken)),
  create: (payload, csrfToken) => apiClient.post("/payroll/payments/", payload, csrfHeaders(csrfToken)),
  update: (paymentId, payload, csrfToken) => apiClient.patch(`/payroll/payments/${paymentId}/`, payload, csrfHeaders(csrfToken)),
  approve: (paymentId, payload = {}, csrfToken) => {
    const token = typeof payload === "string" ? payload : csrfToken;
    return apiClient.post(`/payroll/payments/${paymentId}/approve/`, typeof payload === "string" ? {} : payload, csrfHeaders(token));
  },
  reject: (paymentId, payload, csrfToken) => apiClient.post(`/payroll/payments/${paymentId}/reject/`, payload, csrfHeaders(csrfToken)),
  payslip: (paymentId) => cachedGet(`/payroll/payments/${paymentId}/payslip/`, {}, 0),
  reports: (month = "") => cachedGet("/payroll/reports/", month ? { params: { month } } : {}, 0),
};

export const reportsApi = {
  summary: () => cachedGet("/reports/summary/").catch((error) => {
    if (error.response?.status === 404) return dashboardApi.summary();
    throw error;
  }),
};

// Warm normal sidebar destinations after the first screen has painted. These
// requests share the same cache as the pages, so the next navigation renders
// from already-available data rather than showing another loading panel.
export async function warmNavigationData(isAdmin = false, { signal } = {}) {
  const requestFactories = [
    () => dashboardApi.summary(),
    () => targetsApi.list(),
    () => datasetsApi.list(),
    () => customersApi.list({ page: 1 }),
    () => salesApi.list(),
    () => salesApi.summary(),
    () => callbacksApi.list({ preset: "today", date: "", sort: "asc" }),
    () => remindersApi.list(),
    () => tasksApi.list(),
  ];
  if (isAdmin) requestFactories.push(
    () => adminApi.summary(),
    () => adminApi.listUsers(),
    () => adminApi.targets(),
    () => adminApi.tasks(),
  );

  // Keep background traffic bounded without letting one slow endpoint hold
  // up every remaining sidebar destination. Shared GETs are deduplicated.
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < requestFactories.length && !signal?.aborted) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await requestFactories[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all([worker(), worker()]);
  return results;
}
