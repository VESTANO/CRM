import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Offcanvas } from "bootstrap";
import { useAuth } from "../hooks/useAuth.jsx";
import { useAttendanceAuth } from "../hooks/useAttendanceAuth.jsx";
import { callbacksApi, tasksApi } from "../services/api.js";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: "bi-grid-1x2" },
  {
    label: "Customer Lists",
    icon: "bi-people",
    children: [
      { to: "/datasets", label: "Datasets", icon: "bi-folder2-open" },
      { to: "/customers", label: "Customers", icon: "bi-person-lines-fill" },
    ],
  },
  { to: "/sales", label: "Sales", icon: "bi-briefcase" },
  {
    label: "Attendance",
    icon: "bi-calendar-check",
    children: [
      { to: "/attendance/overview", label: "Overview", icon: "bi-speedometer2" },
      { to: "/attendance/timesheet", label: "My Timesheet", icon: "bi-clock-history" },
      { to: "/attendance/profile", label: "My Profile", icon: "bi-person-circle" },
      { to: "/attendance", label: "Attendance", icon: "bi-calendar-check" },
      { to: "/attendance/approvals", label: "Approvals", icon: "bi-check2-square" },
      { to: "/attendance/overtime", label: "OT Approvals", icon: "bi-clock-history" },
      { to: "/attendance/employees", label: "Employees", icon: "bi-people" },
    ],
  },
  { to: "/callbacks", label: "Callbacks", icon: "bi-telephone-forward" },
  { to: "/import", label: "Import Excel", icon: "bi-cloud-arrow-up" },
  { to: "/reminders", label: "Reminders", icon: "bi-alarm" },
  { to: "/notifications", label: "Notifications", icon: "bi-bell" },
  { to: "/reports", label: "Reports", icon: "bi-bar-chart-line" },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const { profile: attendanceProfile, isLoading: attendanceAuthLoading } = useAttendanceAuth();
  const location = useLocation();
  const [pendingTaskCount, setPendingTaskCount] = useState(0);
  const [todayCallbackCount, setTodayCallbackCount] = useState(0);
  const initial = user?.username?.charAt(0)?.toUpperCase() || "U";
  const roleLabel = user?.is_admin ? "Admin" : "User";
  const isDashboard = location.pathname === "/dashboard" || location.pathname === "/";

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

  useEffect(() => {
    let isMounted = true;

    const loadTodayCallbacks = () => {
      callbacksApi.list({ preset: "today" })
        .then(({ data }) => {
          if (isMounted) setTodayCallbackCount(data.counts?.today || 0);
        })
        .catch(() => {
          if (isMounted) setTodayCallbackCount(0);
        });
    };

    loadTodayCallbacks();
    const intervalId = window.setInterval(loadTodayCallbacks, 30000);
    window.addEventListener("crm:callbacks-updated", loadTodayCallbacks);
    window.addEventListener("focus", loadTodayCallbacks);

    return () => {
      isMounted = false;
      window.clearInterval(intervalId);
      window.removeEventListener("crm:callbacks-updated", loadTodayCallbacks);
      window.removeEventListener("focus", loadTodayCallbacks);
    };
  }, []);

  return (
    <>
      <header className="mobile-topbar d-lg-none">
        <button
          className="mobile-menu-button"
          type="button"
          data-bs-toggle="offcanvas"
          data-bs-target="#mobileNav"
          aria-controls="mobileNav"
          aria-label="Open navigation menu"
        >
          <i className="bi bi-list" aria-hidden="true" />
        </button>
        <NavLink className="mobile-brand" to="/dashboard">
          <span className="brand-mark">V</span>
          <span className="brand-copy"><strong>VESTANO</strong><small>Customer CRM</small></span>
        </NavLink>
      </header>

      <aside className="app-sidebar d-none d-lg-flex">
        <div>
          <NavLink className="app-brand" to="/dashboard">
            <span className="brand-mark">V</span>
            <span className="brand-copy"><strong>VESTANO</strong><small>Customer CRM</small></span>
          </NavLink>
          <Navigation user={user} attendanceProfile={attendanceProfile} attendanceAuthLoading={attendanceAuthLoading} pendingTaskCount={pendingTaskCount} todayCallbackCount={todayCallbackCount} />
        </div>
        <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} />
      </aside>

      <div className="offcanvas offcanvas-start" tabIndex="-1" id="mobileNav" aria-labelledby="mobileNavLabel">
        <div className="offcanvas-header">
          <h2 className="h5 offcanvas-title" id="mobileNavLabel">VESTANO CRM</h2>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
        </div>
        <div className="offcanvas-body d-flex flex-column">
          <Navigation user={user} mobile attendanceProfile={attendanceProfile} attendanceAuthLoading={attendanceAuthLoading} pendingTaskCount={pendingTaskCount} todayCallbackCount={todayCallbackCount} />
          <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} mobile />
        </div>
      </div>

      <main className={`app-main ${isDashboard ? "is-dashboard" : ""}`}>
        <div className="workspace-topbar">
          <div className="workspace-breadcrumb">
            <span className="workspace-brand-label">VESTANO / CRM</span>
            <i className="bi bi-chevron-right" aria-hidden="true" />
            <span>Customer operations</span>
          </div>
          <div className="workspace-account">
            <span>{roleLabel} workspace</span>
            <span className="workspace-avatar" aria-hidden="true">{initial}</span>
          </div>
        </div>
        <div className="content-wrap">
          <Outlet />
        </div>
      </main>
    </>
  );
}

