import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Offcanvas } from "bootstrap";
import { useAuth } from "../hooks/useAuth.jsx";
import { useAttendanceAuth } from "../hooks/useAttendanceAuth.jsx";
import { useTaskNotifications } from "../hooks/useTaskNotifications.js";
import TaskNotificationAlerts from "../components/TaskNotificationAlerts.jsx";
import { callbacksApi, warmNavigationData } from "../services/api.js";
import { prefetchNavigation } from "../services/navigationPrefetch.js";
import { RouteLoadingIndicator } from "../components/RequestState.jsx";
import { activeStoreId, clearSelectedStore } from "../services/storeContext.js";

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
    to: "/attendance",
    label: "Attendance",
    icon: "bi-calendar-check",
    children: [
      { to: "/attendance/overview", label: "Overview", icon: "bi-speedometer2" },
      { to: "/attendance/overtime", label: "OT Approvals", icon: "bi-clock-history" },
      { to: "/attendance/employees", label: "Employees", icon: "bi-people" },
    ],
  },
  {
    to: "/attendance/timesheet",
    label: "My Timesheet",
    icon: "bi-clock-history",
    children: [
      { to: "/attendance/approvals", label: "Approvals", icon: "bi-check2-square" },
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
  const navigate = useNavigate();
  const { profile: attendanceProfile, isLoading: attendanceAuthLoading } = useAttendanceAuth();
  const location = useLocation();
  const { unreadCount: notificationCount } = useTaskNotifications();
  const [todayCallbackCount, setTodayCallbackCount] = useState(0);
  const initial = user?.username?.charAt(0)?.toUpperCase() || "U";
  const roleLabel = user?.is_admin ? "Admin" : "User";
  const isDashboard = location.pathname === "/dashboard" || location.pathname === "/";
  const selectedSuperAdminStore = Boolean(user?.is_superuser && activeStoreId());

  useEffect(() => {
    const controller = new AbortController();
    const warmTimer = window.setTimeout(() => {
      warmNavigationData(Boolean(user?.is_admin), { signal: controller.signal });
    }, 2500);
    return () => {
      window.clearTimeout(warmTimer);
      controller.abort();
    };
  }, [user?.id, user?.is_admin]);

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

    const firstLoadTimer = window.setTimeout(loadTodayCallbacks, 1600);
    const intervalId = window.setInterval(loadTodayCallbacks, 30000);
    window.addEventListener("crm:callbacks-updated", loadTodayCallbacks);
    window.addEventListener("focus", loadTodayCallbacks);

    return () => {
      isMounted = false;
      window.clearTimeout(firstLoadTimer);
      window.clearInterval(intervalId);
      window.removeEventListener("crm:callbacks-updated", loadTodayCallbacks);
      window.removeEventListener("focus", loadTodayCallbacks);
    };
  }, []);

  return (
    <>
      <TaskNotificationAlerts />
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
        <NavLink className="app-brand" to="/dashboard">
          <span className="brand-mark">V</span>
          <span className="brand-copy"><strong>VESTANO</strong><small>Customer CRM</small></span>
        </NavLink>
        <div className="sidebar-menu-scroll">
          <Navigation user={user} attendanceProfile={attendanceProfile} attendanceAuthLoading={attendanceAuthLoading} notificationCount={notificationCount} todayCallbackCount={todayCallbackCount} />
        </div>
        <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} />
      </aside>

      <div className="offcanvas offcanvas-start" tabIndex="-1" id="mobileNav" aria-labelledby="mobileNavLabel">
        <div className="offcanvas-header">
          <h2 className="h5 offcanvas-title" id="mobileNavLabel">VESTANO CRM</h2>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
        </div>
        <div className="offcanvas-body d-flex flex-column">
          <div className="sidebar-menu-scroll">
            <Navigation user={user} mobile attendanceProfile={attendanceProfile} attendanceAuthLoading={attendanceAuthLoading} notificationCount={notificationCount} todayCallbackCount={todayCallbackCount} />
          </div>
          <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} mobile />
        </div>
      </div>

      <main className={`app-main ${isDashboard ? "is-dashboard" : ""} ${location.pathname.startsWith("/admin-panel") ? "is-admin" : ""}`}>
        <div className="workspace-topbar">
          <div className="workspace-breadcrumb">
            <span className="workspace-brand-label">VESTANO / CRM</span>
            <i className="bi bi-chevron-right" aria-hidden="true" />
            <span>Customer operations</span>
          </div>
          <div className="workspace-account">
            {selectedSuperAdminStore && <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => { clearSelectedStore(); navigate("/admin-panel/stores"); }}>
              <i className="bi bi-arrow-left" /> Back to stores
            </button>}
            <span>{roleLabel} workspace</span>
            <span className="workspace-avatar" aria-hidden="true">{initial}</span>
          </div>
        </div>
        <div className="content-wrap">
          <Suspense fallback={<RouteLoadingIndicator />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </>
  );
}

