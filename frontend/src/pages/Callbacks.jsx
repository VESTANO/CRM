import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { callbacksApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDate, formatDateTime } from "../utils/formatters.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import "../styles/mobile-business.css";


const defaultFilters = { preset: "today", date: "", sort: "asc" };

export default function Callbacks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { csrfToken } = useAuth();
  const filters = useMemo(() => ({
    preset: searchParams.get("preset") || defaultFilters.preset,
    date: searchParams.get("date") || "",
    sort: searchParams.get("sort") || defaultFilters.sort,
  }), [searchParams]);
  const [data, setData] = useState(() => peekCachedResponse("/callbacks/", { params: filters })?.data || null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [updatingId, setUpdatingId] = useState(null);
  const [completionDialog, setCompletionDialog] = useState({ callback: null, response: "" });

  useEffect(() => {
    let active = true;
    setError("");
    callbacksApi.list(filters)
      .then(({ data: responseData }) => {
        if (active) setData(responseData);
      })
      .catch((requestError) => {
        if (!active) return;
        setError(requestError.response?.data?.detail || "Unable to load callbacks.");
      });
    return () => { active = false; };
  }, [filters]);

  const updateFilters = (nextFilters) => {
    setSearchParams(() => {
      const next = new URLSearchParams();
      if (nextFilters.preset && nextFilters.preset !== defaultFilters.preset) next.set("preset", nextFilters.preset);
      if (nextFilters.date) next.set("date", nextFilters.date);
      if (nextFilters.sort && nextFilters.sort !== defaultFilters.sort) next.set("sort", nextFilters.sort);
      return next;
    });
    window.setTimeout(() => document.getElementById("callback-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const selectPreset = (preset) => updateFilters({ ...filters, preset, date: "" });
  const results = data?.results || [];
  const counts = data?.counts || { today: 0, tomorrow: 0, total: 0, calledBack: 0 };
  const showingCalledBack = filters.preset === "called_back" && !filters.date;
  const outcomeChoices = data?.outcomeChoices || [];

  const openCompletionDialog = (callback) => {
    setCompletionDialog({ callback, response: outcomeChoices[0]?.value || "" });
    setError("");
    setMessage("");
  };

  const markCalledBack = async () => {
    const callback = completionDialog.callback;
    if (!callback || !completionDialog.response) return;
    setUpdatingId(callback.id);
    setError("");
    setMessage("");
    try {
      await callbacksApi.complete(callback.id, completionDialog.response, csrfToken);
      const { data: responseData } = await callbacksApi.list(filters);
      setData(responseData);
      const selectedStatus = outcomeChoices.find((choice) => choice.value === completionDialog.response)?.label;
      setMessage(`${callback.customerName} marked as called back with status ${selectedStatus}.`);
      setCompletionDialog({ callback: null, response: "" });
      window.dispatchEvent(new Event("crm:callbacks-updated"));
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to update the callback status.");
    } finally {
      setUpdatingId(null);
    }
  };

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Callbacks</li>
        </ol>
      </nav>

      <div className="page-header mb-4">
        <div className="eyebrow">FOLLOW-UPS</div>
        <h1 className="h2 mb-2">Callbacks</h1>
        <p className="text-secondary mb-0">See customers scheduled for today, tomorrow, or another date.</p>
      </div>

      <div className="d-flex flex-wrap gap-2 mb-4" role="group" aria-label="Callback date shortcuts">
        <FilterButton active={!filters.date && filters.preset === "today"} onClick={() => selectPreset("today")}>
          Today <span className="badge text-bg-light ms-1">{counts.today}</span>
        </FilterButton>
        <FilterButton active={!filters.date && filters.preset === "tomorrow"} onClick={() => selectPreset("tomorrow")}>
          Tomorrow <span className="badge text-bg-light ms-1">{counts.tomorrow}</span>
        </FilterButton>
        <FilterButton active={!filters.date && filters.preset === "all"} onClick={() => selectPreset("all")}>
          All <span className="badge text-bg-light ms-1">{counts.total}</span>
        </FilterButton>
        <FilterButton active={showingCalledBack} onClick={() => selectPreset("called_back")}>
          Called Back <span className="badge text-bg-light ms-1">{counts.calledBack}</span>
        </FilterButton>
      </div>

      {!showingCalledBack && <div className="panel mb-4">
        <div className="row g-3 align-items-end">
          <div className="col-sm-6 col-lg-4">
            <label className="form-label" htmlFor="callback-date-filter">Filter by date</label>
            <input
              className="form-control"
              id="callback-date-filter"
              type="date"
              value={filters.date}
              onChange={(event) => updateFilters({ ...filters, preset: "custom", date: event.target.value })}
            />
          </div>
          <div className="col-sm-6 col-lg-4">
            <label className="form-label" htmlFor="callback-sort">Sort by callback date</label>
            <select
              className="form-select"
              id="callback-sort"
              value={filters.sort}
              onChange={(event) => updateFilters({ ...filters, sort: event.target.value })}
            >
              <option value="asc">Earliest first</option>
              <option value="desc">Latest first</option>
            </select>
          </div>
        </div>
      </div>}

      {error && <div className="alert alert-danger">{error}</div>}
      {message && <div className="alert alert-success">{message}</div>}
      {!data && !error ? (
        <div className="panel">Loading callbacks...</div>
      ) : results.length > 0 ? (
        <div className="table-responsive panel p-0 responsive-table business-table" id="callback-results" tabIndex="-1">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr><th>Customer</th><th>Dataset</th><th>Phone</th><th>{showingCalledBack ? "Called Back At" : "Callback Date"}</th>{showingCalledBack && <th>Called Back By</th>}<th>Status</th><th>Note</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {results.map((callback) => (
                <tr key={callback.id}>
                  <td data-label="Customer">{callback.customerName}</td>
                  <td data-label="Dataset">{callback.datasetName}</td>
                  <td data-label="Phone">{callback.phone || ""}</td>
                  <td data-label={showingCalledBack ? "Called Back At" : "Callback Date"}>
                    {showingCalledBack
                      ? formatDateTime(callback.callbackCompletedAt)
                      : callback.callbackDate ? formatDate(callback.callbackDate) : <span className="text-secondary">Unscheduled</span>}
                  </td>
                  {showingCalledBack && <td data-label="Called Back By">{callback.callbackCompletedBy || "Former user"}</td>}
                  <td data-label="Status"><span className={`badge-response response-${callback.status}`}>{callback.statusLabel}</span></td>
                  <td data-label="Note">{callback.note || ""}</td>
                  <td data-label="Actions">
                    <div className="btn-group btn-group-sm" role="group" aria-label={`Actions for ${callback.customerName}`}>
                      <Link className="btn btn-outline-primary" to={`/datasets/${callback.datasetId}/customers/${callback.id}`}>View</Link>
                      <Link className="btn btn-outline-secondary" to={`/datasets/${callback.datasetId}/customers/${callback.id}/edit`}>Edit</Link>
                      {!showingCalledBack && (
                        <button
                          className="btn btn-outline-success"
                          type="button"
                          disabled={updatingId === callback.id}
                          onClick={() => openCompletionDialog(callback)}
                        >
                          {updatingId === callback.id ? "Updating..." : "Mark Called Back"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state text-center">
          <h2 className="h5">{showingCalledBack ? "No completed callbacks" : "No callbacks found"}</h2>
          <p className="text-secondary mb-0">
            {showingCalledBack
              ? "Callbacks marked as called back will appear here."
              : "Choose another date or schedule a callback from a customer’s edit page."}
          </p>
        </div>
      )}

      {completionDialog.callback && (
        <CallbackOutcomeDialog
          customerName={completionDialog.callback.customerName}
          choices={outcomeChoices}
          value={completionDialog.response}
          busy={updatingId === completionDialog.callback.id}
          onChange={(response) => setCompletionDialog((current) => ({ ...current, response }))}
          onCancel={() => setCompletionDialog({ callback: null, response: "" })}
          onConfirm={markCalledBack}
        />
      )}
    </>
  );
}


function FilterButton({ active, children, onClick }) {
  return (
    <button className={`btn ${active ? "btn-primary" : "btn-outline-primary"}`} type="button" onClick={onClick} aria-pressed={active}>
      {children}
    </button>
  );
}


function CallbackOutcomeDialog({ customerName, choices, value, busy, onChange, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const statusRef = useRef(null);
  useDialogFocus({ open: true, dialogRef, initialFocusRef: statusRef, onCancel, busy });
  return (
    <>
      <div className="modal d-block business-dialog" ref={dialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="callback-outcome-title">
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title fs-5" id="callback-outcome-title">Complete Callback</h2>
              <button className="btn-close" type="button" aria-label="Close" onClick={onCancel} disabled={busy} />
            </div>
            <div className="modal-body">
              <p className="text-secondary">Choose the new CRM status for <strong>{customerName}</strong>.</p>
              <label className="form-label" htmlFor="callback-outcome-status">New Status</label>
              <select
                className="form-select"
                id="callback-outcome-status"
                ref={statusRef}
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
              >
                {choices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
              </select>
              <div className="form-text">This status will update everywhere for this customer and be added to Change History.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
              <button className="btn btn-success" type="button" onClick={onConfirm} disabled={busy || !value}>
                {busy ? "Updating..." : "Save Status"}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}