function Navigation({ user, mobile = false, attendanceProfile, attendanceAuthLoading, pendingTaskCount = 0, todayCallbackCount = 0 }) {
  const navigate = useNavigate();
  const location = useLocation();
  const customerRouteActive = location.pathname.startsWith("/datasets") || location.pathname.startsWith("/customers");
  const attendanceRouteActive = location.pathname.startsWith("/attendance");
  const attendanceRole = String(attendanceProfile?.role || "").trim().toLowerCase();
  const attendanceAdmin = ["admin", "super_admin"].includes(attendanceRole);
  const [customersOpen, setCustomersOpen] = useState(customerRouteActive);
  const [attendanceOpen, setAttendanceOpen] = useState(attendanceRouteActive);

  useEffect(() => {
    setCustomersOpen(customerRouteActive);
  }, [customerRouteActive]);

  useEffect(() => {
    setAttendanceOpen(attendanceRouteActive);
  }, [attendanceRouteActive]);

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
      {navItems.map((item) => {
        if (item.children) {
          const submenuId = mobile ? "mobile-customer-submenu" : "desktop-customer-submenu";
          const isAttendanceMenu = item.label === "Attendance";
          if (isAttendanceMenu && !attendanceProfile && !attendanceAuthLoading) {
            return (
              <NavLink
                className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
                key={item.label}
                to="/attendance/overview"
                onClick={(event) => handleNavigation(event, "/attendance/overview")}
              >
                <i className={`bi ${item.icon}`} />
                <span>Attendance</span>
              </NavLink>
            );
          }
          const menuOpen = isAttendanceMenu ? attendanceOpen : customersOpen;
          const setMenuOpen = isAttendanceMenu ? setAttendanceOpen : setCustomersOpen;
          const menuActive = isAttendanceMenu ? attendanceRouteActive : customerRouteActive;
          const resolvedSubmenuId = isAttendanceMenu
            ? (mobile ? "mobile-attendance-submenu" : "desktop-attendance-submenu")
            : submenuId;
          return (
            <div className="sidebar-menu-group" key={item.label}>
              <button
                className={`sidebar-link sidebar-menu-toggle ${menuActive ? "active" : ""}`}
                type="button"
                aria-expanded={menuOpen}
                aria-controls={resolvedSubmenuId}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <i className={`bi ${item.icon}`} />
                <span>{item.label}</span>
                <i className={`bi bi-chevron-${menuOpen ? "up" : "down"} ms-auto sidebar-menu-chevron`} aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className="sidebar-submenu" id={resolvedSubmenuId}>
                  {item.children.filter((child) => !isAttendanceMenu || child.to !== "/attendance/approvals" || attendanceAdmin).map((child) => (
                    <NavLink
                      className={({ isActive }) => `sidebar-link sidebar-sublink ${isActive ? "active" : ""}`}
                      key={child.to}
                      to={child.to}
                      end
                      onClick={(event) => handleNavigation(event, child.to)}
                    >
                      <i className={`bi ${child.icon}`} />
                      <span>{child.label}</span>
                    </NavLink>
                  ))}
                </div>
              )}
            </div>
          );
        }

        return item.disabled ? (
          <span className="sidebar-link" aria-disabled="true" key={item.label}>
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
          </span>
        ) : (
          <NavLink
            key={item.to}
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""} ${
              (item.to === "/notifications" && pendingTaskCount > 0) ||
              (item.to === "/callbacks" && todayCallbackCount > 0)
                ? "has-alert"
                : ""
            }`}
            to={item.to}
            onClick={(event) => handleNavigation(event, item.to)}
          >
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
            {item.to === "/notifications" && pendingTaskCount > 0 && (
              <span className="sidebar-alert-badge ms-auto">{pendingTaskCount}</span>
            )}
            {item.to === "/callbacks" && todayCallbackCount > 0 && (
              <span className="sidebar-alert-badge ms-auto" aria-label={`${todayCallbackCount} callbacks today`}>
                {todayCallbackCount}
              </span>
            )}
          </NavLink>
        );
      })}
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
      <div className="sidebar-user-label">Signed in as</div>
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
