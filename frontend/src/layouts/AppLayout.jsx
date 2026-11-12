import { Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { Offcanvas } from "bootstrap";
import { useAuth } from "../hooks/useAuth.jsx";
import { useAttendanceAuth } from "../hooks/useAttendanceAuth.jsx";
import { useTaskNotifications } from "../hooks/useTaskNotifications.js";
import TaskNotificationAlerts from "../components/TaskNotificationAlerts.jsx";
import { adminApi, callbacksApi } from "../services/api.js";
import { prefetchNavigation } from "../services/navigationPrefetch.js";
import { RouteLoadingIndicator } from "../components/RequestState.jsx";
import { activeStoreId, clearSelectedStore } from "../services/storeContext.js";
import { useStoreContext } from "../hooks/useStoreContext.js";
import { lockDocumentScroll, recoverOrphanedScrollLock } from "../utils/documentScrollLock.js";

import { useStoreFeatures } from "../hooks/useStoreFeatures.jsx";
import { featureForPath, storeHomePath } from "../services/storeFeatures.js";

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
  { label: "Payroll", icon: "bi-cash-stack", payroll: true },
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
    to: "/attendance/manual",
    label: "Manual Attendance",
    icon: "bi-pencil-square",
    adminOnly: true,
    children: [
      { to: "/attendance/manual/records", label: "Employee Attendance", icon: "bi-table" },
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

const payrollIconPaths = {
  overview: <><path d="M4 14a8 8 0 0 1 16 0" /><path d="m12 14 4-5" /><path d="M6.5 10 5 8.5M17.5 10 19 8.5M12 6V4" /></>,
  salaries: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3.5 20c.5-4 2.5-6 5.5-6s5 2 5.5 6M14 15c3.5-.5 5.8 1.2 6.5 4" /></>,
  process: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 18h2M14 18h2" /></>,
  expenses: <><path d="M6 3h12v18H6z" /><path d="M9 7h6M9 11h6M9 15h3" /><path d="m14 17 1.5 1.5L19 15" /></>,
  payslips: <><path d="M6 2h9l3 3v17H6z" /><path d="M15 2v4h4M9 11h6M9 15h6M9 19h4" /></>,
  payments: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M7 15h4" /></>,
  settings: <><path d="M4 6h7M15 6h5M4 12h3M11 12h9M4 18h9M17 18h3" /><circle cx="13" cy="6" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="15" cy="18" r="2" /></>,
};

function PayrollNavIcon({ name }) {
  return <svg className="sidebar-nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{payrollIconPaths[name]}</svg>;
}

function useCurrentStoreName(user, selectedStoreId) {
  const currentStoreId = user?.is_superuser ? selectedStoreId : user?.store_id;
  const [storeName, setStoreName] = useState("");

  useEffect(() => {
    let active = true;
    if (!user?.is_admin || !currentStoreId) {
      setStoreName("");
      return () => { active = false; };
    }
    adminApi.stores()
      .then(({ data }) => {
        if (!active) return;
        const store = (data.results || []).find((item) => item.id === currentStoreId);
        setStoreName(store?.name || "");
      })
      .catch(() => { if (active) setStoreName(""); });
    return () => { active = false; };
  }, [currentStoreId, user?.id, user?.is_admin]);

  return storeName;
}

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { profile: attendanceProfile, isLoading: attendanceAuthLoading } = useAttendanceAuth();
  const { features, loading: featuresLoading, error: featuresError } = useStoreFeatures();
  const location = useLocation();
  const navigationType = useNavigationType();
  const previousPath = useRef(null);
  const storeId = useStoreContext();
  const { unreadCount: notificationCount } = useTaskNotifications(features.tasks && !featuresLoading && !featuresError);
  const [todayCallbackCount, setTodayCallbackCount] = useState(0);
  const initial = user?.username?.charAt(0)?.toUpperCase() || "U";
  const roleLabel = user?.is_superuser ? "Super Admin" : user?.is_admin ? "Admin" : "User";
  const isDashboard = location.pathname === "/dashboard" || location.pathname === "/";
  const selectedSuperAdminStore = Boolean(user?.is_superuser && activeStoreId());
  const currentStoreName = useCurrentStoreName(user, storeId);

  useLayoutEffect(() => {
    // A new page begins at its heading. Native POP restoration owns Back /
    // Forward; same-page search/filter changes keep the user's position.
    if (navigationType !== "POP" && previousPath.current !== location.pathname) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
    previousPath.current = location.pathname;
  }, [location.key, location.pathname, navigationType]);

  useEffect(() => {
    const menu = document.getElementById("mobileNav");
    let releaseScroll;
    const lock = () => { releaseScroll ||= lockDocumentScroll(); };
    const unlock = () => { releaseScroll?.(); releaseScroll = undefined; };
    const desktop = window.matchMedia("(min-width: 992px)");
    const closeOnDesktop = () => { if (desktop.matches) Offcanvas.getInstance(menu)?.hide(); };
    recoverOrphanedScrollLock();
    menu.addEventListener("show.bs.offcanvas", lock);
    menu.addEventListener("hidden.bs.offcanvas", unlock);
    window.addEventListener("pageshow", recoverOrphanedScrollLock);
    desktop.addEventListener("change", closeOnDesktop);
    return () => {
      menu.removeEventListener("show.bs.offcanvas", lock);
      menu.removeEventListener("hidden.bs.offcanvas", unlock);
      window.removeEventListener("pageshow", recoverOrphanedScrollLock);
      desktop.removeEventListener("change", closeOnDesktop);
      const instance = Offcanvas.getInstance(menu);
      if (instance) {
        if (menu.matches(".show,.showing")) {
          menu.addEventListener("hidden.bs.offcanvas", () => instance.dispose(), { once: true });
          instance.hide();
        } else instance.dispose();
      }
      unlock();
    };
  }, []);

  useEffect(() => {
    const menu = document.getElementById("mobileNav");
    if (menu.matches(".show,.showing")) Offcanvas.getInstance(menu)?.hide();
    recoverOrphanedScrollLock();
  }, [location.key]);

  useEffect(() => {
    if (user?.is_superuser && location.pathname === "/admin-panel/stores") clearSelectedStore();
  }, [user?.is_superuser, location.pathname]);

  useEffect(() => {
    if (!features.callbacks || featuresLoading || featuresError) return undefined;
    let isMounted = true;
    setTodayCallbackCount(0);

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
  }, [storeId, features.callbacks, featuresLoading, featuresError]);

  return (
    <div className="workspace-shell">
      <AutoDismissSuccessAlerts />
      <AutoRevealErrors />
      {features.tasks && !featuresLoading && !featuresError && <TaskNotificationAlerts />}
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
        <NavLink className="mobile-brand" to={storeHomePath(features)}>
          <span className="brand-mark">V</span>
          <span className="brand-copy"><strong>VESTATRACK</strong><small>CRM</small></span>
        </NavLink>
      </header>

      <aside className="app-sidebar d-none d-lg-flex">
        <NavLink className="app-brand" to={storeHomePath(features)}>
          <span className="brand-mark">V</span>
          <span className="brand-copy"><strong>VESTATRACK</strong><small>CRM</small>{currentStoreName && <span className="sidebar-current-store" title={currentStoreName}>{currentStoreName}</span>}</span>
        </NavLink>
        <div className="sidebar-menu-scroll">
          <Navigation user={user} attendanceProfile={attendanceProfile} attendanceAuthLoading={attendanceAuthLoading} notificationCount={notificationCount} todayCallbackCount={todayCallbackCount} />
        </div>
        <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} />
      </aside>

      <div className="offcanvas offcanvas-start" tabIndex="-1" id="mobileNav" data-bs-scroll="true" aria-labelledby="mobileNavLabel">
        <div className="offcanvas-header">
          <h2 className="h5 offcanvas-title" id="mobileNavLabel">VESTATRACK CRM{currentStoreName && <span className="offcanvas-current-store" title={currentStoreName}>{currentStoreName}</span>}</h2>
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
            <span className="workspace-brand-label">VESTATRACK / CRM</span>
            <i className="bi bi-chevron-right" aria-hidden="true" />
            <span>Customer operations</span>
          </div>
          <div className="workspace-account">
            {selectedSuperAdminStore && <button className="btn btn-outline-secondary btn-sm" type="button" aria-label="Back to stores" onClick={() => {
              // A selected store scopes every workspace request for a global
              // account. Leaving it must clear that scope instead of relying
              // on browser history, which can otherwise keep the store active.
              clearSelectedStore();
              navigate("/admin-panel/stores");
            }}>
              <i className="bi bi-arrow-left me-1" aria-hidden="true" /> Back to stores
            </button>}
            <span>{roleLabel} workspace</span>
            <span className="workspace-avatar" aria-hidden="true">{initial}</span>
          </div>
        </div>
        <div className="content-wrap">
          <Suspense fallback={<RouteLoadingIndicator />}>
            {featuresLoading ? <RouteLoadingIndicator /> : featuresError ? <div className="alert alert-danger" role="alert">Unable to verify this store's access. Please try again.</div> : featureForPath(location.pathname) === "dashboard" && !features.dashboard ? <Navigate to={storeHomePath(features)} replace /> : featureForPath(location.pathname) && !features[featureForPath(location.pathname)] ? <div className="alert alert-warning" role="alert">This feature is not enabled for your store.</div> : <Outlet key={`${user?.id}|${storeId}`} />}
          </Suspense>
        </div>
      </main>
    </div>
  );
}

function AutoDismissSuccessAlerts() {
  useEffect(() => {
    const timers = new Map();
    const schedule = (element) => {
      if (!(element instanceof HTMLElement) || !element.matches(".alert.alert-success") || element.hidden || timers.has(element)) return;
      timers.set(element, window.setTimeout(() => {
        element.hidden = true;
        timers.delete(element);
      }, 3000));
    };
    const inspect = (node) => {
      if (!(node instanceof HTMLElement)) return;
      schedule(node);
      node.querySelectorAll(".alert.alert-success").forEach(schedule);
    };
    document.querySelectorAll(".alert.alert-success").forEach(schedule);
    const observer = new MutationObserver((mutations) => mutations.forEach((mutation) => mutation.addedNodes.forEach(inspect)));
    observer.observe(document.body, { childList: true, subtree: true });
    return () => { observer.disconnect(); timers.forEach((timer) => window.clearTimeout(timer)); };
  }, []);
  return null;
}

function AutoRevealErrors() {
  useEffect(() => {
    const errorSelector = '[role="alert"], .invalid-feedback, .text-danger.small';
    const shownMessages = new WeakMap();
    let pendingFrame;

    const isVisible = (element) => element instanceof HTMLElement
      && element.isConnected
      && !element.hidden
      && element.getClientRects().length > 0;

    const reveal = (element) => {
      if (!isVisible(element)) return;
      const message = element.textContent?.trim() || "";
      if (!message || shownMessages.get(element) === message) return;
      shownMessages.set(element, message);
      window.cancelAnimationFrame(pendingFrame);
      pendingFrame = window.requestAnimationFrame(() => {
        pendingFrame = window.requestAnimationFrame(() => {
          if (!isVisible(element)) return;
          const bounds = element.getBoundingClientRect();
          const visibleTop = 96;
          const visibleBottom = window.innerHeight - 24;
          if (bounds.top < visibleTop || bounds.bottom > visibleBottom) {
            element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
          }
        });
      });
    };

    const firstError = (mutations) => {
      const matches = new Set();
      const inspect = (node) => {
        const element = node instanceof HTMLElement ? node : node.parentElement;
        if (!element) return;
        if (element.matches(errorSelector)) matches.add(element);
        element.querySelectorAll?.(errorSelector).forEach((match) => matches.add(match));
      };
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach(inspect);
        if (mutation.type === "characterData") inspect(mutation.target);
      });
      return [...matches].filter(isVisible).sort((first, second) => {
        if (first === second) return 0;
        return first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })[0];
    };

    const observer = new MutationObserver((mutations) => {
      const error = firstError(mutations);
      if (error) reveal(error);
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(pendingFrame);
    };
  }, []);
  return null;
}

