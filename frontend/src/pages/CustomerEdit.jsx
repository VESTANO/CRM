import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FieldRows } from "./CustomerDetail.jsx";
import { customersApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";

export default function CustomerEdit() {
  const { datasetId, recordId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [detail, setDetail] = useState(null);
  const [form, setForm] = useState({ response: "", note: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError("");
    customersApi
      .detail(datasetId, recordId)
      .then(({ data }) => {
        setDetail(data);
        setForm({
          response: data.record.response,
          note: data.record.note || "",
        });
      })
      .catch((err) => {
        if (err.response?.status === 404) {
          setError("Customer not found or you do not have permission to edit it.");
        } else {
          setError("Unable to load customer details.");
        }
      });
  }, [datasetId, recordId]);

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setError("");
    setIsSubmitting(true);
    try {
      await customersApi.update(datasetId, recordId, form, csrfToken);
      navigate(`/datasets/${datasetId}/customers/${recordId}`, {
        state: { message: "Customer CRM information updated successfully." },
      });
    } catch (err) {
      if (err.response?.data?.errors) {
        setErrors(err.response.data.errors);
      } else {
        setError("Unable to save customer information.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading customer edit form...</div>;
  }

  const { dataset, record, fieldRows, responseChoices } = detail;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${dataset.id}`}>{dataset.name}</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${dataset.id}/customers/${record.id}`}>Customer Details</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Edit</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Edit Customer</h1>
          <p className="text-secondary mb-0">{dataset.name} · CRM fields only</p>
        </div>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${record.id}`}>Back</Link>
      </div>

      <div className="row g-4">
        <div className="col-lg-5">
          <div className="panel">
            <form onSubmit={submit} noValidate>
              <div className="mb-3">
                <label className="form-label" htmlFor="customer-response">Response</label>
                <select
                  className="form-select"
                  id="customer-response"
                  value={form.response}
                  onChange={(event) => setForm({ ...form, response: event.target.value })}
                >
                  {responseChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                  ))}
                </select>
                <FieldErrors errors={errors.response} />
              </div>
              <div className="mb-3">
                <label className="form-label" htmlFor="customer-note">Note</label>
                <textarea
                  className="form-control"
                  id="customer-note"
                  rows="5"
                  placeholder="Add CRM notes for this customer"
                  maxLength="2000"
                  value={form.note}
                  onChange={(event) => setForm({ ...form, note: event.target.value })}
                />
                <FieldErrors errors={errors.note} />
              </div>
              <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Saving..." : "Save"}
              </button>
              <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${record.id}`}>Cancel</Link>
            </form>
          </div>
        </div>
        <div className="col-lg-7">
          <div className="panel bg-light">
            <h2 className="h5 mb-3">Original Excel Data</h2>
            <FieldRows rows={fieldRows} />
          </div>
        </div>
      </div>
    </>
  );
}

function FieldErrors({ errors }) {
  if (!errors?.length) return null;
  return errors.map((error) => (
    <div className="text-danger small mt-2" key={error}>{error}</div>
  ));
}
