import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { datasetsApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";
import TimedAlert from "../components/TimedAlert.jsx";

export default function DatasetDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    q: searchParams.get("q") || "",
    response: searchParams.get("response") || "",
  });

  const query = useMemo(
    () => ({
      q: searchParams.get("q") || "",
      response: searchParams.get("response") || "",
      page: searchParams.get("page") || "",
    }),
    [searchParams]
  );

  useEffect(() => {
    setForm({ q: query.q, response: query.response });
    setDetail(null);
    setError("");
    datasetsApi
      .detail(id, query)
      .then(({ data }) => setDetail(data))
      .catch((err) => {
        if (err.response?.status === 404) {
          setError("Dataset not found or you do not have permission to access it.");
        } else {
          setError("Unable to load this dataset.");
        }
      });
  }, [id, query]);

  const submitFilters = (event) => {
    event.preventDefault();
    const next = new URLSearchParams();
    if (form.q.trim()) next.set("q", form.q.trim());
    if (form.response) next.set("response", form.response);
    navigate({ pathname: `/datasets/${id}`, search: next.toString() });
  };

  const pageUrl = (page) => {
    const next = new URLSearchParams(searchParams);
    next.set("page", page);
    return `/datasets/${id}?${next.toString()}`;
  };

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading dataset...</div>;
  }

  const { dataset, responseStats, recordsBySheet, responseChoices, filters, pagination } = detail;
  const hasRecords = dataset.customer_count && filters.filteredCount;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item"><Link to="/datasets">Customer Lists</Link></li>
          <li className="breadcrumb-item active" aria-current="page">{dataset.name}</li>
        </ol>
      </nav>

      <TimedAlert message={location.state?.message} />

      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">{dataset.name}</h1>
          <p className="text-secondary mb-0">File: {dataset.original_filename}</p>
        </div>
        <div className="d-flex flex-wrap gap-2 action-bar">
          <a
            className="btn btn-success"
            href={datasetsApi.exportUrl(dataset.id, {
              q: searchParams.get("q") || "",
              response: searchParams.get("response") || "",
            })}
          >
            <i className="bi bi-download me-1" />Export
          </a>
          <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/rename`}>
            <i className="bi bi-pencil me-1" />Rename
          </Link>
          <Link className="btn btn-outline-danger" to={`/datasets/${dataset.id}/delete`}>
            <i className="bi bi-trash me-1" />Delete
          </Link>
          <Link className="btn btn-outline-secondary" to="/datasets">Back to Customer Lists</Link>
        </div>
      </div>

      <div className="row g-3 mb-4">
        <SummaryItem label="Customers" value={dataset.customer_count} valueClass="fs-4" />
        <SummaryItem label="Uploaded" value={formatDateTime(dataset.uploaded_at)} valueClass="fs-6" />
        <SummaryItem label="Updated" value={formatDateTime(dataset.updated_at)} valueClass="fs-6" />
      </div>

      <div className="row g-3 mb-4">
        {responseStats.map((stat) => (
          <div className="col-6 col-md-4 col-xl-2" key={stat.value}>
            <div className="summary-card compact">
              <div className="text-secondary small">{stat.label}</div>
              <div className="fs-5">{stat.count}</div>
            </div>
          </div>
        ))}
      </div>

      <form className="panel mb-4" onSubmit={submitFilters}>
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
          <h2 className="h5 mb-0">Find Customers</h2>
          {filters.active && <span className="badge text-bg-primary">Filters active</span>}
        </div>
        <div className="row g-3 align-items-end">
          <div className="col-lg-6">
            <label className="form-label" htmlFor="customer-search">Search customers</label>
            <div className="input-group">
              <span className="input-group-text"><i className="bi bi-search" /></span>
              <input
                className="form-control"
                id="customer-search"
                name="q"
                type="search"
                value={form.q}
                placeholder="Search customers..."
                onChange={(event) => setForm({ ...form, q: event.target.value })}
              />
            </div>
          </div>
          <div className="col-sm-6 col-lg-3">
            <label className="form-label" htmlFor="response-filter">Response</label>
            <select
              className="form-select"
              id="response-filter"
              name="response"
              value={form.response}
              onChange={(event) => setForm({ ...form, response: event.target.value })}
            >
              <option value="">All</option>
              {responseChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
          </div>
          <div className="col-sm-6 col-lg-3 d-flex gap-2">
            <button className="btn btn-primary flex-fill" type="submit">Apply</button>
            <Link className="btn btn-outline-secondary flex-fill" to={`/datasets/${dataset.id}`}>Clear</Link>
          </div>
        </div>
      </form>

      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4">
        {filters.active ? (
          <p className="text-secondary mb-0">Showing {filters.filteredCount} of {dataset.customer_count} customers.</p>
        ) : (
          <p className="text-secondary mb-0">Total Customers: {dataset.customer_count}</p>
        )}
      </div>

      <section>
        <h2 className="h4 mb-3">Customer Records</h2>
        {hasRecords ? (
          <>
            {recordsBySheet.map((sheet) => (
              sheet.records.length ? <SheetTable key={sheet.sheetName} dataset={dataset} sheet={sheet} /> : null
            ))}
            {pagination.numPages > 1 && (
              <nav aria-label="Customer pagination">
                <ul className="pagination flex-wrap">
                  <PageItem disabled={!pagination.hasPrevious} to={pagination.hasPrevious ? pageUrl(pagination.previousPage) : ""}>
                    Previous
                  </PageItem>
                  {pagination.pageRange.map((page) => (
                    <li className={`page-item${pagination.page === page ? " active" : ""}`} key={page}>
                      <Link className="page-link" to={pageUrl(page)}>{page}</Link>
                    </li>
                  ))}
                  <PageItem disabled={!pagination.hasNext} to={pagination.hasNext ? pageUrl(pagination.nextPage) : ""}>
                    Next
                  </PageItem>
                </ul>
              </nav>
            )}
          </>
        ) : (
          <EmptyCustomers dataset={dataset} filters={filters} />
        )}
      </section>
    </>
  );
}

function SummaryItem({ label, value, valueClass }) {
  return (
    <div className="col-sm-4">
      <div className="summary-card compact">
        <div className="text-secondary small">{label}</div>
        <div className={valueClass}>{value}</div>
      </div>
    </div>
  );
}

function SheetTable({ dataset, sheet }) {
  return (
    <div className="panel p-0 mb-4">
      <div className="table-panel-header">
        <div>
          <h3 className="h5 mb-1">{sheet.sheetName}</h3>
          <p className="text-secondary small mb-0">Original Excel columns first, CRM fields last.</p>
        </div>
      </div>
      <div className="table-responsive customer-table-wrapper">
        <table className="table table-sm table-hover align-middle crm-table mb-0">
          <thead className="table-light">
            <tr>
              {sheet.columns.map((column) => (
                <th className="excel-column" scope="col" key={column.id}>{column.originalName}</th>
              ))}
              <th className="crm-column response-cell" scope="col">Response</th>
              <th className="crm-column note-cell" scope="col">Note</th>
              <th className="crm-column actions-cell" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sheet.records.map((item) => (
              <tr key={item.record.id}>
                {item.values.map((value, index) => (
                  <td key={`${item.record.id}-${sheet.columns[index]?.fieldKey || index}`}>{value}</td>
                ))}
                <td className="response-cell">
                  <span className={`badge-response response-${item.record.response}`}>{item.record.response_label}</span>
                </td>
                <td className="note-cell">{item.record.note || ""}</td>
                <td className="actions-cell">
                  <div className="btn-group btn-group-sm table-actions" role="group" aria-label="Customer actions">
                    <Link className="btn btn-outline-primary" to={`/datasets/${dataset.id}/customers/${item.record.id}`}>
                      <i className="bi bi-eye me-1" />View/Edit
                    </Link>
                    <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${item.record.id}/edit`}>
                      <i className="bi bi-pencil me-1" />Edit
                    </Link>
                    <Link className="btn btn-outline-danger" to={`/datasets/${dataset.id}/customers/${item.record.id}/delete`}>
                      <i className="bi bi-trash me-1" />Delete
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PageItem({ disabled, to, children }) {
  if (disabled) {
    return <li className="page-item disabled"><span className="page-link">{children}</span></li>;
  }
  return <li className="page-item"><Link className="page-link" to={to}>{children}</Link></li>;
}

function EmptyCustomers({ dataset, filters }) {
  if (!dataset.customer_count) {
    return <div className="empty-state"><p className="mb-0">No customer records were found in this file.</p></div>;
  }

  let message = "No customers found.";
  if (filters.search && filters.response) {
    message = "No customers found matching your search and response filter.";
  } else if (filters.search) {
    message = "No customers found matching your search.";
  } else if (filters.response) {
    message = "No customers found with this response.";
  }

  return <div className="empty-state"><p className="mb-0">{message}</p></div>;
}
