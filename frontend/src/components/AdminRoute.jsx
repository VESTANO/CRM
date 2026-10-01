import { Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";

export default function AdminRoute({ children }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="crm-loading">Loading CRM...</div>;
  if (!user?.is_admin) return <Navigate to="/dashboard" replace />;
  return children;
}
