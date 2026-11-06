import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";

function userRole(user) {
  if (user.is_superuser || user.role === "super_admin") return "Super Admin";
  if (user.is_admin) return "Admin";
  return "User";
}

export default function AdminUsers() {
  const [users, setUsers] = useState(() => (
    peekCachedResponse("/admin/users/")?.data?.results
    ?? peekCachedResponse("/admin/summary/")?.data?.users
    ?? null
  ));
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const { data } = await adminApi.listUsers();
      setUsers(data.results);
    } catch (requestError) {
      const denied = requestError.response?.status === 403;
      if (denied) setUsers(null);
      setError(denied ? "Administrator access required." : "Unable to load users.");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error && users === null) return <RequestError message={error} onRetry={load} />;
  if (users === null) return <LoadingPanel label="Loading all users" />;

  const activeCount = users.filter((user) => user.is_active).length;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/admin-panel">Admin Panel</Link></li>
          <li className="breadcrumb-item active" aria-current="page">All Users</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Administration</div>
          <h1 className="h2 mb-2">All Users</h1>
          <p className="text-secondary mb-0">Every CRM account, including administrators and inactive users.</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <Link className="btn btn-outline-secondary" to="/admin-panel">Back to Admin Panel</Link>
          <Link className="btn btn-outline-secondary" to="/admin-panel/stores">Stores</Link>
          <Link className="btn btn-primary" to="/admin-panel/users/add"><i className="bi bi-person-plus" />Add User</Link>
        </div>
      </div>

      {error && <div className="alert alert-warning" role="alert">{error} Showing the last loaded user list.</div>}

      <div className="metric-grid mb-4">
        {[
          ["Total Users", users.length, "bi-people"],
          ["Active Users", activeCount, "bi-person-check"],
          ["Inactive Users", users.length - activeCount, "bi-person-dash"],
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
          <p className="text-secondary small mb-0">Showing all {users.length} users.</p>
        </div>
        {users.length ? (
          <>
            <p className="table-scroll-hint">Scroll horizontally to see all user details and actions.</p>
            <div className="table-responsive" tabIndex={0} role="region" aria-label="All users table, scroll horizontally to see all columns">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    {["Username", "Email", "Role", "Status", "Datasets", "Customers", "Actions"].map((heading) => <th scope="col" key={heading}>{heading}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Username"><Link className="fw-semibold" to={`/admin-panel/users/${user.id}`}>{user.username}</Link></td>
                      <td data-label="Email">{user.email || "No email"}</td>
                      <td data-label="Role"><span className={`badge text-bg-${user.is_admin ? "primary" : "secondary"}`}>{userRole(user)}</span></td>
                      <td data-label="Status"><span className={`badge text-bg-${user.is_active ? "success" : "secondary"}`}>{user.is_active ? "Active" : "Inactive"}</span></td>
                      <td data-label="Datasets">{user.dataset_count ?? 0}</td>
                      <td data-label="Customers">{user.customer_count ?? 0}</td>
                      <td data-label="Actions">
                        <div className="table-actions" role="group" aria-label={`Actions for ${user.username}`}>
                          <Link className="btn btn-outline-primary btn-sm" to={`/admin-panel/users/${user.id}`}>View</Link>
                          <Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users/${user.id}/edit`}>Edit</Link>
                          <Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users/${user.id}/datasets`}>Datasets</Link>
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
            <Link className="btn btn-primary" to="/admin-panel/users/add">Add User</Link>
          </div>
        )}
      </section>
    </>
  );
}
