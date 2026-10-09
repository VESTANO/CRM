import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Offcanvas } from "bootstrap";
import { useAuth } from "../hooks/useAuth.jsx";
import { tasksApi } from "../services/api.js";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: "bi-grid-1x2" },
  { to: "/datasets", label: "Customer Lists", icon: "bi-people" },
  { to: "/sales", label: "Sales", icon: "bi-briefcase" },
  { to: "/import", label: "Import Excel", icon: "bi-cloud-arrow-up" },
  { to: "/reminders", label: "Reminders", icon: "bi-alarm" },
  { to: "/notifications", label: "Notifications", icon: "bi-bell" },
  { to: "/reports", label: "Reports", icon: "bi-bar-chart-line" },
  { to: "/bill-print", label: "Bill Print", icon: "bi-printer" },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const [pendingTaskCount, setPendingTaskCount] = useState(0);
  const initial = user?.username?.charAt(0)?.toUpperCase() || "U";
  const roleLabel = user?.is_admin ? "Admin" : "User";

  useEffect(() => {
    let isMounted = true;

    const loadPendingTasks = () => {
      tasksApi.list()
        .then(({ data }) => {
          if (!isMounted) return;
          setPendingTaskCount(data.results.filter((task) => task.status === "pending").length);
        })
        .catch(() => {
          if (isMounted) setPendingTaskCount(0);
        });
    };

    loadPendingTasks();
    const intervalId = window.setInterval(loadPendingTasks, 30000);
    window.addEventListener("crm:tasks-updated", loadPendingTasks);
    window.addEventListener("focus", loadPendingTasks);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener("crm:tasks-updated", loadPendingTasks);
      window.removeEventListener("focus", loadPendingTasks);
    };
  }, []);

  return (
    <>
      <header className="mobile-topbar d-lg-none">
        <button
          className="btn btn-outline-secondary btn-sm"
          type="button"
          data-bs-toggle="offcanvas"
          data-bs-target="#mobileNav"
          aria-controls="mobileNav"
        >
          Menu
        </button>
        <NavLink className="mobile-brand" to="/dashboard">Customer CRM</NavLink>
      </header>

      <aside className="app-sidebar d-none d-lg-flex">
        <div>
          <NavLink className="app-brand" to="/dashboard">
            <span className="brand-mark">C</span>
            <span>Customer CRM</span>
          </NavLink>
          <Navigation user={user} pendingTaskCount={pendingTaskCount} />
        </div>
        <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} />
      </aside>

      <div className="offcanvas offcanvas-start" tabIndex="-1" id="mobileNav" aria-labelledby="mobileNavLabel">
        <div className="offcanvas-header">
          <h2 className="h5 offcanvas-title" id="mobileNavLabel">Customer CRM</h2>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
        </div>
        <div className="offcanvas-body d-flex flex-column">
          <Navigation user={user} mobile pendingTaskCount={pendingTaskCount} />
          <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} mobile />
        </div>
      </div>

      <main className="app-main">
        <div className="content-wrap">
          <Outlet />
        </div>
      </main>
    </>
  );
}

function Navigation({ user, mobile = false, pendingTaskCount = 0 }) {
  const navigate = useNavigate();

  const handleNavigation = (event, path) => {
    if (!mobile) return;

    event.preventDefault();
    const menu = document.getElementById("mobileNav");
    menu.addEventListener("hidden.bs.offcanvas", () => {
      document.querySelectorAll(".offcanvas-backdrop").forEach((backdrop) => backdrop.remove());
      document.body.classList.remove("modal-open");
      navigate(path);
    }, { once: true });
    Offcanvas.getOrCreateInstance(menu).hide();
  };

  return (
    <nav className="sidebar-nav" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      {navItems.map((item) => (
        item.disabled ? (
          <span className="sidebar-link" aria-disabled="true" key={item.label}>
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
          </span>
        ) : (
          <NavLink
            key={item.to}
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""} ${item.to === "/notifications" && pendingTaskCount > 0 ? "has-alert" : ""}`}
            to={item.to}
            onClick={(event) => handleNavigation(event, item.to)}
          >
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
            {item.to === "/notifications" && pendingTaskCount > 0 && (
              <span className="sidebar-alert-badge ms-auto">{pendingTaskCount}</span>
            )}
          </NavLink>
        )
      ))}
      {user?.is_admin && (
        <NavLink
          className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
          to="/admin-panel"
          onClick={(event) => handleNavigation(event, "/admin-panel")}
        >
          <i className="bi bi-shield-lock" />
          <span>Admin Panel</span>
        </NavLink>
      )}
    </nav>
  );
}

function UserPanel({ user, initial, roleLabel, logout, mobile = false }) {
  return (
    <div className={`sidebar-user ${mobile ? "mt-auto" : ""}`}>
      <div className="text-secondary small">Signed in as</div>
      <div className="d-flex align-items-center gap-2 mt-1">
        <span className="user-avatar">{initial}</span>
        <div className="min-w-0">
          <div className="fw-semibold text-truncate">{user?.username}</div>
          <div className="text-secondary small">{roleLabel}</div>
        </div>
      </div>
      <button className="btn btn-outline-secondary btn-sm mt-3 w-100" type="button" onClick={logout}>
        <i className="bi bi-box-arrow-right me-1" />
        Logout
      </button>
    </div>
  );
}
