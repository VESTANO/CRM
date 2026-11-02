import axios from "axios";
import * as XLSX from "xlsx";
import { crmSupabase, CRM_SUPABASE_PUBLISHABLE_KEY, CRM_SUPABASE_URL } from "./crmSupabase.js";

const crmApiUrl = `${CRM_SUPABASE_URL}/functions/v1/crm-api/api`;
const pendingImports = new Map();

export const apiClient = axios.create({
  baseURL: crmApiUrl,
  withCredentials: false,
  headers: {
    apikey: CRM_SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  },
});

const csrfHeaders = () => ({});

const multipartHeaders = () => ({
  headers: {
    "Content-Type": undefined,
  },
});

apiClient.interceptors.request.use(async (config) => {
  config.headers.set("apikey", CRM_SUPABASE_PUBLISHABLE_KEY);
  const { data, error } = await crmSupabase.auth.getSession();
  if (error) throw error;
  if (data.session?.access_token) config.headers.set("Authorization", `Bearer ${data.session.access_token}`);
  else config.headers.delete("Authorization");
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
  const { data: profile, error } = await crmSupabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) throw error;
  if (!profile?.active) {
    await crmSupabase.auth.signOut();
    return null;
  }
  const isAdmin = ["admin", "super_admin"].includes(String(profile.role || "").toLowerCase());
  return {
    id: profile.id,
    username: profile.employee_id || profile.email || "user",
    email: profile.email || "",
    name: profile.name || profile.employee_id || "",
    is_staff: isAdmin,
    is_superuser: profile.role === "super_admin",
    is_admin: isAdmin,
    is_active: Boolean(profile.active),
    date_joined: profile.created_at,
  };
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
      if (error.response?.status !== 404) throw error;
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
  logout: async () => {
    const { error } = await crmSupabase.auth.signOut();
    if (error) throw error;
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
  list: () => apiClient.get("/overtime/"),
  create: (payload, csrfToken) => apiClient.post("/overtime/", payload, csrfHeaders(csrfToken)),
  review: (requestId, action, payload, csrfToken) => apiClient.post(`/overtime/${requestId}/${action}/`, payload, csrfHeaders(csrfToken)),
};

export const dashboardApi = {
  summary: () => apiClient.get("/dashboard/"),
};

export const datasetsApi = {
  list: () => apiClient.get("/datasets/"),
  detail: (datasetId, params = {}) => apiClient.get(`/datasets/${datasetId}/`, { params }),
  rename: (datasetId, name, csrfToken) => (
    apiClient.patch(`/datasets/${datasetId}/manage/`, { name }, csrfHeaders(csrfToken))
  ),
  remove: (datasetId, csrfToken) => (
    apiClient.delete(`/datasets/${datasetId}/manage/`, csrfHeaders(csrfToken))
  ),
  export: async (datasetId, params = {}) => {
    const { data } = await apiClient.get(`/datasets/${datasetId}/export/`, { params });
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
  (response) => response,
  async (error) => {
    if (error.response?.status === 401 && typeof window !== "undefined") {
      await crmSupabase.auth.signOut();
      window.dispatchEvent(new Event("crm:session-expired"));
    }
    return Promise.reject(error);
  }
);

export const customersApi = {
  list: (params = {}) => apiClient.get("/customers/", { params }),
  detail: (datasetId, recordId) => apiClient.get(`/datasets/${datasetId}/customers/${recordId}/`),
  detailById: (recordId) => apiClient.get(`/customers/${recordId}/`),
  update: (datasetId, recordId, data, csrfToken) => (
    apiClient.patch(`/datasets/${datasetId}/customers/${recordId}/`, data, csrfHeaders(csrfToken))
  ),
  remove: (datasetId, recordId, csrfToken) => (
    apiClient.delete(`/datasets/${datasetId}/customers/${recordId}/`, csrfHeaders(csrfToken))
  ),
};

export const callbacksApi = {
  list: (params = {}) => apiClient.get("/callbacks/", { params }),
  complete: (recordId, response, csrfToken) => (
    apiClient.post(`/callbacks/${recordId}/complete/`, { response }, csrfHeaders(csrfToken))
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
    try {
      workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    } catch {
      throw apiError("The uploaded file is not a readable .xlsx workbook.");
    }
    const sheets = workbook.SheetNames.map((name) => {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false });
      const rawHeaders = rows[0] || [];
      const columnNames = rawHeaders.map((value, index) => value == null || String(value).trim() === "" ? `Unnamed column ${index + 1}` : String(value).trim());
      const seen = new Map();
      const fieldKeys = columnNames.map((value, index) => {
        const base = value.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_") || `column_${index + 1}`;
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base}_${count}`;
      });
      const dataRows = rows.slice(1).map((row) => row.map((value) => value instanceof Date ? value.toISOString() : value));
      return {
        name,
        rows: dataRows.length,
        columns: columnNames.length,
        column_names: columnNames,
        field_keys: fieldKeys,
        data_rows: dataRows,
        preview_headers: columnNames,
        preview_rows: dataRows.slice(0, 5).map((row) => row.map(maskImportValue)),
      };
    });
    if (!sheets.length || sheets.every((sheet) => !sheet.column_names.length)) throw apiError("No workbook headers were found.");
    const token = crypto.randomUUID();
    const inspection = { filename: file.name.split(/[\\/]/).pop(), sheet_names: workbook.SheetNames, sheets };
    pendingImports.set(token, { datasetName, inspection });
    return { data: { datasetName, pendingImportToken: token, inspection: { ...inspection, sheets: sheets.map(({ data_rows, ...sheet }) => sheet) } } };
  },
  confirm: async (pendingImportToken) => {
    const pending = pendingImports.get(pendingImportToken);
    if (!pending) throw apiError("The inspected workbook has expired. Please upload it again.");
    const sheetMetadata = pending.inspection.sheets.map(({ data_rows, ...sheet }) => sheet);
    let createdDatasetId;
    try {
      const { data: created } = await apiClient.post("/import/confirm/", {
        datasetName: pending.datasetName,
        inspection: { filename: pending.inspection.filename, sheets: sheetMetadata },
      });
      const dataset = created.dataset;
      createdDatasetId = dataset.id;
      let imported = 0;
      let skipped = 0;
      for (const sheet of pending.inspection.sheets) {
        const rows = [];
        sheet.data_rows.forEach((values, index) => {
          if (!values.some((value) => value !== "" && value != null)) { skipped += 1; return; }
          const original_data = {};
          sheet.field_keys.forEach((key, columnIndex) => { if (columnIndex < values.length) original_data[key] = values[columnIndex]; });
          rows.push({ sheet_name: sheet.name, row_number: index + 2, original_data });
        });
        for (let offset = 0; offset < rows.length; offset += 250) {
          const chunk = rows.slice(offset, offset + 250);
          await apiClient.post(`/import/datasets/${dataset.id}/batch/`, { rows: chunk });
          imported += chunk.length;
        }
      }
      pendingImports.delete(pendingImportToken);
      return { data: { dataset, summary: { rows_found: pending.inspection.sheets.reduce((sum, sheet) => sum + sheet.data_rows.length, 0), rows_imported: imported, rows_skipped: skipped } } };
    } catch (error) {
      if (createdDatasetId) await apiClient.delete(`/import/datasets/${createdDatasetId}/`).catch(() => {});
      throw error;
    }
  },
};

export const remindersApi = {
  list: () => apiClient.get("/reminders/"),
  create: (payload, csrfToken) => apiClient.post("/reminders/", payload, csrfHeaders(csrfToken)),
  update: (reminderId, payload, csrfToken) => apiClient.patch(`/reminders/${reminderId}/`, payload, csrfHeaders(csrfToken)),
  remove: (reminderId, csrfToken) => apiClient.delete(`/reminders/${reminderId}/`, csrfHeaders(csrfToken)),
  pushConfig: () => apiClient.get("/push/config/"),
  pushStatus: () => apiClient.get("/push/subscriptions/"),
  subscribePush: (subscription, csrfToken) => apiClient.post("/push/subscriptions/", subscription, csrfHeaders(csrfToken)),
  removePush: (endpoint, csrfToken) => apiClient.delete("/push/subscriptions/", { ...csrfHeaders(csrfToken), data: { endpoint } }),
};

export const tasksApi = {
  list: () => apiClient.get("/tasks/"),
  update: (taskId, payload, csrfToken) => apiClient.patch(`/tasks/${taskId}/`, payload, csrfHeaders(csrfToken)),
};

export const targetsApi = {
  list: () => apiClient.get("/targets/"),
};

export const salesApi = {
  list: (params = {}) => apiClient.get("/sales/visits/", { params }),
  summary: () => apiClient.get("/sales/summary/"),
  clients: (datasetId, query = "") => apiClient.get("/sales/clients/", { params: { dataset: datasetId, q: query } }),
  detail: (visitId) => apiClient.get(`/sales/visits/${visitId}/`),
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
  summary: () => apiClient.get("/admin/summary/"),
  listUsers: () => apiClient.get("/admin/users/"),
  createUser: (payload, csrfToken) => apiClient.post("/admin/users/", payload, csrfHeaders(csrfToken)),
  detail: (userId) => apiClient.get(`/admin/users/${userId}/`),
  update: (userId, payload, csrfToken) => apiClient.patch(`/admin/users/${userId}/`, payload, csrfHeaders(csrfToken)),
  action: (userId, action, payload, csrfToken) => apiClient.post(`/admin/users/${userId}/${action}/`, payload, csrfHeaders(csrfToken)),
  datasets: (userId) => apiClient.get(`/admin/users/${userId}/datasets/`),
  tasks: (params = {}) => apiClient.get("/admin/tasks/", { params }),
  createTask: (payload, csrfToken) => apiClient.post("/admin/tasks/", payload, csrfHeaders(csrfToken)),
  updateTask: (taskId, payload, csrfToken) => apiClient.patch(`/admin/tasks/${taskId}/`, payload, csrfHeaders(csrfToken)),
  targets: (params = {}) => apiClient.get("/admin/targets/", { params }),
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
