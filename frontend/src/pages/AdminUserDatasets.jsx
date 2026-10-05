import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";

export default function AdminUserDatasets() {
  const { userId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    setError("");

    adminApi
      .datasets(userId)
      .then((response) => setData(response.data))
      .catch((requestError) => {
        const detail = requestError.response?.data?.detail;
        setError(
          detail ||
            (requestError.response?.status === 404
            ? "User not found."
            : "Unable to load this user's datasets.")
        );
      });
  }, [userId]);

  if (error) {
    return (
      <div className="alert alert-danger" role="alert">
        {error}
      </div>
    );
  }

  if (!data) {
    return <div className="panel">Loading datasets...</div>;
  }

  const user = data.user || {};
  const datasets = data.results || [];

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item">
            <Link to="/admin-panel">Admin Panel</Link>
          </li>
          <li className="breadcrumb-item">
            <Link to={`/admin-panel/users/${userId}`}>{user.username || "User"}</Link>
          </li>
          <li className="breadcrumb-item active" aria-current="page">Datasets</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">{user.username || "User"} Datasets</h1>
          <p className="text-secondary mb-0">Datasets owned by this user only.</p>
        </div>
        <Link className="btn btn-outline-secondary" to="/admin-panel">
          Back to Admin Panel
        </Link>
      </div>

      {datasets.length ? (
        <section className="panel p-0 responsive-table">
          <div className="table-responsive">
            <table className="table table-hover align-middle mb-0">
              <thead className="table-light">
                <tr>
                  <th>Dataset Name</th>
                  <th>Customer Count</th>
                  <th>Created Date</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {datasets.map((dataset) => (
                  <tr key={dataset.id}>
                    <td data-label="Dataset Name">
                      <div className="fw-semibold">{dataset.name}</div>
                      <div className="text-secondary small">{dataset.original_filename}</div>
                    </td>
                    <td data-label="Customer Count">{dataset.customer_count}</td>
                    <td data-label="Created Date">{formatDateTime(dataset.uploaded_at)}</td>
                    <td data-label="Actions">
                      <a className="btn btn-outline-primary btn-sm" href={`/datasets/${dataset.id}`}>
                        Open Dataset
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <div className="empty-state">This user does not own any datasets yet.</div>
      )}
    </>
  );
}
