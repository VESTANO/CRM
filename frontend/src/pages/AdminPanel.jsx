import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";

export default function AdminPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    adminApi.summary()
      .then((response) => setData(response.data))
      .catch((requestError) => setError(requestError.response?.status === 403 ? "Administrator access required." : "Unable to load admin panel."));
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="panel">Loading admin panel...</div>;

  const pageCount = Math.ceil(data.users.length / 5);
  const visibleUsers = data.users.slice((page - 1) * 5, page * 5);

  return <>
    <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4"><div><div className="text-secondary small mb-1">Administration</div><h1 className="h2 mb-2">Admin Panel</h1><p className="text-secondary mb-0">Manage users, datasets, and CRM activity.</p></div><Link className="btn btn-primary" to="/admin-panel/users/add"><i className="bi bi-person-plus me-1" />Add User</Link></div>
    <div className="metric-grid mb-4">{[["Total Users",data.metrics.totalUsers,"bi-people"],["Active Users",data.metrics.activeUsers,"bi-person-check"],["Total Datasets",data.metrics.totalDatasets,"bi-collection"],["Total Customers",data.metrics.totalCustomers,"bi-person-lines-fill"]].map(([label,value,icon])=><div className="summary-card" key={label}><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className="summary-value">{value}</div></div>)}</div>
    <section className="panel p-0 mb-4 responsive-table"><div className="table-panel-header"><h2 className="h5 mb-1">Users</h2><p className="text-secondary small mb-0">CRM account access and ownership overview.</p></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>Date joined</th><th>Actions</th></tr></thead><tbody>{visibleUsers.map((user)=><tr key={user.id}><td data-label="Username"><div className="fw-semibold">{user.username}</div><div className="text-secondary small">{user.dataset_count} datasets · {user.customer_count} customers</div></td><td data-label="Email">{user.email||"No email"}</td><td data-label="Role"><span className="badge text-bg-primary">{user.is_admin?"Admin":"User"}</span></td><td data-label="Status"><span className={`badge text-bg-${user.is_active?"success":"secondary"}`}>{user.is_active?"Active":"Inactive"}</span></td><td data-label="Date joined">{formatDateTime(user.date_joined)}</td><td data-label="Actions"><div className="btn-group btn-group-sm table-actions"><Link className="btn btn-outline-primary" to={`/admin-panel/users/${user.id}`}>View</Link><Link className="btn btn-outline-secondary" to={`/admin-panel/users/${user.id}/edit`}>Edit</Link><Link className="btn btn-outline-secondary" to={`/admin-panel/users/${user.id}/datasets`}>Datasets</Link></div></td></tr>)}</tbody></table></div>
      {pageCount > 1 && <div className="d-flex justify-content-between align-items-center px-3 pb-3"><span className="text-secondary small">Page {page} of {pageCount}</span><div className="d-flex gap-2"><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>Previous</button><button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setPage((current) => current + 1)} disabled={page >= pageCount}>Next</button></div></div>}
    </section>
    <div className="row g-4"><div className="col-lg-6"><section className="panel"><h2 className="h5 mb-3">Recent datasets</h2>{data.recentDatasets.map((dataset)=><Link className="list-group-item list-group-item-action px-0 py-3" to={`/datasets/${dataset.id}`} key={dataset.id}><span className="fw-semibold d-block">{dataset.name}</span><span className="text-secondary small">{dataset.owner_username} · {dataset.customer_count} customers</span></Link>)}</section></div><div className="col-lg-6"><section className="panel"><h2 className="h5 mb-3">Recently created users</h2>{data.recentUsers.map((user)=><Link className="list-group-item list-group-item-action px-0 py-3" to={`/admin-panel/users/${user.id}`} key={user.id}><span className="fw-semibold d-block">{user.username}</span><span className="text-secondary small">{user.email||"No email"} · {formatDateTime(user.date_joined)}</span></Link>)}</section></div></div>
  </>;
}
