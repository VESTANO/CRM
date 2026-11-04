import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import AppLayout from "./layouts/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import AdminRoute from "./components/AdminRoute.jsx";
import { AuthProvider } from "./hooks/useAuth.jsx";
import { AttendanceAuthProvider } from "./hooks/useAttendanceAuth.jsx";
import { AppBootLoader } from "./components/RequestState.jsx";
import ConnectionGuard from "./components/ConnectionGuard.jsx";
import PasswordRecoveryGate from "./components/PasswordRecoveryGate.jsx";
import StatusPage, { ServerErrorPage } from "./pages/StatusPage.jsx";

// Route-level chunks make the initial CRM shell fast; each screen is fetched
// only when it is opened instead of making every page block the first render.
const Dashboard = lazy(() => import("./pages/Dashboard.jsx"));
const CustomerDelete = lazy(() => import("./pages/CustomerDelete.jsx"));
const CustomerDetail = lazy(() => import("./pages/CustomerDetail.jsx"));
const CustomerEdit = lazy(() => import("./pages/CustomerEdit.jsx"));
const Customers = lazy(() => import("./pages/Customers.jsx"));
const Callbacks = lazy(() => import("./pages/Callbacks.jsx"));
const DatasetDetail = lazy(() => import("./pages/DatasetDetail.jsx"));
const DatasetList = lazy(() => import("./pages/DatasetList.jsx"));
const DatasetManagement = lazy(() => import("./pages/DatasetManagement.jsx"));
const ImportExcel = lazy(() => import("./pages/ImportExcel.jsx"));
const Notifications = lazy(() => import("./pages/Notifications.jsx"));
const Reminders = lazy(() => import("./pages/Reminders.jsx"));
const Reports = lazy(() => import("./pages/Reports.jsx"));
const Attendance = lazy(() => import("./pages/Attendance.jsx"));
const Login = lazy(() => import("./pages/Login.jsx"));
const Sales = lazy(() => import("./pages/Sales.jsx"));
const Overtime = lazy(() => import("./pages/Overtime.jsx"));
const VisitForm = lazy(() => import("./pages/VisitForm.jsx"));
const VisitDetail = lazy(() => import("./pages/VisitDetail.jsx"));
const VisitDelete = lazy(() => import("./pages/VisitDelete.jsx"));
const AdminPanel = lazy(() => import("./pages/AdminPanel.jsx"));
const AdminUsers = lazy(() => import("./pages/AdminUsers.jsx"));
const AdminTasks = lazy(() => import("./pages/AdminTasks.jsx"));
const AdminUserDetail = lazy(() => import("./pages/AdminUserDetail.jsx"));
const AdminUserForm = lazy(() => import("./pages/AdminUserForm.jsx"));
const AdminUserPassword = lazy(() => import("./pages/AdminUserPassword.jsx"));
const AdminUserDatasets = lazy(() => import("./pages/AdminUserDatasets.jsx"));

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.MODE === "pages" || import.meta.env.VITE_PAGES_BUILD === "true" ? "/CRM" : "/"}>
      <ConnectionGuard>
      <AuthProvider>
        <Suspense fallback={<AppBootLoader label="Opening CRM page" />}>
        <PasswordRecoveryGate>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/offline" element={<StatusPage kind="offline" />} />
          <Route path="/500" element={<ServerErrorPage />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <AttendanceAuthProvider>
                  <AppLayout />
                </AttendanceAuthProvider>
              </ProtectedRoute>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="datasets" element={<DatasetList />} />
            <Route path="datasets/:id" element={<DatasetDetail />} />
            <Route path="datasets/:id/rename" element={<DatasetManagement mode="rename" />} />
            <Route path="datasets/:id/delete" element={<DatasetManagement mode="delete" />} />
            <Route path="datasets/:datasetId/customers/:recordId" element={<CustomerDetail />} />
            <Route path="datasets/:datasetId/customers/:recordId/edit" element={<CustomerEdit />} />
            <Route path="datasets/:datasetId/customers/:recordId/delete" element={<CustomerDelete />} />
            <Route path="customers" element={<Customers />} />
            <Route path="customers/:id" element={<CustomerDetail />} />
            <Route path="callbacks" element={<Callbacks />} />
            <Route path="import" element={<ImportExcel />} />
            <Route path="reminders" element={<Reminders />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="reports" element={<Reports />} />
            <Route path="attendance" element={<Attendance view="attendance" />} />
            <Route path="attendance/overview" element={<Attendance view="overview" />} />
            <Route path="attendance/timesheet" element={<Attendance view="timesheet" />} />
            <Route path="attendance/profile" element={<Attendance view="profile" />} />
            <Route path="attendance/approvals" element={<Attendance view="approvals" />} />
            <Route path="attendance/overtime" element={<Attendance view="overtime" />} />
            <Route path="attendance/employees" element={<Attendance view="employees" />} />
            <Route path="sales" element={<Sales />} />
            <Route path="overtime" element={<Overtime />} />
            <Route path="sales/visits/add" element={<VisitForm />} />
            <Route path="sales/visits/:visitId" element={<VisitDetail />} />
            <Route path="sales/visits/:visitId/edit" element={<VisitForm />} />
            <Route path="sales/visits/:visitId/delete" element={<VisitDelete />} />
            <Route path="admin-panel" element={<AdminRoute><AdminPanel /></AdminRoute>} />
            <Route path="admin-panel/users" element={<AdminRoute><AdminUsers /></AdminRoute>} />
            <Route path="admin-panel/tasks" element={<AdminRoute><AdminTasks /></AdminRoute>} />
            <Route path="admin-panel/users/add" element={<AdminRoute><AdminUserForm /></AdminRoute>} />
            <Route path="admin-panel/users/:userId" element={<AdminRoute><AdminUserDetail /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/edit" element={<AdminRoute><AdminUserForm /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/password" element={<AdminRoute><AdminUserPassword /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/datasets" element={<AdminRoute><AdminUserDatasets /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/tasks" element={<AdminRoute><AdminTasks /></AdminRoute>} />
          </Route>
          <Route path="*" element={<StatusPage />} />
        </Routes>
        </PasswordRecoveryGate>
        </Suspense>
      </AuthProvider>
      </ConnectionGuard>
    </BrowserRouter>
  );
}
