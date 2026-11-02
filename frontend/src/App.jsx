import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AppLayout from "./layouts/AppLayout.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import AdminRoute from "./components/AdminRoute.jsx";
import { AuthProvider } from "./hooks/useAuth.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import CustomerDelete from "./pages/CustomerDelete.jsx";
import CustomerDetail from "./pages/CustomerDetail.jsx";
import CustomerEdit from "./pages/CustomerEdit.jsx";
import Customers from "./pages/Customers.jsx";
import Callbacks from "./pages/Callbacks.jsx";
import DatasetDetail from "./pages/DatasetDetail.jsx";
import DatasetList from "./pages/DatasetList.jsx";
import DatasetManagement from "./pages/DatasetManagement.jsx";
import ImportExcel from "./pages/ImportExcel.jsx";
import Notifications from "./pages/Notifications.jsx";
import Reminders from "./pages/Reminders.jsx";
import Reports from "./pages/Reports.jsx";
import Attendance from "./pages/Attendance.jsx";
import Login from "./pages/Login.jsx";
import Sales from "./pages/Sales.jsx";
import Overtime from "./pages/Overtime.jsx";
import VisitForm from "./pages/VisitForm.jsx";
import VisitDetail from "./pages/VisitDetail.jsx";
import VisitDelete from "./pages/VisitDelete.jsx";
import AdminPanel from "./pages/AdminPanel.jsx";
import AdminTasks from "./pages/AdminTasks.jsx";
import AdminUserDetail from "./pages/AdminUserDetail.jsx";
import AdminUserForm from "./pages/AdminUserForm.jsx";
import AdminUserPassword from "./pages/AdminUserPassword.jsx";
import AdminUserDatasets from "./pages/AdminUserDatasets.jsx";
import { AttendanceAuthProvider } from "./hooks/useAttendanceAuth.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
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
            <Route path="admin-panel/tasks" element={<AdminRoute><AdminTasks /></AdminRoute>} />
            <Route path="admin-panel/users/add" element={<AdminRoute><AdminUserForm /></AdminRoute>} />
            <Route path="admin-panel/users/:userId" element={<AdminRoute><AdminUserDetail /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/edit" element={<AdminRoute><AdminUserForm /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/password" element={<AdminRoute><AdminUserPassword /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/datasets" element={<AdminRoute><AdminUserDatasets /></AdminRoute>} />
            <Route path="admin-panel/users/:userId/tasks" element={<AdminRoute><AdminTasks /></AdminRoute>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
