export const defaultStoreFeatures = Object.freeze({
  customers: true,
  sales: true,
  attendance: true,
  callbacks: true,
  reminders: true,
  reports: true,
  tasks: true,
});

export const storeFeatureOptions = [
  { key: "customers", label: "Customers and Excel import" },
  { key: "sales", label: "Sales visits and targets" },
  { key: "attendance", label: "Attendance, timesheets and overtime" },
  { key: "callbacks", label: "Callbacks" },
  { key: "reminders", label: "Reminders" },
  { key: "reports", label: "Reports" },
  { key: "tasks", label: "Tasks and notifications" },
];

export function featureForPath(path) {
  if (/^\/(datasets|customers|import)(\/|$)/.test(path)) return "customers";
  if (/^\/sales(\/|$)/.test(path)) return "sales";
  if (/^\/(attendance|overtime)(\/|$)/.test(path)) return "attendance";
  if (/^\/callbacks(\/|$)/.test(path)) return "callbacks";
  if (/^\/reminders(\/|$)/.test(path)) return "reminders";
  if (/^\/reports(\/|$)/.test(path)) return "reports";
  if (/^\/notifications(\/|$)/.test(path) || /^\/admin-panel\/tasks(\/|$)/.test(path)) return "tasks";
  if (/^\/admin-panel\/users\/[^/]+\/datasets(\/|$)/.test(path)) return "customers";
  if (/^\/admin-panel\/users\/[^/]+\/tasks(\/|$)/.test(path)) return "tasks";
  return null;
}
