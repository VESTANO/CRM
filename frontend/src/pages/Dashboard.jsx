import { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { dashboardApi, datasetsApi, targetsApi } from "../services/api.js";
import { formatCurrency, formatDate } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";

const responseIcons = {
  no_response: "bi-chat-dots",
  interested: "bi-hand-thumbs-up",
  not_interested: "bi-hand-thumbs-down",
  callback: "bi-telephone",
  converted: "bi-check2-circle",
};

export default function Dashboard() {
  const location = useLocation();
  const [dashboard, setDashboard] = useState(() => location.state?.preloadedDashboard || null);
  const [error, setError] = useState("");
  const [allDatasets, setAllDatasets] = useState(null);
  const [datasetPage, setDatasetPage] = useState(1);
  const [datasetError, setDatasetError] = useState("");
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [targets, setTargets] = useState(() => location.state?.preloadedTargets || null);
  const datasetsExpanded = allDatasets !== null;
  const datasets = datasetsExpanded ? allDatasets : dashboard?.recentDatasets || [];
  const pageCount = Math.ceil(datasets.length / 5);
  const visibleDatasets = datasetsExpanded
    ? datasets.slice((datasetPage - 1) * 5, datasetPage * 5)
    : datasets;

  const load = useCallback(() => {
    Promise.all([dashboardApi.summary(), targetsApi.list()])
      .then(([dashboardResponse, targetsResponse]) => {
        setDashboard(dashboardResponse.data);
        setTargets(targetsResponse.data.results);
      })
      .catch(() => setError("Unable to load dashboard data."));
  }, []);

  useEffect(() => { load(); }, [load]);

  const showAllDatasets = async () => {
    setLoadingDatasets(true);
    setDatasetError("");
    try {
      const { data } = await datasetsApi.list();
      setAllDatasets(data.results);
      setDatasetPage(1);
    } catch {
      setDatasetError("Unable to load all datasets.");
    } finally {
      setLoadingDatasets(false);
    }
  };

  const showRecentDatasets = () => {
    setAllDatasets(null);
    setDatasetPage(1);
    setDatasetError("");
  };

  if (error) return <RequestError message={error} onRetry={load} />;

  if (!dashboard) {
    return <LoadingPanel label="Loading dashboard" />;
  }

  return (
    <>
      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Dashboard</div>
          <h1 className="h2 mb-2">CRM Dashboard</h1>
          <p className="text-secondary mb-0">A simple overview of imported datasets and customer response status.</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <Link className="btn btn-primary" to="/import"><i className="bi bi-plus-lg me-1" />Import Excel</Link>
          <Link className="btn btn-outline-primary" to="/datasets"><i className="bi bi-list-ul me-1" />Customer Lists</Link>
        </div>
      </div>

      <div className="metric-grid mb-4">
        <MetricCard icon="bi-folder2-open" label="Datasets" value={dashboard.totalDatasets} />
        <MetricCard icon="bi-people" label="Total Customers" value={dashboard.totalCustomers} />
        {dashboard.responseStats.map((stat) => (
          <MetricCard
            key={stat.value}
            icon={responseIcons[stat.value] || "bi-tag"}
            label={stat.label}
            value={stat.count}
          />
        ))}
      </div>

      <PaymentSummarySection payments={dashboard.payments} />

      {targets?.length > 0 && (
        <section className="panel mb-4">
          <h2 className="h4 mb-1">Monthly Targets</h2>
          <p className="text-secondary small mb-3">Targets assigned by admin for previous, current, and upcoming months.</p>
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

      <section className="panel">
        <div className="d-flex justify-content-between align-items-center mb-3">
          <h2 className="h4 mb-0">Recent Datasets</h2>
          {datasetsExpanded ? (
            <button className="btn btn-outline-secondary btn-sm" type="button" onClick={showRecentDatasets}>View Less</button>
          ) : dashboard.totalDatasets > 3 ? (
            <button className="btn btn-outline-primary btn-sm" type="button" onClick={showAllDatasets} disabled={loadingDatasets}>{loadingDatasets ? "Loading..." : "View All"}</button>
          ) : null}
        </div>
        {datasetError && <div className="alert alert-danger">{datasetError}</div>}
        {visibleDatasets.length ? (
          <div className="list-group list-group-flush">
            {visibleDatasets.map((dataset) => (
              <Link
                className="list-group-item list-group-item-action recent-dataset-item px-0 py-3"
                key={dataset.id}
                to={`/datasets/${dataset.id}`}
              >
                <span className="recent-dataset-row recent-dataset-name fw-semibold">{dataset.name}</span>
                <span className="recent-dataset-row recent-dataset-file text-secondary small">
                  {dataset.original_filename}
                </span>
                <span className="recent-dataset-row recent-dataset-meta">
                  <span className="recent-dataset-date text-secondary small">{formatDate(dataset.uploaded_at)}</span>
                  <span className="recent-dataset-count badge text-bg-light"><AnimatedNumber value={dataset.customer_count} /> customers</span>
                  <span className="recent-dataset-open btn btn-sm btn-outline-primary">Open</span>
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state text-center">
            <h3 className="h5">No datasets yet</h3>
            <p className="text-secondary">No customer lists have been imported yet.</p>
            <Link className="btn btn-primary" to="/import">Import Excel</Link>
          </div>
        )}
        {datasetsExpanded && pageCount > 1 && (
          <div className="d-flex justify-content-between align-items-center mt-3">
            <span className="text-secondary small">Page {datasetPage} of {pageCount}</span>
            <div className="d-flex gap-2">
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setDatasetPage((page) => page - 1)} disabled={datasetPage <= 1}>Previous</button>
              <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setDatasetPage((page) => page + 1)} disabled={datasetPage >= pageCount}>Next</button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3">
          <div>
            <h2 className="h4 mb-1">Sales Visits</h2>
            <p className="text-secondary mb-0">Track client visits, meeting status, and expenses.</p>
          </div>
          <Link className="btn btn-primary" to="/sales/visits/add"><i className="bi bi-plus-lg me-1" />Add Visit</Link>
        </div>
        <div className="metric-grid">
          <SmallMetric label="Total Visits" value={dashboard.sales.totalVisits} />
          <SmallMetric label="Today's Visits" value={dashboard.sales.todaysVisits} />
          <SmallMetric label="This Month" value={dashboard.sales.monthVisits} />
          <SmallMetric label="Total Expenses" value={formatCurrency(dashboard.sales.totalVisitExpenses)} />
        </div>
      </section>
    </>
  );
}

function MetricCard({ icon, label, value }) {
  return (
    <div>
      <div className="summary-card">
        <div className="metric-icon"><i className={`bi ${icon}`} /></div>
        <div className="text-secondary small">{label}</div>
        <div className="summary-value"><AnimatedNumber value={value} /></div>
      </div>
    </div>
  );
}

function PaymentSummarySection({ payments }) {
  const totals = payments || {
    totalAmount: 0,
    paidAmount: 0,
    pendingAmount: 0,
    paidCount: 0,
    pendingCount: 0,
    oneTimeCount: 0,
    completedCount: 0,
  };
  return (
    <section className="panel payment-dashboard-section mb-4" aria-labelledby="payment-summary-heading">
      <div className="payment-dashboard-header">
        <div className="metric-icon"><i className="bi bi-wallet2" /></div>
        <div>
          <h2 className="h4 mb-1" id="payment-summary-heading">Payment Summary</h2>
          <div className="text-secondary small">Total expected payment</div>
          <div className="payment-dashboard-total">{formatCurrency(totals.totalAmount)}</div>
        </div>
      </div>
      <div className="payment-dashboard-details">
        <div><small className="text-secondary">Paid Payments</small><strong>{totals.paidCount}</strong><span>{formatCurrency(totals.paidAmount)} paid</span></div>
        <div><small className="text-secondary">Pending Payments</small><strong>{totals.pendingCount}</strong><span>{formatCurrency(totals.pendingAmount)} pending</span></div>
        <div><small className="text-secondary">One-time Payments</small><strong>{totals.oneTimeCount}</strong></div>
        <div><small className="text-secondary">Completed Payments</small><strong>{totals.completedCount}</strong></div>
      </div>
    </section>
  );
}

function SmallMetric({ label, value }) {
  const isExpense = label.includes("Expenses");

  return (
    <div className={`summary-card compact ${isExpense ? "sales-expense-card" : ""}`}>
      <div className="text-secondary small">{label}</div>
      <div className={`fs-4 fw-bold ${isExpense ? "summary-value-currency" : ""}`}><AnimatedNumber value={value} /></div>
    </div>
  );
}
