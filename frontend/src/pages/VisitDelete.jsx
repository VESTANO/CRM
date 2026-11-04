import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { peekCachedResponse, salesApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";

export default function VisitDelete() {
  const { visitId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [visit, setVisit] = useState(() => peekCachedResponse(`/sales/visits/${visitId}/`)?.data || null);
  const [error, setError] = useState("");

  useEffect(() => {
    salesApi.detail(visitId)
      .then(({ data }) => setVisit(data))
      .catch(() => setError("Visit not found or you do not have permission to delete it."));
  }, [visitId]);

  const submit = async (event) => {
    event.preventDefault();
    try {
      await salesApi.remove(visitId, csrfToken);
      navigate("/sales");
    } catch {
      setError("Unable to delete this visit.");
    }
  };

  if (error && !visit) return <div className="alert alert-danger">{error}</div>;
  if (!visit) return <div className="panel">Loading delete confirmation...</div>;

  return <div className="delete-panel">
    <h1 className="h3 mb-3">Are you sure you want to delete this visit?</h1>
    <p className="text-secondary">This will permanently delete the visit for {visit.client_name}.</p>
    {error && <div className="alert alert-danger">{error}</div>}
    <form className="d-flex flex-wrap gap-2" onSubmit={submit}>
      <button className="btn btn-danger">Delete Visit</button>
      <Link className="btn btn-outline-secondary" to={`/sales/visits/${visitId}`}>Cancel</Link>
    </form>
  </div>;
}