function Navigation({ user, mobile = false, attendanceProfile, attendanceAuthLoading, notificationCount = 0, todayCallbackCount = 0 }) {
  const navigate = useNavigate();
  const location = useLocation();
  const customerRouteActive = location.pathname.startsWith("/datasets") || location.pathname.startsWith("/customers");
  const timesheetSectionOpen = ["/attendance/timesheet", "/attendance/approvals"].includes(location.pathname);
  const attendanceSectionOpen = location.pathname.startsWith("/attendance") && !timesheetSectionOpen;
  // Keep the sidebar in one explicit state.  Separate booleans allowed two
  // sections to remain highlighted after switching between their headers.
  const routeMenu = customerRouteActive ? "customers" : attendanceSectionOpen ? "attendance" : timesheetSectionOpen ? "timesheet" : null;
  const [openMenu, setOpenMenu] = useState(routeMenu);

  useEffect(() => {
    setOpenMenu(routeMenu);
  }, [routeMenu]);

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

  const toggleMenu = (menu) => {
    setOpenMenu((current) => current === menu ? null : menu);
  };

  if (user?.is_superuser && !activeStoreId()) {
    return <nav className="sidebar-nav" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      <SidebarNavLink user={user} className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} to="/admin-panel/stores" onClick={(event) => handleNavigation(event, "/admin-panel/stores")}>
        <i className="bi bi-shop" /><span>Stores</span>
      </SidebarNavLink>
    </nav>;
  }

  return (
    <nav className="sidebar-nav" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      {navItems.map((item) => {
        if (item.children) {
          const submenuId = mobile ? "mobile-customer-submenu" : "desktop-customer-submenu";
          const isAttendanceMenu = item.label === "Attendance";
          const isTimesheetMenu = item.label === "My Timesheet";
          if (isAttendanceMenu && !attendanceProfile && !attendanceAuthLoading) {
            return (
              <SidebarNavLink
                user={user}
                className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
                key={item.label}
                to="/attendance"
                end
                onClick={(event) => handleNavigation(event, "/attendance")}
              >
                <i className={`bi ${item.icon}`} />
                <span>Attendance</span>
              </SidebarNavLink>
            );
          }
          const menuName = isAttendanceMenu ? "attendance" : isTimesheetMenu ? "timesheet" : "customers";
          const menuOpen = openMenu === menuName;
          const menuActive = menuOpen;
          const resolvedSubmenuId = isAttendanceMenu
            ? (mobile ? "mobile-attendance-submenu" : "desktop-attendance-submenu")
            : isTimesheetMenu ? (mobile ? "mobile-timesheet-submenu" : "desktop-timesheet-submenu") : submenuId;
          return (
            <div className="sidebar-menu-group" key={item.label}>
              {item.to ? <div className="sidebar-attendance-row position-relative">
                <SidebarNavLink
                  user={user}
                  to={item.to}
                  className={() => `sidebar-link sidebar-menu-toggle pe-5 ${menuActive ? "active" : ""}`}
                  end
                  onClick={(event) => {
                    setOpenMenu(menuName);
                    handleNavigation(event, item.to);
                  }}
                >
                  <i className={`bi ${item.icon}`} />
                  <span>{item.label}</span>
                </SidebarNavLink>
                <button
                  className="sidebar-attendance-toggle"
                  type="button"
                  aria-label={`Toggle ${item.label} menu`}
                  aria-expanded={menuOpen}
                  aria-controls={resolvedSubmenuId}
                  onClick={() => toggleMenu(isAttendanceMenu ? "attendance" : isTimesheetMenu ? "timesheet" : "customers")}
                >
                  <i className={`bi bi-chevron-${menuOpen ? "up" : "down"} sidebar-menu-chevron`} aria-hidden="true" />
                </button>
              </div> : <button
                className={`sidebar-link sidebar-menu-toggle ${menuActive ? "active" : ""}`}
                type="button"
                aria-expanded={menuOpen}
                aria-controls={resolvedSubmenuId}
                onClick={() => toggleMenu("customers")}
              >
                <i className={`bi ${item.icon}`} />
                <span>{item.label}</span>
                <i className={`bi bi-chevron-${menuOpen ? "up" : "down"} ms-auto sidebar-menu-chevron`} aria-hidden="true" />
              </button>}
              {menuOpen && (
                <div className="sidebar-submenu" id={resolvedSubmenuId}>
                  {item.children.map((child) => (
                    <SidebarNavLink
                      user={user}
                      className={({ isActive }) => `sidebar-link sidebar-sublink ${isActive ? "active" : ""}`}
                      key={child.to}
                      to={child.to}
                      end
                      onClick={(event) => handleNavigation(event, child.to)}
                    >
                      <i className={`bi ${child.icon}`} />
                      <span>{child.label}</span>
                    </SidebarNavLink>
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
          <SidebarNavLink
            user={user}
            key={item.to}
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""} ${
              (item.to === "/notifications" && notificationCount > 0) ||
              (item.to === "/callbacks" && todayCallbackCount > 0)
                ? "has-alert"
                : ""
            }`}
            to={item.to}
            onClick={(event) => handleNavigation(event, item.to)}
          >
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
            {item.to === "/notifications" && notificationCount > 0 && (
              <span className="sidebar-alert-badge ms-auto" aria-label={`${notificationCount} unread task notifications`}>{notificationCount}</span>
            )}
            {item.to === "/callbacks" && todayCallbackCount > 0 && (
              <span className="sidebar-alert-badge ms-auto" aria-label={`${todayCallbackCount} callbacks today`}>
                {todayCallbackCount}
              </span>
            )}
          </SidebarNavLink>
        );
      })}
      {user?.is_admin && !user?.is_superuser && (
        <SidebarNavLink
          user={user}
          className={() => `sidebar-link ${location.pathname === "/admin-panel" ? "active" : ""}`}
          to="/admin-panel"
          end
          onClick={(event) => handleNavigation(event, "/admin-panel")}
        >
          <i className="bi bi-shield-lock" />
          <span>Admin Panel</span>
        </SidebarNavLink>
      )}
      {user?.is_superuser && (
        <SidebarNavLink
          user={user}
          className={() => `sidebar-link ${location.pathname === "/admin-panel/stores" ? "active" : ""}`}
          to="/admin-panel/stores"
          end
          onClick={(event) => handleNavigation(event, "/admin-panel/stores")}
        >
          <i className="bi bi-shop" />
          <span>Stores</span>
        </SidebarNavLink>
      )}
    </nav>
  );
}

function SidebarNavLink({ user, to, ...props }) {
  const timer = useRef(null);
  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = null;
  };
  const preload = () => {
    cancel();
    void prefetchNavigation(to, user);
  };
  const schedule = () => {
    cancel();
    timer.current = window.setTimeout(preload, 100);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return <NavLink {...props} to={to} onPointerEnter={schedule} onPointerLeave={cancel} onFocus={schedule} onBlur={cancel} onPointerDown={preload} />;
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
