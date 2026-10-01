import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FieldRows } from "./CustomerDetail.jsx";
import { customersApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";

export default function CustomerDelete() {
  const { datasetId, recordId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError("");
    customersApi
      .detail(datasetId, recordId)
      .then(({ data }) => setDetail(data))
      .catch((err) => {
        if (err.response?.status === 404) {
          setError("Customer not found or you do not have permission to delete it.");
        } else {
          setError("Unable to load customer details.");
        }
      });
  }, [datasetId, recordId]);

  const deleteCustomer = async (event) => {
    event.preventDefault();
    setError("");
    setIsDeleting(true);
    try {
      await customersApi.remove(datasetId, recordId, csrfToken);
      navigate(`/datasets/${datasetId}`);
    } catch (err) {
      if (err.response?.status === 404) {
        setError("Customer not found or you do not have permission to delete it.");
      } else {
        setError("Unable to delete this customer.");
      }
      setIsDeleting(false);
    }
  };

  if (error && !detail) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading delete confirmation...</div>;
  }

  const { dataset, record, fieldRows } = detail;

  return (
    <div className="delete-panel">
      {error && <div className="alert alert-danger">{error}</div>}
      <h1 className="h3 mb-3">Are you sure you want to delete this customer?</h1>
      <p className="text-secondary">
        This will permanently delete only this customer record from {dataset.name}. The dataset itself will remain.
      </p>

      <FieldRows rows={fieldRows} />

      <form className="d-flex flex-wrap gap-2" onSubmit={deleteCustomer}>
        <button className="btn btn-danger" type="submit" disabled={isDeleting}>
          {isDeleting ? "Deleting..." : "Delete Customer"}
        </button>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${record.id}`}>Cancel</Link>
      </form>
    </div>
  );
}
