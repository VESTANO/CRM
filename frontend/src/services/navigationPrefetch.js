import { adminApi, callbacksApi, customersApi, dashboardApi, datasetsApi, remindersApi, salesApi, tasksApi } from "./api.js";
import { activeStoreId } from "./storeContext.js";

const attendancePage = () => import("../pages/Attendance.jsx");
const routes = {
  "/dashboard": { page: () => import("../pages/Dashboard.jsx"), reads: () => [dashboardApi.summary] },
  "/datasets": { page: () => import("../pages/DatasetList.jsx"), reads: () => [datasetsApi.list] },
  "/customers": { page: () => import("../pages/Customers.jsx"), reads: () => [() => customersApi.list({ page: 1 })] },
  "/sales": { page: () => import("../pages/Sales.jsx"), reads: () => [salesApi.list, salesApi.summary] },
  "/callbacks": { page: () => import("../pages/Callbacks.jsx"), reads: () => [callbacksApi.list] },
  "/import": { page: () => import("../pages/ImportExcel.jsx") },
  "/reminders": { page: () => import("../pages/Reminders.jsx"), reads: () => [remindersApi.list] },
  "/notifications": { page: () => import("../pages/Notifications.jsx"), reads: (user) => [user.is_admin ? adminApi.tasks : tasksApi.list] },
  "/reports": { page: () => import("../pages/Reports.jsx"), reads: () => [dashboardApi.summary, salesApi.report] },
  "/admin-panel": { admin: true, page: () => import("../pages/AdminPanel.jsx"), reads: () => [adminApi.summary] },
  "/admin-panel/users": { admin: true, page: () => import("../pages/AdminUsers.jsx"), reads: () => [adminApi.listUsers] },
  "/admin-panel/tasks": { admin: true, page: () => import("../pages/AdminTasks.jsx"), reads: () => [adminApi.tasks] },
};
const pending = new Map();

export function prefetchNavigation(path, user) {
  if (!user?.id) return Promise.resolve([]);
  const route = routes[path] || (path.startsWith("/attendance") ? { page: attendancePage } : null);
  if (!route || (route.admin && !user.is_admin)) return Promise.resolve([]);

  const key = `${user.id}|${activeStoreId()}|${path}`;
  if (pending.has(key)) return pending.get(key);
  const work = [route.page, ...(route.reads?.(user) || [])];
  const request = Promise.allSettled(work.map((read) => Promise.resolve().then(read)));
  pending.set(key, request);
  request.then(() => {
    if (pending.get(key) === request) pending.delete(key);
  });
  return request;
}
