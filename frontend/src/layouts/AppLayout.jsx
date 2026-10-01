import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";

const navItems = [
  { to: "/dashboard", label: "Dashboard", icon: "bi-grid-1x2" },
  { to: "/datasets", label: "Customer Lists", icon: "bi-people" },
  { to: "/sales", label: "Sales", icon: "bi-briefcase" },
  { to: "/import", label: "Import Excel", icon: "bi-cloud-arrow-up" },
  { to: "/notifications", label: "Reminder", icon: "bi-alarm" },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const initial = user?.username?.charAt(0)?.toUpperCase() || "U";
  const roleLabel = user?.is_admin ? "Admin" : "User";

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
          <Navigation user={user} />
        </div>
        <UserPanel user={user} initial={initial} roleLabel={roleLabel} logout={logout} />
      </aside>

      <div className="offcanvas offcanvas-start" tabIndex="-1" id="mobileNav" aria-labelledby="mobileNavLabel">
        <div className="offcanvas-header">
          <h2 className="h5 offcanvas-title" id="mobileNavLabel">Customer CRM</h2>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Close" />
        </div>
        <div className="offcanvas-body d-flex flex-column">
          <Navigation user={user} mobile />
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

function Navigation({ user, mobile = false }) {
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
            className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
            to={item.to}
            data-bs-dismiss={mobile ? "offcanvas" : undefined}
          >
            <i className={`bi ${item.icon}`} />
            <span>{item.label}</span>
          </NavLink>
        )
      ))}
      {user?.is_admin && (
        <NavLink
          className={({ isActive }) => `sidebar-link ${isActive ? "active" : ""}`}
          to="/admin-panel"
          data-bs-dismiss={mobile ? "offcanvas" : undefined}
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
