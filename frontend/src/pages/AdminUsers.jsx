import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";

function userRole(user) {
  if (user.is_superuser || user.role === "super_admin") return "Super Admin";
  if (user.is_admin) return "Admin";
  return "User";
}

export default function AdminUsers() {
  const [searchParams] = useSearchParams();
  const storeFilter = searchParams.get("store") || "";
  const superAdminsOnly = searchParams.get("role") === "super_admin";
  const { user: signedInUser, csrfToken } = useAuth();
  const userListRequest = (storeFilter || superAdminsOnly) ? { params: { ...(storeFilter ? { store: storeFilter } : {}), ...(superAdminsOnly ? { role: "super_admin" } : {}) } } : {};
  const [users, setUsers] = useState(() => (
    peekCachedResponse("/admin/users/", userListRequest)?.data?.results
    ?? (!storeFilter ? peekCachedResponse("/admin/summary/")?.data?.users : null)
    ?? null
  ));
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const { data } = await adminApi.listUsers(storeFilter, superAdminsOnly ? "super_admin" : "");
      setUsers(data.results);
    } catch (requestError) {
      const denied = requestError.response?.status === 403;
      if (denied) setUsers(null);
      setError(denied ? "Administrator access required." : "Unable to load users.");
    }
  }, [storeFilter, superAdminsOnly]);

  useEffect(() => { load(); }, [load]);

  if (error && users === null) return <RequestError message={error} onRetry={load} />;
  if (users === null) return <LoadingPanel label="Loading all users" />;

  // The API is store-scoped, and this guard also prevents a cached response
  // from a previously viewed store appearing during navigation.
  const visibleUsers = storeFilter ? users.filter((user) => user.store_id === storeFilter) : users;
  const activeCount = visibleUsers.filter((user) => user.is_active).length;
  const isSuperAdmin = Boolean(signedInUser?.is_superuser);
  const backPath = isSuperAdmin ? "/admin-panel/stores" : "/admin-panel";
  const backLabel = isSuperAdmin ? "Back to Stores" : "Back to Admin Panel";
  const title = superAdminsOnly ? "Super Admins" : storeFilter ? "Store Team" : "All Users";
  const deactivate = async (target) => {
    try {
      const { data } = await adminApi.action(target.id, "toggle-active", {}, csrfToken);
      setUsers((current) => current.map((item) => item.id === data.id ? data : item));
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to change this account status.");
    }
  };

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to={superAdminsOnly ? "/admin-panel/users?role=super_admin" : backPath}>{superAdminsOnly ? "Super Admins" : isSuperAdmin ? "Stores" : "Admin Panel"}</Link></li>
          <li className="breadcrumb-item active" aria-current="page">All Users</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Administration</div>
          <h1 className="h2 mb-2">{title}</h1>
          <p className="text-secondary mb-0">{superAdminsOnly ? "Global Super Admin accounts, independent of every store." : storeFilter ? "Accounts in the selected store only." : "Every CRM account, including administrators and inactive users."}</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <Link className="btn btn-outline-secondary" to={backPath}>{backLabel}</Link>
          {!isSuperAdmin && <Link className="btn btn-outline-secondary" to="/admin-panel/stores">Stores</Link>}
          <Link className="btn btn-primary" to={superAdminsOnly ? "/admin-panel/users/add?role=super_admin" : storeFilter ? `/admin-panel/users/add?store=${storeFilter}` : "/admin-panel/stores"}><i className="bi bi-person-plus" />{superAdminsOnly ? "Add Super Admin" : storeFilter ? "Add User" : "Choose Store"}</Link>
        </div>
      </div>

      {error && <div className="alert alert-warning" role="alert">{error} Showing the last loaded user list.</div>}

      <div className="metric-grid mb-4">
        {[
          ["Total Users", visibleUsers.length, "bi-people"],
          ["Active Users", activeCount, "bi-person-check"],
          ["Inactive Users", visibleUsers.length - activeCount, "bi-person-dash"],
        ].map(([label, value, icon]) => (
          <div className="summary-card" key={label}>
            <span className="metric-icon"><i className={`bi ${icon}`} /></span>
            <div className="text-secondary small">{label}</div>
            <div className="summary-value">{value}</div>
          </div>
        ))}
      </div>

      <section className="panel p-0 mb-4 responsive-table" aria-labelledby="all-users-heading">
        <div className="table-panel-header">
          <h2 className="h5 mb-1" id="all-users-heading">User Directory</h2>
          <p className="text-secondary small mb-0">Showing {visibleUsers.length} user{visibleUsers.length === 1 ? "" : "s"}{storeFilter ? " in this store" : ""}.</p>
        </div>
        {visibleUsers.length ? (
          <>
            <p className="table-scroll-hint">Scroll horizontally to see all user details and actions.</p>
            <div className="table-responsive" tabIndex={0} role="region" aria-label="All users table, scroll horizontally to see all columns">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    {["Username", "Email", ...(storeFilter || superAdminsOnly ? [] : ["Store"]), "Role", "Status", ...(superAdminsOnly ? [] : ["Datasets", "Customers"]), "Actions"].map((heading) => <th scope="col" key={heading}>{heading}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Username"><Link className="fw-semibold" to={`/admin-panel/users/${user.id}`}>{user.username}</Link></td>
                      <td data-label="Email">{user.email || "No email"}</td>
                      {!storeFilter && !superAdminsOnly && <td data-label="Store">{user.store_name || "—"}</td>}
                      <td data-label="Role"><span className={`badge text-bg-${user.is_admin ? "primary" : "secondary"}`}>{userRole(user)}</span></td>
                      <td data-label="Status"><span className={`badge text-bg-${user.is_active ? "success" : "secondary"}`}>{user.is_active ? "Active" : "Inactive"}</span></td>
                      {!superAdminsOnly && <><td data-label="Datasets">{user.dataset_count ?? 0}</td><td data-label="Customers">{user.customer_count ?? 0}</td></>}
                      <td data-label="Actions">
                        <div className="table-actions" role="group" aria-label={`Actions for ${user.username}`}>
                          <Link className="btn btn-outline-primary btn-sm" to={`/admin-panel/users/${user.id}`}>View</Link>
                          <Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users/${user.id}/edit`}>Edit</Link>
                          {!superAdminsOnly && <Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users/${user.id}/datasets`}>Datasets</Link>}
                          {superAdminsOnly && <button className={`btn btn-outline-${user.is_active ? "danger" : "primary"} btn-sm`} type="button" disabled={user.id === signedInUser?.id} onClick={() => deactivate(user)}>{user.is_active ? "Deactivate" : "Activate"}</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state text-center">
            <h3 className="h5">No users yet</h3>
            <p className="text-secondary">Add a user to start managing CRM accounts.</p>
            <Link className="btn btn-primary" to={storeFilter ? `/admin-panel/users/add?store=${storeFilter}` : "/admin-panel/stores"}>{storeFilter ? "Add User" : "Choose Store"}</Link>
          </div>
        )}
      </section>
    </>
  );
}
