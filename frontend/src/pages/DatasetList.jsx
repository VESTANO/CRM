import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { datasetsApi, peekCachedResponse, targetsApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDateTime } from "../utils/formatters.js";
import { filterDatasets } from "../utils/datasets.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";
import "../styles/mobile-business.css";

export default function DatasetList() {
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const datasetName = searchParams.get("name") || "";
  const dateFrom = searchParams.get("date_from") || "";
  const dateTo = searchParams.get("date_to") || "";
  const [filters, setFilters] = useState({ name: datasetName, date_from: dateFrom, date_to: dateTo });
  const [datasets, setDatasets] = useState(() => peekCachedResponse("/datasets/")?.data?.results || null);
  const [targets, setTargets] = useState(() => peekCachedResponse("/targets/")?.data?.results || null);
  const [error, setError] = useState("");
  const [targetsError, setTargetsError] = useState("");
  const [page, setPage] = useState(1);
  const showOwner = Boolean(user?.is_admin);
  const filteredDatasets = useMemo(() => filterDatasets(datasets || [], {
    name: datasetName, date_from: dateFrom, date_to: dateTo,
  }), [datasets, datasetName, dateFrom, dateTo]);
  const filtersActive = Boolean(datasetName || dateFrom || dateTo);
  const invalidDateRange = Boolean(filters.date_from && filters.date_to && filters.date_from > filters.date_to);
  const pageCount = Math.ceil(filteredDatasets.length / 5);
  const currentPage = Math.min(page, Math.max(pageCount, 1));
  const visibleDatasets = filteredDatasets.slice((currentPage - 1) * 5, currentPage * 5);

  const load = useCallback(() => {
    setError("");
    setTargetsError("");
    const lists = datasetsApi.list()
      .then(({ data }) => setDatasets(data.results))
      .catch(() => setError("Unable to load customer lists."));
    const monthlyTargets = targetsApi.list()
      .then(({ data }) => setTargets(data.results))
      .catch(() => setTargetsError("Unable to load monthly targets."));
    return Promise.allSettled([lists, monthlyTargets]);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    setFilters({ name: datasetName, date_from: dateFrom, date_to: dateTo });
    setPage(1);
  }, [datasetName, dateFrom, dateTo]);

  const changeFilter = (event) => {
    setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const applyFilters = (event) => {
    event.preventDefault();
    if (invalidDateRange) return;
    const params = new URLSearchParams(searchParams);
    Object.entries(filters).forEach(([key, value]) => {
      if (value.trim()) params.set(key, value.trim());
      else params.delete(key);
    });
    params.delete("page");
    setPage(1);
    setSearchParams(params);
  };

  const clearFilters = () => {
    const params = new URLSearchParams(searchParams);
    ["name", "date_from", "date_to", "page"].forEach((key) => params.delete(key));
    setFilters({ name: "", date_from: "", date_to: "" });
    setPage(1);
    setSearchParams(params);
  };

  if (error && datasets === null) {
    return <RequestError message={error} onRetry={load} />;
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

      {error && <div className="alert alert-warning" role="status">{error} Showing the most recent available customer lists.</div>}
      {targetsError && <div className="alert alert-warning" role="alert">{targetsError} <button className="btn btn-outline-secondary btn-sm ms-2" type="button" onClick={load}>Retry</button></div>}

      {targets?.length > 0 && (
        <section className="panel mb-4">
          <h2 className="h5 mb-1">Monthly Targets</h2>
          <p className="text-secondary small mb-3">Targets are based on converted sales visits for each assigned month.</p>
          <div className="d-grid gap-3">
            {targets.map((target) => (
              <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 border-top pt-3" key={target.id}>
                <div>
                  <div className="fw-semibold">{target.monthLabel}</div>
                  <div className="text-secondary small">{target.converted} of {target.target} converted ({target.percentage}%)</div>
                </div>
                <div className="d-flex flex-wrap gap-2">
                  <span className={`badge text-bg-${target.statusColor}`}>Target: <AnimatedNumber value={target.target} /></span>
                  <span className="badge text-bg-success">Converted: <AnimatedNumber value={target.converted} /></span>
                  <span className={`badge text-bg-${target.target - target.converted > 0 ? "warning" : "success"}`}>
                    Remaining: <AnimatedNumber value={Math.max(target.target - target.converted, 0)} />
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {targets?.length === 0 && datasets !== null && (
        <section className="panel mb-4">
          <div className="d-flex flex-wrap justify-content-between align-items-center gap-3">
            <div>
              <h2 className="h5 mb-1">Monthly Targets</h2>
              <p className="text-secondary small mb-0">No monthly targets have been assigned yet.</p>
            </div>
          </div>
        </section>
      )}

      <form className="panel mb-4" aria-labelledby="dataset-filters-heading" onSubmit={applyFilters}>
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-3">
          <div>
            <h2 className="h5 mb-1" id="dataset-filters-heading">Filter Datasets</h2>
            <p className="text-secondary small mb-0">Filter by upload date and dataset name.</p>
          </div>
          <div className="d-flex flex-wrap gap-4">
            <button className="btn btn-primary" type="submit" disabled={invalidDateRange}>Filter</button>
            <button className="btn btn-outline-secondary" type="button" onClick={clearFilters}>Clear</button>
          </div>
        </div>
        <div className="row g-3 align-items-end">
          <div className="col-sm-12 col-lg-4">
            <label className="form-label" htmlFor="dataset-name-filter">Dataset Name</label>
            <input className="form-control" id="dataset-name-filter" type="search" name="name" value={filters.name} onChange={changeFilter} placeholder="Search dataset names..." />
          </div>
          <div className="col-sm-6 col-lg-4">
            <label className="form-label" htmlFor="dataset-date-from">From Date</label>
            <input className="form-control" id="dataset-date-from" type="date" name="date_from" value={filters.date_from} max={filters.date_to || undefined} onChange={changeFilter} aria-invalid={invalidDateRange || undefined} aria-describedby={invalidDateRange ? "dataset-filter-date-error" : undefined} />
          </div>
          <div className="col-sm-6 col-lg-4">
            <label className="form-label" htmlFor="dataset-date-to">To Date</label>
            <input className="form-control" id="dataset-date-to" type="date" name="date_to" value={filters.date_to} min={filters.date_from || undefined} onChange={changeFilter} aria-invalid={invalidDateRange || undefined} aria-describedby={invalidDateRange ? "dataset-filter-date-error" : undefined} />
          </div>
        </div>
        {invalidDateRange && <p className="text-danger small mb-0 mt-3" id="dataset-filter-date-error" role="alert">From Date must be on or before To Date.</p>}
        {datasets !== null && <p className="text-secondary small mb-0 mt-3" role="status">Showing {filteredDatasets.length} of {datasets.length} datasets.</p>}
      </form>

      {datasets === null ? (
        <LoadingPanel label="Loading customer lists" />
      ) : filteredDatasets.length ? (
        <>
          <div className="table-responsive panel p-0 responsive-table business-table">
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
                    <td data-label="Customers"><span className="badge text-bg-light"><AnimatedNumber value={dataset.customer_count} /></span></td>
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
        </>
      ) : filtersActive && datasets.length > 0 ? (
        <div className="empty-state">
          <h2 className="h5">No matching datasets</h2>
          <p className="text-secondary mb-3">Try a different dataset name or upload date range.</p>
          <button className="btn btn-outline-primary" type="button" onClick={clearFilters}>Clear Filters</button>
        </div>
      ) : (
        <div className="empty-state">
          <p className="mb-3">No customer datasets have been created yet.</p>
          <Link className="btn btn-primary" to="/import">Import Excel</Link>
        </div>
      )}
      {filteredDatasets.length > 5 && (
        <div className="d-flex justify-content-between align-items-center mt-3">
          <span className="text-secondary small">Page {currentPage} of {pageCount}</span>
          <div className="d-flex gap-2">
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>Previous</button>
            <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pageCount}>Next</button>
          </div>
        </div>
      )}
    </>
  );
}
