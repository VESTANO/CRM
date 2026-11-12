import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDateTime } from "../utils/formatters.js";

export default function AdminUserDetail() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { csrfToken, user: signedInUser } = useAuth();
  const [user, setUser] = useState(() => peekCachedResponse(`/admin/users/${userId}/`)?.data || null);
  const [error, setError] = useState("");

  useEffect(() => {
    const cachedUser = peekCachedResponse(`/admin/users/${userId}/`)?.data || null;
    setUser(cachedUser);
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

  if (error && !user) return <div className="alert alert-danger">{error}</div>;
  if (!user) return <div className="panel">Loading user...</div>;

  return (
    <>
      {error && <div className="alert alert-danger" role="alert">{error} Showing the last loaded user details.</div>}
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to={user.is_superuser ? "/admin-panel/users?role=super_admin" : "/admin-panel"}>{user.is_superuser ? "Super Admins" : "Admin Panel"}</Link></li>
          <li className="breadcrumb-item active" aria-current="page">{user.username}</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">{user.username}</h1>
          <p className="text-secondary mb-0">{user.is_superuser ? "Global Super Admin account, independent of every store." : "User account, access status, and CRM ownership."}</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <button className="btn btn-outline-secondary" type="button" onClick={() => navigate(-1)}>Back</button>
          <Link className="btn btn-primary" to={`/admin-panel/users/${user.id}/edit`}>{user.is_superuser ? "Edit Super Admin" : "Edit user"}</Link>
          {(!user.is_admin || signedInUser?.is_superuser) && (
            <Link className="btn btn-outline-secondary" to={`/admin-panel/users/${user.id}/password`}>
              Reset password
            </Link>
          )}
        </div>
      </div>

      <div className="row g-4">
        <div className="col-lg-7">
          <section className="panel">
            <h2 className="h5 mb-3">Account information</h2>
            <Info label="Username" value={user.username} />
            <Info label="Email" value={user.email || "No email"} />
            <Info label="Role" value={user.is_admin ? "Admin" : "User"} />
            <Info label="Designation" value={user.designation || "Not assigned"} />
            <Info label="Account status" value={user.is_active ? "Active" : "Inactive"} />
            <Info label="Date joined" value={formatDateTime(user.date_joined)} />
          </section>
        </div>
        <div className="col-lg-5">
          <section className="panel">
            <h2 className="h5 mb-3">Account access</h2>
            <p className="text-secondary mb-4">Manage this account's active status and role. Store data is managed from its store workspace.</p>
            <button className={`btn btn-outline-${user.is_active ? "danger" : "primary"} w-100 mt-4`} onClick={toggle}>
              {user.is_active ? user.is_superuser ? "Deactivate Super Admin" : "Deactivate user" : user.is_superuser ? "Activate Super Admin" : "Activate user"}
            </button>
          </section>
        </div>
      </div>
    </>
  );
}

function Info({ label, value }) {
  return (
    <dl className="row admin-info-row">
      <dt className="col-sm-4">{label}</dt>
      <dd className="col-sm-8">{value}</dd>
    </dl>
  );
}
