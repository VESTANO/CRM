import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { datasetsApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDateTime } from "../utils/formatters.js";

export default function DatasetList() {
  const { user } = useAuth();
  const [datasets, setDatasets] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const showOwner = Boolean(user?.is_admin);
  const pageCount = Math.ceil((datasets?.length || 0) / 5);
  const visibleDatasets = datasets?.slice((page - 1) * 5, page * 5) || [];

  useEffect(() => {
    datasetsApi
      .list()
      .then(({ data }) => setDatasets(data.results))
      .catch(() => setError("Unable to load customer lists."));
  }, []);

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Customer Lists</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between align-items-center gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Customer Lists</h1>
          <p className="text-secondary mb-0">Each uploaded Excel file is stored as an independent dataset.</p>
        </div>
        <Link className="btn btn-primary" to="/import"><i className="bi bi-plus-lg me-1" />Import Excel</Link>
      </div>

      {datasets === null ? (
        <div className="panel">Loading customer lists...</div>
      ) : datasets.length ? (
        <div className="table-responsive panel p-0 responsive-table">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th scope="col">Dataset</th>
                {showOwner && <th scope="col">Owner</th>}
                <th scope="col">File</th>
                <th scope="col">Customers</th>
                <th scope="col">Uploaded</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleDatasets.map((dataset) => (
                <tr key={dataset.id}>
                  <td data-label="Dataset">
                    <div className="fw-semibold">{dataset.name}</div>
                  </td>
                  {showOwner && <td data-label="Owner">{dataset.owner_username}</td>}
                  <td className="text-secondary" data-label="File">{dataset.original_filename}</td>
                  <td data-label="Customers"><span className="badge text-bg-light">{dataset.customer_count}</span></td>
                  <td data-label="Uploaded">{formatDateTime(dataset.uploaded_at)}</td>
                  <td data-label="Actions">
                    <div className="btn-group btn-group-sm dataset-actions" role="group" aria-label="Dataset actions">
                      <Link className="btn btn-outline-primary" to={`/datasets/${dataset.id}`}>
                        <i className="bi bi-box-arrow-up-right me-1" />Open
                      </Link>
                      <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/rename`}>
                        <i className="bi bi-pencil me-1" />Rename
                      </Link>
                      <Link className="btn btn-outline-danger" to={`/datasets/${dataset.id}/delete`}>
                        <i className="bi bi-trash me-1" />Delete
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">
          <p className="mb-3">No customer datasets have been created yet.</p>
          <Link className="btn btn-primary" to="/import">Import Excel</Link>
        </div>
      )}
      {datasets?.length > 5 && (
        <div className="d-flex justify-content-between align-items-center mt-3">
          <span className="text-secondary small">Page {page} of {pageCount}</span>
          <div className="d-flex gap-2">
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>Previous</button>
            <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setPage((current) => current + 1)} disabled={page >= pageCount}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