function Navigation({ user, mobile = false, attendanceProfile, attendanceAuthLoading, notificationCount = 0, todayCallbackCount = 0 }) {
  const { features } = useStoreFeatures();
  const navigate = useNavigate();
  const location = useLocation();
  const customerRouteActive = location.pathname.startsWith("/datasets") || location.pathname.startsWith("/customers");
  const payrollSectionOpen = location.pathname.startsWith("/payroll");
  const timesheetSectionOpen = ["/attendance/timesheet", "/attendance/approvals"].includes(location.pathname);
  const manualAttendanceSectionOpen = location.pathname.startsWith("/attendance/manual");
  const attendanceSectionOpen = location.pathname.startsWith("/attendance") && !timesheetSectionOpen && !manualAttendanceSectionOpen;
  const payrollChildren = user?.is_admin ? [
    { to: "/payroll/overview", label: "Payroll Overview", payrollIcon: "overview" },
    { to: "/payroll/salaries", label: "Employee Salary Management", payrollIcon: "salaries" },
    { to: "/payroll/process", label: "Process Payroll", payrollIcon: "process" },
    { to: "/payroll/payslips", label: "Payslips", payrollIcon: "payslips" },
    { to: "/payroll/settings", label: "Payroll Settings", payrollIcon: "settings" },
  ] : [
    { to: "/payroll/my-salary", label: "My Salary", payrollIcon: "salaries" },
    { to: "/payroll/expenses", label: "My Expenses", payrollIcon: "expenses" },
    { to: "/payroll/payslips", label: "My Payslips", payrollIcon: "payslips" },
  ];
  const navigationItems = navItems.map((item) => {
    if (item.payroll) return { ...item, children: payrollChildren };
    if (item.label === "Attendance") return { ...item, children: item.children.filter((child) => !child.adminOnly || user?.is_admin) };
    return item;
  });
  // Keep the sidebar in one explicit state.  Separate booleans allowed two
  // sections to remain highlighted after switching between their headers.
  const routeMenu = customerRouteActive ? "customers" : payrollSectionOpen ? "payroll" : attendanceSectionOpen ? "attendance" : manualAttendanceSectionOpen ? "manualAttendance" : timesheetSectionOpen ? "timesheet" : null;
  const [openMenu, setOpenMenu] = useState(routeMenu);

  useEffect(() => {
    setOpenMenu(routeMenu);
  }, [routeMenu]);

  const handleNavigation = (event, path) => {
    if (!mobile) return;

    event.preventDefault();
    const menu = document.getElementById("mobileNav");
    menu.addEventListener("hidden.bs.offcanvas", () => {
      navigate(path);
    }, { once: true });
    Offcanvas.getOrCreateInstance(menu).hide();
  };

  const toggleMenu = (menu) => {
    setOpenMenu((current) => current === menu ? null : menu);
  };

  if (user?.is_superuser && !activeStoreId()) {
    return <nav className="sidebar-nav" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      <SidebarNavLink user={user} className={() => `sidebar-link ${location.pathname === "/admin-panel/stores" ? "active" : ""}`} to="/admin-panel/stores" onClick={(event) => handleNavigation(event, "/admin-panel/stores")}>
        <i className="bi bi-shop" /><span>Stores &amp; access</span>
      </SidebarNavLink>
      <SidebarNavLink user={user} className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`} to="/admin-panel/users?role=super_admin" onClick={(event) => handleNavigation(event, "/admin-panel/users?role=super_admin")}>
        <i className="bi bi-shield-lock" /><span>Super Admins</span>
      </SidebarNavLink>
      <div className="sidebar-menu-group">
        <button className={`sidebar-link sidebar-menu-toggle ${openMenu === "payroll" ? "active" : ""}`} type="button" aria-expanded={openMenu === "payroll"} aria-controls={mobile ? "mobile-payroll-submenu" : "desktop-payroll-submenu"} onClick={() => toggleMenu("payroll")}>
          <i className="bi bi-cash-stack" /><span>Payroll</span><i className={`bi bi-chevron-${openMenu === "payroll" ? "up" : "down"} ms-auto sidebar-menu-chevron`} aria-hidden="true" />
        </button>
        {openMenu === "payroll" && <div className="sidebar-submenu" id={mobile ? "mobile-payroll-submenu" : "desktop-payroll-submenu"}>{payrollChildren.map((child) => <SidebarNavLink user={user} className={({ isActive }) => `sidebar-link sidebar-sublink ${isActive ? "active" : ""}`} key={child.to} to={child.to} end onClick={(event) => handleNavigation(event, child.to)}><PayrollNavIcon name={child.payrollIcon} /><span>{child.label}</span></SidebarNavLink>)}</div>}
      </div>
    </nav>;
  }

  return (
    <nav className="sidebar-nav" aria-label={mobile ? "Mobile navigation" : "Main navigation"}>
      {navigationItems.filter((item) => {
        if (item.adminOnly && !user?.is_admin) return false;
        const feature = featureForPath(item.to || item.children?.[0]?.to || "");
        return !feature || features[feature];
      }).map((item) => {
        if (item.children) {
          const submenuId = mobile ? "mobile-customer-submenu" : "desktop-customer-submenu";
          const isAttendanceMenu = item.label === "Attendance";
          const isManualAttendanceMenu = item.label === "Manual Attendance";
          const isTimesheetMenu = item.label === "My Timesheet";
          const isPayrollMenu = item.label === "Payroll";
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
          const menuName = isAttendanceMenu ? "attendance" : isManualAttendanceMenu ? "manualAttendance" : isTimesheetMenu ? "timesheet" : isPayrollMenu ? "payroll" : "customers";
          const menuOpen = openMenu === menuName;
          const menuActive = menuOpen;
          const resolvedSubmenuId = isAttendanceMenu
            ? (mobile ? "mobile-attendance-submenu" : "desktop-attendance-submenu")
            : isManualAttendanceMenu ? (mobile ? "mobile-manual-attendance-submenu" : "desktop-manual-attendance-submenu")
            : isTimesheetMenu ? (mobile ? "mobile-timesheet-submenu" : "desktop-timesheet-submenu")
              : isPayrollMenu ? (mobile ? "mobile-payroll-submenu" : "desktop-payroll-submenu") : submenuId;
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
                  onClick={() => toggleMenu(isAttendanceMenu ? "attendance" : isManualAttendanceMenu ? "manualAttendance" : isTimesheetMenu ? "timesheet" : "customers")}
                >
                  <i className={`bi bi-chevron-${menuOpen ? "up" : "down"} sidebar-menu-chevron`} aria-hidden="true" />
                </button>
              </div> : <button
                className={`sidebar-link sidebar-menu-toggle ${menuActive ? "active" : ""}`}
                type="button"
                aria-expanded={menuOpen}
                aria-controls={resolvedSubmenuId}
                onClick={() => toggleMenu(menuName)}
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
                      {isPayrollMenu ? <PayrollNavIcon name={child.payrollIcon} /> : <i className={`bi ${child.icon}`} />}
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
            className={({ isActive }) => `sidebar-link ${isActive && !openMenu ? "active" : ""} ${
              (item.to === "/notifications" && notificationCount > 0) ||
              (item.to === "/callbacks" && todayCallbackCount > 0)
                ? "has-alert"
                : ""
            }`}
            to={item.to}
            onClick={(event) => { setOpenMenu(null); handleNavigation(event, item.to); }}
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
      {user?.is_admin && (
        <SidebarNavLink
          user={user}
          className={() => `sidebar-link ${location.pathname === "/admin-panel" ? "active" : ""}`}
          to="/admin-panel"
          end
          onClick={(event) => { setOpenMenu(null); handleNavigation(event, "/admin-panel"); }}
        >
          <i className="bi bi-shield-lock" />
          <span>Admin Panel</span>
        </SidebarNavLink>
      )}
      {user?.is_superuser && (
        <>
          <SidebarNavLink user={user} className={() => `sidebar-link ${location.pathname === "/admin-panel/stores" ? "active" : ""}`} to="/admin-panel/stores" end onClick={(event) => { setOpenMenu(null); handleNavigation(event, "/admin-panel/stores"); }}>
            <i className="bi bi-shop" /><span>Stores &amp; access</span>
          </SidebarNavLink>
          <SidebarNavLink user={user} className={() => `sidebar-link ${location.pathname === "/admin-panel/users" && location.search.includes("role=super_admin") ? "active" : ""}`} to="/admin-panel/users?role=super_admin" onClick={(event) => { clearSelectedStore(); setOpenMenu(null); handleNavigation(event, "/admin-panel/users?role=super_admin"); }}>
            <i className="bi bi-shield-lock" /><span>Super Admins</span>
          </SidebarNavLink>
        </>
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
