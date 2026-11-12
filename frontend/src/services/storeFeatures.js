export const defaultStoreFeatures = Object.freeze({
  dashboard: true,
  customers: true,
  sales: true,
  attendance: true,
  manual_attendance: true,
  callbacks: true,
  reminders: true,
  reports: true,
  tasks: true,
  task_images: true,
});

export const storeFeatureOptions = [
  { key: "dashboard", label: "Dashboard" },
  { key: "customers", label: "Customers and Excel import" },
  { key: "sales", label: "Sales visits and targets" },
  { key: "attendance", label: "Attendance, timesheets and overtime" },
  { key: "manual_attendance", label: "Manual attendance" },
  { key: "callbacks", label: "Callbacks" },
  { key: "reminders", label: "Reminders" },
  { key: "reports", label: "Reports" },
  { key: "tasks", label: "Tasks and notifications" },
  { key: "task_images", label: "Task image uploads" },
];

export function featureForPath(path) {
  if (path === "/" || /^\/dashboard(\/|$)/.test(path)) return "dashboard";
  if (/^\/(datasets|customers|import)(\/|$)/.test(path)) return "customers";
  if (/^\/sales(\/|$)/.test(path)) return "sales";
  if (/^\/attendance\/manual(\/|$)/.test(path)) return "manual_attendance";
  if (/^\/(attendance|overtime)(\/|$)/.test(path)) return "attendance";
  if (/^\/callbacks(\/|$)/.test(path)) return "callbacks";
  if (/^\/reminders(\/|$)/.test(path)) return "reminders";
  if (/^\/reports(\/|$)/.test(path)) return "reports";
  if (/^\/notifications(\/|$)/.test(path) || /^\/admin-panel\/tasks(\/|$)/.test(path)) return "tasks";
  if (/^\/admin-panel\/users\/[^/]+\/datasets(\/|$)/.test(path)) return "customers";
  if (/^\/admin-panel\/users\/[^/]+\/tasks(\/|$)/.test(path)) return "tasks";
  return null;
}

export function storeHomePath(features) {
  return [["dashboard", "/dashboard"], ["customers", "/customers"], ["sales", "/sales"], ["attendance", "/attendance"], ["callbacks", "/callbacks"], ["reminders", "/reminders"], ["reports", "/reports"], ["tasks", "/notifications"]].find(([key]) => features[key])?.[1] || "/store-home";
}
