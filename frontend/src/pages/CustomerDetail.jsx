import { Fragment, useEffect, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { customersApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";
import TimedAlert from "../components/TimedAlert.jsx";

export default function CustomerDetail() {
  const { datasetId, recordId, id } = useParams();
  const customerId = recordId || id;
  const location = useLocation();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDetail(null);
    setError("");
    (datasetId ? customersApi.detail(datasetId, customerId) : customersApi.detailById(customerId))
      .then(({ data }) => setDetail(data))
      .catch((err) => {
        if (err.response?.status === 404) {
          setError("Customer not found or you do not have permission to access it.");
        } else {
          setError("Unable to load customer details.");
        }
      });
  }, [datasetId, customerId]);

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading customer details...</div>;
  }

  const { dataset, record, fieldRows } = detail;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item"><Link to="/datasets">Customer Lists</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${dataset.id}`}>{dataset.name}</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Customer Details</li>
        </ol>
      </nav>

      {location.state?.message && (
        <TimedAlert message={location.state.message} />
      )}

      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Customer Details</h1>
          <p className="text-secondary mb-0">{dataset.name} · {record.sheet_name} row {record.row_number}</p>
        </div>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}`}>Back</Link>
      </div>

      <div className="panel mb-4">
        <h2 className="h5 mb-3">Original Excel Data</h2>
        <FieldRows rows={fieldRows} />
      </div>

      <div className="panel mb-4">
        <h2 className="h5 mb-3">CRM Information</h2>
        <dl className="row mb-0">
          <dt className="col-sm-4">Response</dt>
          <dd className="col-sm-8">
            <span className={`badge-response response-${record.response}`}>{record.response_label}</span>
          </dd>
          <dt className="col-sm-4">Note</dt>
          <dd className="col-sm-8">{record.note || ""}</dd>
          <dt className="col-sm-4">Created</dt>
          <dd className="col-sm-8">{formatDateTime(record.created_at)}</dd>
          <dt className="col-sm-4">Updated</dt>
          <dd className="col-sm-8">{formatDateTime(record.updated_at)}</dd>
        </dl>
      </div>

      <div className="d-flex flex-wrap gap-2">
        <Link className="btn btn-primary" to={`/datasets/${dataset.id}/customers/${record.id}/edit`}>Edit</Link>
        <Link className="btn btn-outline-danger" to={`/datasets/${dataset.id}/customers/${record.id}/delete`}>Delete</Link>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}`}>Back to Dataset</Link>
      </div>
    </>
  );
}

export function FieldRows({ rows }) {
  return (
    <dl className="row mb-0">
      {rows.map((field) => (
        <Fragment key={field.label}>
          <dt className="col-sm-4">{field.label}</dt>
          <dd className="col-sm-8">{field.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
