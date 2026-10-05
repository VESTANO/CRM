import axios from "axios";

export const apiClient = axios.create({
  baseURL: "/api",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

const csrfHeaders = (csrfToken) => ({
  headers: {
    "X-CSRFToken": csrfToken,
  },
});

const multipartHeaders = (csrfToken) => ({
  headers: {
    "X-CSRFToken": csrfToken,
    "Content-Type": "multipart/form-data",
  },
});

export const authApi = {
  session: () => apiClient.get("/auth/session/"),
  login: (credentials, csrfToken) => apiClient.post("/auth/login/", credentials, csrfHeaders(csrfToken)),
  logout: (csrfToken) => apiClient.post("/auth/logout/", {}, csrfHeaders(csrfToken)),
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
  exportUrl: (datasetId, params = {}) => {
    const query = new URLSearchParams(params);
    const queryString = query.toString();
    return `/api/datasets/${datasetId}/export/${queryString ? `?${queryString}` : ""}`;
  },
};

let sessionCheckPromise = null;
apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const requestUrl = error.config?.url || "";
    if (
      [401, 403].includes(error.response?.status) &&
      !requestUrl.includes("/auth/session/") &&
      !requestUrl.includes("/auth/login/") &&
      !requestUrl.includes("/auth/logout/")
    ) {
      if (!sessionCheckPromise) {
        sessionCheckPromise = apiClient.get("/auth/session/")
          .then(({ data }) => {
            if (!data.isAuthenticated) window.dispatchEvent(new Event("crm:session-expired"));
          })
          .catch(() => window.dispatchEvent(new Event("crm:session-expired")))
          .finally(() => { sessionCheckPromise = null; });
      }
      await sessionCheckPromise;
    }
    return Promise.reject(error);
  }
);

export const customersApi = {
  detail: (datasetId, recordId) => apiClient.get(`/datasets/${datasetId}/customers/${recordId}/`),
  detailById: (recordId) => apiClient.get(`/customers/${recordId}/`),
  update: (datasetId, recordId, data, csrfToken) => (
    apiClient.patch(`/datasets/${datasetId}/customers/${recordId}/`, data, csrfHeaders(csrfToken))
  ),
  remove: (datasetId, recordId, csrfToken) => (
    apiClient.delete(`/datasets/${datasetId}/customers/${recordId}/`, csrfHeaders(csrfToken))
  ),
};

export const importApi = {
  inspect: (formData, csrfToken) => apiClient.post("/import/inspect/", formData, multipartHeaders(csrfToken)),
  confirm: (pendingImportToken, csrfToken) => (
    apiClient.post("/import/confirm/", { pendingImportToken }, csrfHeaders(csrfToken))
  ),
};

export const remindersApi = {
  list: () => apiClient.get("/notifications/"),
  create: (payload, csrfToken) => apiClient.post("/notifications/", payload, csrfHeaders(csrfToken)),
  update: (reminderId, payload, csrfToken) => apiClient.patch(`/notifications/${reminderId}/`, payload, csrfHeaders(csrfToken)),
  remove: (reminderId, csrfToken) => apiClient.delete(`/notifications/${reminderId}/`, csrfHeaders(csrfToken)),
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
