import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { salesApi } from "../services/api.js";
import { formatDate, formatCurrency } from "../utils/formatters.js";

export default function VisitDetail() {
  const { visitId } = useParams();
  const [visit, setVisit] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    salesApi.detail(visitId)
      .then((response) => setVisit(response.data))
      .catch(() => setError("Visit not found or you do not have permission to view it."));
  }, [visitId]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!visit) return <div className="panel">Loading visit...</div>;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/sales">Sales</Link></li>
          <li className="breadcrumb-item active">Visit Details</li>
        </ol>
      </nav>
      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Visit Details</h1>
          <p className="text-secondary mb-0">{visit.client_name} · {visit.dataset_name || "Manual Client"}</p>
        </div>
        <Link className="btn btn-outline-secondary" to="/sales">Back</Link>
      </div>
      <div className="row g-4 visit-detail-grid">
        <div className="col-lg-6">
          <section className="panel visit-detail-card h-100">
            <h2 className="h5 mb-3">Visit Information</h2>
            <Info label="Client" value={visit.client_name} />
            <Info label="Dataset" value={visit.dataset_name || "Manual Client"} />
            <Info label="Visit Date" value={formatDate(visit.visit_date)} />
            <Info label="Meeting Time" value={visit.meeting_time?.slice(0, 5)} />
            <Info label="Location" value={visit.location} />
            <Info label="Expense" value={formatCurrency(visit.expense)} />
            <Info label="Status" value={<span className={`badge-response visit-status-${visit.status}`}>{visit.status_label}</span>} />
            <Info label="Visit Note" value={visit.note || ""} note />
          </section>
        </div>
        <div className="col-lg-6">
          <section className="panel visit-detail-card h-100">
            <h2 className="h5 mb-3">{visit.manual_client ? "Manual Client Data" : "Imported Customer Data"}</h2>
            {(visit.customer_fields || []).map((row) => (
              <Info
                key={row.label}
                label={row.label === "Note" ? "Customer Note" : row.label}
                value={row.value}
                note={row.label === "Note"}
              />
            ))}
            <div className="visit-images-section mt-4 pt-3 border-top">
              <h3 className="h6 mb-3">Visit Images</h3>
              {visit.images?.length ? (
                <div className="visit-image-gallery">
                  {visit.images.map((image, index) => (
                    <a className="visit-image-item" href={image.url} target="_blank" rel="noreferrer" key={image.id}>
                      <img src={image.url} alt={image.original_name || `Visit image ${index + 1}`} />
                      <span>{image.original_name}</span>
                    </a>
                  ))}
                </div>
              ) : (
                <p className="text-secondary mb-0">No images have been added to this visit.</p>
              )}
            </div>
          </section>
        </div>
      </div>
      <div className="d-flex flex-wrap gap-2 mt-4">
        <Link className="btn btn-primary" to={`/sales/visits/${visit.id}/edit`}>Edit</Link>
        <Link className="btn btn-outline-danger" to={`/sales/visits/${visit.id}/delete`}>Delete</Link>
      </div>
    </>
  );
}

function Info({ label, value, note }) {
  return (
    <div className="visit-detail-row">
      <div className="visit-detail-label">{label}</div>
      <div className={`visit-detail-value ${note ? "visit-note-value" : ""}`}>{value}</div>
    </div>
  );
}
