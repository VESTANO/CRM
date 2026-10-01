import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { datasetsApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";

export default function DatasetManagement({ mode }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [dataset, setDataset] = useState(null);
  const [name, setName] = useState("");
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDataset(null);
    setError("");
    datasetsApi.list().then(({ data }) => {
      const found = data.results.find((item) => String(item.id) === id);
      if (!found) throw new Error("not-found");
      setDataset(found);
      setName(found.name);
    }).catch(() => setError("Dataset not found or you do not have permission to manage it."));
  }, [id]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setError("");
    try {
      if (mode === "rename") {
        await datasetsApi.rename(id, name, csrfToken);
        navigate(`/datasets/${id}`, { state: { message: "Dataset renamed successfully." } });
      } else {
        await datasetsApi.remove(id, csrfToken);
        navigate("/datasets", { replace: true });
      }
    } catch (err) {
      if (err.response?.data?.errors) setErrors(err.response.data.errors);
      else setError(err.response?.data?.detail || "Unable to update this dataset.");
      setSaving(false);
    }
  };

  if (error && !dataset) return <div className="alert alert-danger">{error}</div>;
  if (!dataset) return <div className="panel">Loading dataset...</div>;

  return mode === "rename" ? (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${id}`}>{dataset.name}</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Rename</li>
        </ol>
      </nav>
      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div><h1 className="h2 mb-2">Rename Dataset</h1><p className="text-secondary mb-0">{dataset.original_filename}</p></div>
        <Link className="btn btn-outline-secondary" to={`/datasets/${id}`}>Back</Link>
      </div>
      {error && <div className="alert alert-danger">{error}</div>}
      <div className="panel">
        <form onSubmit={submit} noValidate>
          <div className="mb-3">
            <label className="form-label" htmlFor="dataset-name">Dataset name</label>
            <input className="form-control" id="dataset-name" maxLength="255" value={name} onChange={(event) => setName(event.target.value)} />
            {(errors.name || []).map((message) => <div className="text-danger small mt-2" key={message}>{message}</div>)}
          </div>
          <div className="d-flex flex-wrap gap-2">
            <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving..." : "Save"}</button>
            <Link className="btn btn-outline-secondary" to={`/datasets/${id}`}>Cancel</Link>
          </div>
        </form>
      </div>
    </>
  ) : (
    <div className="delete-panel">
      {error && <div className="alert alert-danger">{error}</div>}
      <h1 className="h3 mb-3">Are you sure you want to delete this dataset?</h1>
      <p className="text-secondary mb-4">
        This will delete {dataset.name} and all {dataset.customer_count} customer records belonging to it. Other datasets will remain untouched.
      </p>
      <form className="d-flex flex-wrap gap-2" onSubmit={submit}>
        <button className="btn btn-danger" type="submit" disabled={saving}>{saving ? "Deleting..." : "Delete Dataset"}</button>
        <Link className="btn btn-outline-secondary" to={`/datasets/${id}`}>Cancel</Link>
      </form>
    </div>
  );
}
