import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { customersApi, peekCachedResponse } from "../services/api.js";
import { formatDate, formatDateTime } from "../utils/formatters.js";
import TimedAlert from "../components/TimedAlert.jsx";
import "../styles/mobile-business.css";

export default function CustomerDetail() {
  const { datasetId, recordId, id } = useParams();
  const customerId = recordId || id;
  const location = useLocation();
  const detailUrl = datasetId ? `/datasets/${datasetId}/customers/${customerId}/` : `/customers/${customerId}/`;
  const [detail, setDetail] = useState(() => peekCachedResponse(detailUrl)?.data || null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setDetail(peekCachedResponse(detailUrl)?.data || null);
    setError("");
    (datasetId ? customersApi.detail(datasetId, customerId) : customersApi.detailById(customerId))
      .then(({ data }) => { if (active) setDetail(data); })
      .catch((err) => {
        if (!active) return;
        if (err.response?.status === 404) {
          setError("Customer not found or you do not have permission to access it.");
        } else {
          setError("Unable to load customer details.");
        }
      });
    return () => { active = false; };
  }, [datasetId, customerId, detailUrl]);

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading customer details...</div>;
  }

  const { dataset, record, fieldRows, changeHistory = [] } = detail;

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
          {record.response === "callback" && (
            <>
              <dt className="col-sm-4">Callback Date</dt>
              <dd className="col-sm-8">{record.callback_date ? formatDate(record.callback_date) : "Not scheduled"}</dd>
            </>
          )}
          <dt className="col-sm-4">Created</dt>
          <dd className="col-sm-8">{formatDateTime(record.created_at)}</dd>
          <dt className="col-sm-4">Updated</dt>
          <dd className="col-sm-8">{formatDateTime(record.updated_at)}</dd>
        </dl>
      </div>

      <CustomerChangeHistory entries={changeHistory} datasetId={dataset.id} recordId={record.id} nextCursor={detail.changeHistoryNextCursor} />

      <div className="d-flex flex-wrap gap-2">
        <Link className="btn btn-primary" to={`/datasets/${dataset.id}/customers/${record.id}/edit`}>Edit</Link>
        <Link className="btn btn-outline-danger" to={`/datasets/${dataset.id}/customers/${record.id}/delete`}>Delete</Link>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}`}>Back to Dataset</Link>
      </div>
    </>
  );
}

export function CustomerChangeHistory({ entries, datasetId, recordId, nextCursor = null, className = "mb-4" }) {
  const [history, setHistory] = useState(entries);
  const [cursor, setCursor] = useState(nextCursor);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  useEffect(() => { sequence.current += 1; setHistory(entries); setCursor(nextCursor); setLoading(false); setError(""); return () => { sequence.current += 1; }; }, [entries, nextCursor, datasetId, recordId]);
  const loadMore = async () => {
    const request = ++sequence.current;
    setLoading(true); setError("");
    try {
      const { data } = await customersApi.history(datasetId, recordId, cursor);
      if (request !== sequence.current) return;
      setHistory((current) => [...new Map([...current, ...data.entries].map((entry) => [entry.id, entry])).values()]);
      setCursor(data.nextCursor);
    } catch { if (request === sequence.current) setError("Unable to load earlier changes. Please try again."); }
    finally { if (request === sequence.current) setLoading(false); }
  };
  const rows = history.flatMap((entry) => (
    entry.changes.map((change) => ({
      ...change,
      historyId: entry.id,
      changedBy: entry.changed_by_username || "Former user",
      changedAt: entry.changed_at,
    }))
  ));

  return (
    <section className={`panel ${className}`} aria-labelledby="customer-change-history-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
        <div>
          <h2 className="h5 mb-1" id="customer-change-history-heading">Change History</h2>
          <p className="text-secondary small mb-0">Previous and updated CRM values, with who made each change.</p>
        </div>
        {rows.length > 0 && <span className="badge text-bg-light">{rows.length} {rows.length === 1 ? "change" : "changes"} loaded</span>}
      </div>
      {rows.length === 0 ? (
        <p className="text-secondary mb-0">No CRM changes have been recorded yet.</p>
      ) : (
        <div className="table-responsive customer-change-history business-table">
          <table className="table table-hover align-middle mb-0 customer-change-table">
            <thead className="table-light">
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Before</th>
                <th scope="col">Updated</th>
                <th scope="col">Changed By</th>
                <th scope="col">Changed At</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.historyId}-${row.field}`}>
                  <th scope="row">{row.label}</th>
                  <td>{displayChangeValue(row.previous, row.field)}</td>
                  <td>{displayChangeValue(row.updated, row.field)}</td>
                  <td>{row.changedBy}</td>
                  <td><time dateTime={row.changedAt}>{formatDateTime(row.changedAt)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && <div className="alert alert-danger mt-3 mb-0" role="alert">{error}</div>}
      {cursor && datasetId && recordId && <button className="btn btn-outline-secondary mt-3" type="button" onClick={loadMore} disabled={loading}>{loading ? "Loading earlier changes..." : "Load earlier changes"}</button>}
    </section>
  );
}

function displayChangeValue(value, field) {
  if (!value) return <span className="text-secondary">Empty</span>;
  const displayValue = field === "callback_date" ? formatDate(value) : value;
  return <span className="text-break preserve-line-breaks">{displayValue}</span>;
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
