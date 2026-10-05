import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDateTime } from "../utils/formatters.js";

export default function AdminUserDetail() {
  const { userId } = useParams();
  const { csrfToken } = useAuth();
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setUser(null);
    setError("");
    adminApi
      .detail(userId)
      .then((response) => setUser(response.data))
      .catch((requestError) => {
        setError(requestError.response?.data?.detail || "Unable to load user.");
      });
  }, [userId]);

  const toggle = async () => {
    try {
      const response = await adminApi.action(userId, "toggle-active", {}, csrfToken);
      setUser(response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to update status.");
    }
  };

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!user) return <div className="panel">Loading user...</div>;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/admin-panel">Admin Panel</Link></li>
          <li className="breadcrumb-item active" aria-current="page">{user.username}</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">{user.username}</h1>
          <p className="text-secondary mb-0">User account, access status, and CRM ownership.</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <a className="btn btn-primary" href={`/admin-panel/users/${user.id}/edit`}>Edit user</a>
          {!user.is_admin && (
            <a className="btn btn-outline-secondary" href={`/admin-panel/users/${user.id}/password`}>
              Reset password
            </a>
          )}
          <a className="btn btn-outline-secondary" href={`/admin-panel/users/${user.id}/datasets`}>
            View datasets
          </a>
        </div>
      </div>

      <div className="row g-4">
        <div className="col-lg-7">
          <section className="panel">
            <h2 className="h5 mb-3">Account information</h2>
            <Info label="Username" value={user.username} />
            <Info label="Email" value={user.email || "No email"} />
            <Info label="Role" value={user.is_admin ? "Admin" : "User"} />
            <Info label="Account status" value={user.is_active ? "Active" : "Inactive"} />
            <Info label="Date joined" value={formatDateTime(user.date_joined)} />
          </section>
        </div>
        <div className="col-lg-5">
          <section className="panel">
            <h2 className="h5 mb-3">CRM ownership</h2>
            <div className="metric-grid">
              <div className="summary-card compact">
                <div className="text-secondary small">Datasets owned</div>
                <div className="fs-4">{user.dataset_count}</div>
              </div>
              <div className="summary-card compact">
                <div className="text-secondary small">Customers owned</div>
                <div className="fs-4">{user.customer_count}</div>
              </div>
            </div>
            <button className={`btn btn-outline-${user.is_active ? "danger" : "primary"} w-100 mt-4`} onClick={toggle}>
              {user.is_active ? "Deactivate user" : "Activate user"}
            </button>
          </section>
        </div>
      </div>
    </>
  );
}

function Info({ label, value }) {
  return (
    <dl className="row mb-2">
      <dt className="col-sm-4">{label}</dt>
      <dd className="col-sm-8">{value}</dd>
    </dl>
  );
}
