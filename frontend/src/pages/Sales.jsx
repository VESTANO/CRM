import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { peekCachedResponse, salesApi } from "../services/api.js";
import { formatDate, formatCurrency } from "../utils/formatters.js";
import { salesRequestParams } from "../utils/sales.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";
import "../styles/mobile-business.css";

const statuses = [
  ["healthy", "Healthy"],
  ["follow_up_required", "Follow-up Required"],
  ["interested", "Interested"],
  ["not_interested", "Not Interested"],
  ["converted", "Converted"],
];

const paymentStatuses = [
  ["not_paid", "Not Paid"],
  ["partially_paid", "Partially Paid"],
  ["completed", "Completed"],
  ["one_time", "One-time Payment"],
];

export default function Sales() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKey = searchParams.toString();
  const [filters, setFilters] = useState(() => ({
    q: searchParams.get("q") || "",
    dataset_name: searchParams.get("dataset_name") || "",
    status: searchParams.get("status") || "",
    payment_status: searchParams.get("payment_status") || "",
    date_from: searchParams.get("date_from") || "",
    date_to: searchParams.get("date_to") || "",
  }));
  const [visits, setVisits] = useState(() => (
    peekCachedResponse("/sales/visits/", {
      params: salesRequestParams(Object.fromEntries(new URLSearchParams(filterKey).entries())),
    })?.data?.results || null
  ));
  const [summary, setSummary] = useState(() => peekCachedResponse("/sales/summary/")?.data || null);
  const [error, setError] = useState("");
  const [pagination, setPagination] = useState(() => peekCachedResponse("/sales/visits/", { params: salesRequestParams(Object.fromEntries(new URLSearchParams(filterKey).entries())) })?.data?.pagination || { page: 1, numPages: 1, count: 0 });
  const requestSequence = useRef(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const loadVisits = useCallback(() => {
    const sequence = ++requestSequence.current;
    const params = new URLSearchParams(filterKey);
    setFilters({
      q: params.get("q") || "",
      dataset_name: params.get("dataset_name") || "",
      status: params.get("status") || "",
      payment_status: params.get("payment_status") || "",
      date_from: params.get("date_from") || "",
      date_to: params.get("date_to") || "",
    });
    setIsRefreshing(Boolean(visits));
    setError("");
    salesApi.list(Object.fromEntries(params.entries()))
      .then((response) => { if (sequence === requestSequence.current) { setVisits(response.data.results); setPagination(response.data.pagination || { page: 1, numPages: 1, count: response.data.results.length }); } })
      .catch(() => { if (sequence === requestSequence.current) setError("Unable to load client visits."); })
      .finally(() => { if (sequence === requestSequence.current) setIsRefreshing(false); });
  }, [filterKey]);

  useEffect(() => { loadVisits(); return () => { requestSequence.current += 1; }; }, [loadVisits]);

  useEffect(() => {
    salesApi.summary()
      .then((response) => setSummary(response.data))
      .catch(() => setError("Unable to load client visits."));
  }, []);

  const changeFilter = (event) => {
    setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const updateFilters = (nextFilters) => {
    const params = new URLSearchParams();
    Object.entries(nextFilters).forEach(([key, value]) => {
      if (value.trim()) params.set(key, value.trim());
    });
    setSearchParams(params);
  };

  const changeSelectFilter = (event) => {
    const nextFilters = { ...filters, [event.target.name]: event.target.value };
    setFilters(nextFilters);
    updateFilters(nextFilters);
  };

  const applyFilters = (event) => {
    event.preventDefault();
    updateFilters(filters);
  };

  const filtersActive = [...searchParams.keys()].some((key) => key !== "page");
  const { page, numPages: pageCount, count: visitCount } = pagination;
  const visibleVisits = visits || [];
  const changePage = (nextPage) => { const params = new URLSearchParams(filterKey); if (nextPage > 1) params.set("page", nextPage); else params.delete("page"); setSearchParams(params); };
  if (error && !visits) return <RequestError message={error} onRetry={loadVisits} />;
  if (!visits) return <LoadingPanel label="Loading client visits" />;

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active">Sales</li></ol></nav>
    <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4"><div><div className="eyebrow">Sales</div><h1 className="h2 mb-2">Client Visits</h1><p className="text-secondary mb-0">Manage client visits for customers in accessible datasets.</p></div><Link className="btn btn-primary" to="/sales/visits/add"><i className="bi bi-plus-lg me-1" />Add Client Visit</Link></div>
    {error && <div className="alert alert-danger" role="alert">{error} Showing the last loaded visits.</div>}
    {summary && <div className="metric-grid mb-4">{[["Total Visits", summary.totalVisits, "bi-calendar2-check"],["Today's Visits", summary.todaysVisits, "bi-calendar-day"],["This Month", summary.monthVisits, "bi-calendar3"],["Visit Expenses", formatCurrency(summary.totalVisitExpenses), "bi-cash-stack"]].map(([label,value,icon]) => <div className={`summary-card ${label === "Visit Expenses" ? "sales-expense-card" : ""}`} key={label}><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className={`summary-value ${label === "Visit Expenses" ? "summary-value-currency" : ""}`}><AnimatedNumber value={value} /></div></div>)}</div>}

    <form className="panel mb-4" aria-label="Sales filters" onSubmit={applyFilters}>
      <div className="row g-3 align-items-end">
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-client-name-filter">Client Name</label><input className="form-control" id="visit-client-name-filter" type="search" name="q" value={filters.q} onChange={changeFilter} placeholder="Search by client name..." /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-dataset-name-filter">Dataset Name</label><input className="form-control" id="visit-dataset-name-filter" type="search" name="dataset_name" value={filters.dataset_name} onChange={changeFilter} placeholder="Search by dataset name..." /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-status-filter">Status</label><select className="form-select" id="visit-status-filter" name="status" value={filters.status} onChange={changeSelectFilter}><option value="">All statuses</option>{statuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-payment-status-filter">Payment Status</label><select className="form-select" id="visit-payment-status-filter" name="payment_status" value={filters.payment_status} onChange={changeSelectFilter} aria-describedby="visit-payment-filter-help"><option value="">All payment statuses</option>{paymentStatuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-date-from">From date</label><input className="form-control" id="visit-date-from" type="date" name="date_from" value={filters.date_from} onChange={changeFilter} /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-date-to">To date</label><input className="form-control" id="visit-date-to" type="date" name="date_to" value={filters.date_to} onChange={changeFilter} /></div>
        <div className="col-12 d-flex flex-wrap gap-2"><button className="btn btn-primary" type="submit">Filter</button>{filtersActive && <Link className="btn btn-outline-secondary" to="/sales">Clear</Link>}</div>
      </div>
      <p className="text-secondary small mb-0 mt-3" id="visit-payment-filter-help">Payment status filters apply to converted visits.</p>
      {filtersActive && <p className="text-secondary small mb-0 mt-3" role="status">Showing <AnimatedNumber value={visitCount} /> matching visits.</p>}
    </form>

    {isRefreshing && <div className="customer-directory-refresh mb-3" role="status"><span className="spinner-border spinner-border-sm" aria-hidden="true" /> Updating visits</div>}

    {visibleVisits.length ? <>
      <div className="table-responsive panel p-0 responsive-table business-table"><table className="table table-hover align-middle mb-0 sales-visits-table"><thead className="table-light"><tr>{["Client","Employee","Dataset / Source","Visit Date","Meeting Time","Meeting Location","Expense","Status","Payment status","Payment details","Payment description","Note","Actions"].map((heading)=><th key={heading}>{heading}</th>)}</tr></thead><tbody>{visibleVisits.map((visit)=><tr key={visit.id}><td data-label="Client">{visit.client_name}</td><td data-label="Employee"><strong>{visit.employee_name || "—"}</strong>{visit.employee_id && <div className="small text-secondary">{visit.employee_id}</div>}</td><td data-label="Dataset / Source">{visit.dataset_name || <span className="badge-response response-callback">Manual Client</span>}</td><td data-label="Visit Date">{formatDate(visit.visit_date)}</td><td data-label="Meeting Time">{visit.meeting_time?.slice(0,5)}</td><td data-label="Meeting Location">{visit.location}</td><td data-label="Expense">{formatCurrency(visit.expense)}</td><td data-label="Status"><span className={`badge-response visit-status-${visit.status}`}>{visit.status_label}</span></td><td data-label="Payment status">{visit.status === "converted" ? <span className={`badge-response payment-${visit.payment_status}`}>{visit.payment_status_label}</span> : <span className="payment-unavailable text-secondary">—</span>}</td><td data-label="Payment details">{visit.status === "converted" ? <div className="payment-summary"><small>Total: {formatCurrency(visit.total_amount)}</small><small>Paid: {formatCurrency(visit.paid_amount)}</small><small>Pending: {formatCurrency(visit.pending_amount)}</small></div> : <span className="payment-unavailable text-secondary">—</span>}</td><td data-label="Payment description">{visit.status === "converted" ? (visit.payment_description || "—") : "—"}</td><td data-label="Note" className="note-cell"><span className="sales-note-value">{visit.note || ""}</span></td><td data-label="Actions"><div className="btn-group btn-group-sm sales-actions" role="group" aria-label="Visit actions"><Link className="btn btn-outline-primary" to={`/sales/visits/${visit.id}`}>View</Link><Link className="btn btn-outline-secondary" to={`/sales/visits/${visit.id}/edit`}>Edit</Link><Link className="btn btn-outline-danger" to={`/sales/visits/${visit.id}/delete`}>Delete</Link></div></td></tr>)}</tbody></table></div>
      {pageCount > 1 && <div className="d-flex justify-content-between align-items-center mt-3"><span className="text-secondary small">Page {page} of {pageCount}</span><div className="d-flex gap-2"><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => changePage(page - 1)} disabled={isRefreshing || page <= 1}>Previous</button><button className="btn btn-outline-primary btn-sm" type="button" onClick={() => changePage(page + 1)} disabled={isRefreshing || page >= pageCount}>Next</button></div></div>}
    </> : <div className="empty-state text-center">{filtersActive ? <><h2 className="h5">No visits match these filters</h2><p className="text-secondary">Try changing the client name, dataset name, status, payment status, or date range.</p><Link className="btn btn-outline-secondary" to="/sales">Clear filters</Link></> : <><h2 className="h5">No client visits yet</h2><p className="text-secondary">Create your first client visit.</p><Link className="btn btn-primary" to="/sales/visits/add">Add Client Visit</Link></>}</div>}
  </>;
}
