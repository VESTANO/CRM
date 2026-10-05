import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { salesApi } from "../services/api.js";
import { formatDate, formatCurrency } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";

const statuses = [
  ["healthy", "Healthy"],
  ["follow_up_required", "Follow-up Required"],
  ["interested", "Interested"],
  ["not_interested", "Not Interested"],
  ["converted", "Converted"],
];

export default function Sales() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filterKey = searchParams.toString();
  const [filters, setFilters] = useState({ status: "", date_from: "", date_to: "" });
  const [visits, setVisits] = useState(null);
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => {
    const params = new URLSearchParams(filterKey);
    setFilters({
      status: params.get("status") || "",
      date_from: params.get("date_from") || "",
      date_to: params.get("date_to") || "",
    });
    setVisits(null);
    setPage(1);
    setError("");
    salesApi.list(Object.fromEntries(params.entries()))
      .then((response) => setVisits(response.data.results))
      .catch(() => setError("Unable to load client visits."));
  }, [filterKey]);

  useEffect(() => {
    salesApi.summary()
      .then((response) => setSummary(response.data))
      .catch(() => setError("Unable to load client visits."));
  }, []);

  const changeFilter = (event) => {
    setFilters((current) => ({ ...current, [event.target.name]: event.target.value }));
  };

  const applyFilters = (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    setPage(1);
    setSearchParams(params);
  };

  const filtersActive = Boolean(filterKey);
  const pageCount = Math.ceil((visits?.length || 0) / 5);
  const visibleVisits = visits?.slice((page - 1) * 5, page * 5) || [];
  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!visits) return <div className="panel">Loading client visits...</div>;

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active">Sales</li></ol></nav>
    <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4"><div><div className="eyebrow">Sales</div><h1 className="h2 mb-2">Client Visits</h1><p className="text-secondary mb-0">Manage client visits for customers in accessible datasets.</p></div><Link className="btn btn-primary" to="/sales/visits/add"><i className="bi bi-plus-lg me-1" />Add Client Visit</Link></div>
    {summary && <div className="metric-grid mb-4">{[["Total Visits", summary.totalVisits, "bi-calendar2-check"],["Today's Visits", summary.todaysVisits, "bi-calendar-day"],["This Month", summary.monthVisits, "bi-calendar3"],["Visit Expenses", formatCurrency(summary.totalVisitExpenses), "bi-cash-stack"]].map(([label,value,icon]) => <div className="summary-card" key={label}><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className={`summary-value ${label === "Visit Expenses" ? "summary-value-currency" : ""}`}><AnimatedNumber value={value} /></div></div>)}</div>}

    <form className="panel mb-4" onSubmit={applyFilters}>
      <div className="row g-3 align-items-end">
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="visit-status-filter">Status</label><select className="form-select" id="visit-status-filter" name="status" value={filters.status} onChange={changeFilter}><option value="">All statuses</option>{statuses.map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></div>
        <div className="col-sm-6 col-lg-3"><label className="form-label" htmlFor="visit-date-from">From date</label><input className="form-control" id="visit-date-from" type="date" name="date_from" value={filters.date_from} onChange={changeFilter} /></div>
        <div className="col-sm-6 col-lg-3"><label className="form-label" htmlFor="visit-date-to">To date</label><input className="form-control" id="visit-date-to" type="date" name="date_to" value={filters.date_to} onChange={changeFilter} /></div>
        <div className="col-sm-6 col-lg-2 d-flex gap-2"><button className="btn btn-primary" type="submit">Filter</button>{filtersActive && <Link className="btn btn-outline-secondary" to="/sales">Clear</Link>}</div>
      </div>
      {filtersActive && <p className="text-secondary small mb-0 mt-3">Showing <AnimatedNumber value={visits.length} /> matching visits.</p>}
    </form>

    {visits.length ? <>
      <div className="table-responsive panel p-0 responsive-table"><table className="table table-hover align-middle mb-0 sales-visits-table"><thead className="table-light"><tr>{["Client","Dataset / Source","Visit Date","Meeting Time","Location","Expense","Status","Note","Actions"].map((heading)=><th key={heading}>{heading}</th>)}</tr></thead><tbody>{visibleVisits.map((visit)=><tr key={visit.id}><td data-label="Client">{visit.client_name}</td><td data-label="Dataset / Source">{visit.dataset_name || <span className="badge-response response-callback">Manual Client</span>}</td><td data-label="Visit Date">{formatDate(visit.visit_date)}</td><td data-label="Meeting Time">{visit.meeting_time?.slice(0,5)}</td><td data-label="Location">{visit.location}</td><td data-label="Expense">{formatCurrency(visit.expense)}</td><td data-label="Status"><span className={`badge-response visit-status-${visit.status}`}>{visit.status_label}</span></td><td data-label="Note" className="note-cell"><span className="sales-note-value">{visit.note || ""}</span></td><td data-label="Actions"><div className="btn-group btn-group-sm sales-actions" role="group" aria-label="Visit actions"><Link className="btn btn-outline-primary" to={`/sales/visits/${visit.id}`}>View</Link><Link className="btn btn-outline-secondary" to={`/sales/visits/${visit.id}/edit`}>Edit</Link><Link className="btn btn-outline-danger" to={`/sales/visits/${visit.id}/delete`}>Delete</Link></div></td></tr>)}</tbody></table></div>
      {pageCount > 1 && <div className="d-flex justify-content-between align-items-center mt-3"><span className="text-secondary small">Page {page} of {pageCount}</span><div className="d-flex gap-2"><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>Previous</button><button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setPage((current) => current + 1)} disabled={page >= pageCount}>Next</button></div></div>}
    </> : <div className="empty-state text-center">{filtersActive ? <><h2 className="h5">No visits match these filters</h2><p className="text-secondary">Try changing the status or date range.</p><Link className="btn btn-outline-secondary" to="/sales">Clear filters</Link></> : <><h2 className="h5">No client visits yet</h2><p className="text-secondary">Create your first client visit.</p><Link className="btn btn-primary" to="/sales/visits/add">Add Client Visit</Link></>}</div>}
  </>;
}
