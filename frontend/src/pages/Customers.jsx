import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { customersApi, peekCachedResponse } from "../services/api.js";
import { formatDate } from "../utils/formatters.js";

const CLIENT_NAME_LABELS = new Set([
  "name",
  "customer",
  "customername",
  "client",
  "clientname",
  "fullname",
  "contactname",
  "companyname",
]);

const RESERVED_CUSTOMER_COLUMNS = new Set(["note", "status", "callbackdate", "actions", "dataset"]);

function normalizeColumnLabel(label) {
  return String(label || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isClientNameLabel(label) {
  return CLIENT_NAME_LABELS.has(label.toLowerCase().replace(/[^a-z0-9]/g, ""));
}


export default function Customers() {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(Number(searchParams.get("page")) || 1, 1);
  const status = searchParams.get("status") || "";
  const query = searchParams.get("q") || "";
  const [searchText, setSearchText] = useState(query);
  const [data, setData] = useState(() => peekCachedResponse("/customers/", {
    params: { page, status: status || undefined, q: query || undefined },
  })?.data || null);
  const [error, setError] = useState("");
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    let active = true;
    // Keep the current directory on screen while a filter or page change is
    // being requested. Clearing it here caused the whole view to flash back
    // to its loading state whenever a status tab was selected.
    setIsRefreshing(Boolean(data));
    setError("");
    customersApi.list({ page, status: status || undefined, q: query || undefined })
      .then(({ data: responseData }) => {
        if (active) setData(responseData);
      })
      .catch(() => {
        if (active) setError("Unable to load customers.");
      })
      .finally(() => {
        if (active) setIsRefreshing(false);
      });
    return () => { active = false; };
  }, [page, status, query]);

  useEffect(() => {
    setSearchText(query);
  }, [query]);

  const goToPage = (nextPage) => {
    const params = {};
    if (status) params.status = status;
    if (query) params.q = query;
    if (nextPage > 1) params.page = String(nextPage);
    setSearchParams(params);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const selectStatus = (nextStatus) => {
    const params = {};
    if (nextStatus) params.status = nextStatus;
    if (query) params.q = query;
    setSearchParams(params);
  };

  const submitSearch = (event) => {
    event.preventDefault();
    const params = {};
    const trimmedSearch = searchText.trim();
    if (status) params.status = status;
    if (trimmedSearch) params.q = trimmedSearch;
    setSearchParams(params);
  };

  const clearSearch = () => {
    setSearchText("");
    setSearchParams(status ? { status } : {});
  };

  const results = data?.results || [];
  const pagination = data?.pagination;
  // Use the URL immediately, while the previous table remains visible during
  // the background request for the newly selected filter.
  const selectedStatus = status;
  const detailColumns = Array.from(new Map(
    results.flatMap(({ fieldRows }) => fieldRows.map((field) => field.label))
      .filter((label) => !isClientNameLabel(label) && !RESERVED_CUSTOMER_COLUMNS.has(normalizeColumnLabel(label)))
      .map((label) => [normalizeColumnLabel(label), label]),
  ).values());

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Customers</li>
        </ol>
      </nav>
      <div className="page-header mb-4">
        <div className="eyebrow">CUSTOMERS</div>
        <h1 className="h2 mb-2">All Customers</h1>
        <p className="text-secondary mb-0">
          Customer details from every accessible dataset, with 50 customers per page.
        </p>
      </div>

      {error && <div className="alert alert-danger" role="alert">{error} {data && "Showing the last loaded customer list."}</div>}

      {!data ? (
        <div className="panel">Loading customers...</div>
      ) : (
        <>
          <form className="panel customer-name-search mb-3" role="search" onSubmit={submitSearch}>
            <label className="form-label fw-semibold" htmlFor="customer-name-search">Search by client name</label>
            <div className="d-flex flex-column flex-sm-row gap-2">
              <div className="input-group flex-grow-1">
                <span className="input-group-text"><i className="bi bi-search" aria-hidden="true" /></span>
                <input
                  className="form-control"
                  id="customer-name-search"
                  type="search"
                  value={searchText}
                  placeholder="Enter a client name..."
                  onChange={(event) => setSearchText(event.target.value)}
                />
              </div>
              <button className="btn btn-primary" type="submit">Search</button>
              {query && <button className="btn btn-outline-secondary" type="button" onClick={clearSearch}>Clear</button>}
            </div>
          </form>
          <nav className="customer-status-tabs mb-3" aria-label="Filter customers by status">
            <button
              className={`customer-status-tab${selectedStatus === "" ? " active" : ""}`}
              type="button"
              aria-pressed={selectedStatus === ""}
              onClick={() => selectStatus("")}
            >
              <span>All</span><span className="customer-status-count">{data.totalCount}</span>
            </button>
            {data.statusOptions.map((option) => (
              <button
                className={`customer-status-tab${selectedStatus === option.value ? " active" : ""}`}
                type="button"
                aria-pressed={selectedStatus === option.value}
                key={option.value}
                onClick={() => selectStatus(option.value)}
              >
                <span>{option.label}</span><span className="customer-status-count">{option.count}</span>
              </button>
            ))}
          </nav>
          <div className="d-flex justify-content-between align-items-center gap-3 mb-3">
            <span className="text-secondary small">
              {pagination.count} {query ? `customers matching “${data.searchQuery}”` : "customers"}
            </span>
            <div className="d-flex align-items-center gap-2">
              {isRefreshing && <span className="customer-directory-refresh" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" /> Updating</span>}
              <span className="badge text-bg-light">Page {pagination.page} of {pagination.numPages}</span>
            </div>
          </div>
          {results.length ? <><div className="table-responsive panel p-0 customer-directory-table">
            <table className="table table-hover align-middle mb-0">
              <thead className="table-light">
                <tr>
                  <th scope="col">Client Name</th>
                  <th scope="col">Dataset</th>
                  {detailColumns.map((label) => <th scope="col" key={label}>{label}</th>)}
                  <th scope="col">Status</th>
                  <th scope="col">Callback Date</th>
                  <th scope="col">Note</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {results.map(({ record, datasetId, datasetName, fieldRows }) => (
                  <tr key={record.id}>
                    <td data-label="Client Name" className="fw-semibold">{record.display_name}</td>
                    <td data-label="Dataset">{datasetName}<div className="text-secondary small">{record.sheet_name} · Row {record.row_number}</div></td>
                    {detailColumns.map((label) => {
                      const field = fieldRows.find((item) => item.label === label);
                      return <td data-label={label} key={label}>{field?.value || "—"}</td>;
                    })}
                    <td data-label="Status"><span className={`badge-response response-${record.response}`}>{record.response_label}</span></td>
                    <td data-label="Callback Date">{record.callback_date ? formatDate(record.callback_date) : "—"}</td>
                    <td data-label="Note" className="note-cell"><span className="sales-note-value">{record.note || "—"}</span></td>
                    <td data-label="Actions">
                      <div className="btn-group btn-group-sm" role="group" aria-label={`Actions for ${record.display_name}`}>
                        <Link className="btn btn-outline-primary" to={`/datasets/${datasetId}/customers/${record.id}`}>View</Link>
                        <Link className="btn btn-outline-secondary" to={`/datasets/${datasetId}/customers/${record.id}/edit`}>Edit</Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pagination.numPages > 1 && (
            <nav className="d-flex justify-content-between align-items-center gap-3 mt-3" aria-label="Customer pagination">
              <button className="btn btn-outline-secondary" type="button" disabled={!pagination.hasPrevious} onClick={() => goToPage(pagination.previousPage)}>Previous</button>
              <span className="text-secondary small">Showing up to 50 customers per page</span>
              <button className="btn btn-outline-primary" type="button" disabled={!pagination.hasNext} onClick={() => goToPage(pagination.nextPage)}>Next</button>
            </nav>
          )}</> : (
            <div className="empty-state text-center">
              <h2 className="h5">No customers found</h2>
              <p className="text-secondary mb-0">There are no customers with this status.</p>
            </div>
          )}
        </>
      )}
    </>
  );
}
