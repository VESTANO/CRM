import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth.jsx";

export default function AdminRoute({ children }) {
  const { user, isLoading, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [switchingAccount, setSwitchingAccount] = useState(false);

  useEffect(() => {
    if (isLoading || !user || user.is_admin || switchingAccount) return;
    setSwitchingAccount(true);
    logout()
      .then(() => {
        navigate("/login", { replace: true, state: { from: location } });
      })
      .catch(() => setSwitchingAccount(false));
  }, [isLoading, user, switchingAccount, logout, navigate, location]);

  if (isLoading) return <div className="crm-loading">Loading CRM...</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!user.is_admin) return <div className="crm-loading">Switching to admin sign-in...</div>;
  return children;
}
