import { useCallback, useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import { activeStoreId } from "../services/storeContext.js";
import { dashboardApi, datasetsApi, peekCachedResponse, targetsApi } from "../services/api.js";
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

const responseTones = {
  no_response: "slate",
  interested: "blue",
  not_interested: "rose",
  callback: "amber",
  converted: "green",
};

export default function Dashboard() {
  const { user } = useAuth();
  if (user?.is_superuser && !activeStoreId()) return <Navigate to="/admin-panel/stores" replace />;
  return <StoreDashboard />;
}

function StoreDashboard() {
  const location = useLocation();
  const [dashboard, setDashboard] = useState(() => (
    location.state?.preloadedDashboard || peekCachedResponse("/dashboard/")?.data || null
  ));
  const [error, setError] = useState("");
  const [targetsError, setTargetsError] = useState("");
  const [allDatasets, setAllDatasets] = useState(null);
  const [datasetPage, setDatasetPage] = useState(1);
  const [datasetError, setDatasetError] = useState("");
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [targets, setTargets] = useState(() => (
    location.state?.preloadedTargets || peekCachedResponse("/targets/")?.data?.results || null
  ));
  const loadingRef = useRef(false);
  const datasetsExpanded = allDatasets !== null;
  const datasets = datasetsExpanded ? allDatasets : dashboard?.recentDatasets || [];
  const pageCount = Math.ceil(datasets.length / 5);
  const visibleDatasets = datasetsExpanded
    ? datasets.slice((datasetPage - 1) * 5, datasetPage * 5)
    : datasets;

  const load = useCallback(() => {
    if (loadingRef.current) return Promise.resolve();
    loadingRef.current = true;
    setError("");
    setTargetsError("");
    const summary = dashboardApi.summary()
      .then(({ data }) => setDashboard(data))
      .catch(() => setError("Unable to load dashboard data."));
    const monthlyTargets = targetsApi.list()
      .then(({ data }) => setTargets(data.results))
      .catch(() => setTargetsError("Unable to load monthly targets."));
    return Promise.allSettled([summary, monthlyTargets]).finally(() => { loadingRef.current = false; });
  }, []);

  useEffect(() => {
    void load();
    const refreshWhenVisible = () => { if (!document.hidden) void load(); };
    const timer = window.setInterval(refreshWhenVisible, 30000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refreshWhenVisible); window.removeEventListener("focus", refreshWhenVisible); };
  }, [load]);

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

  if (error && !dashboard) return <RequestError message={error} onRetry={load} />;

  if (!dashboard) {
    return <LoadingPanel label="Loading dashboard" />;
  }

  const stats = dashboard.responseStats || [];
  const countFor = (status) => stats.find((stat) => stat.value === status)?.count || 0;
  const conversionRate = dashboard.totalCustomers > 0
    ? Math.round(countFor("converted") / dashboard.totalCustomers * 100)
    : 0;
  const today = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());

  return (
    <div className="crm-dashboard">
      <div className="dashboard-heading">
        <div>
          <div className="dashboard-eyebrow">WORKSPACE OVERVIEW</div>
          <h1>CRM Dashboard<span className="heading-dot">.</span></h1>
          <p>Your customers, conversations, and business performance in one place.</p>
        </div>
        <div className="dashboard-date"><i className="bi bi-calendar3" aria-hidden="true" /><span>{today}</span></div>
      </div>

      <section className="dashboard-welcome" aria-label="Customer management shortcuts">
        <div className="welcome-copy">
          <span className="welcome-icon"><i className="bi bi-grid-1x2" aria-hidden="true" /></span>
          <div><h2>Good relationships. Better business.</h2><p>Keep every customer conversation moving forward.</p></div>
        </div>
        <div className="dashboard-actions">
          <Link className="btn btn-outline-secondary" to="/datasets"><i className="bi bi-list-ul" aria-hidden="true" />Customer Lists</Link>
          <Link className="btn btn-primary" to="/import"><i className="bi bi-plus-lg" aria-hidden="true" />Import Excel</Link>
        </div>
      </section>

      {error && <div className="alert alert-warning" role="status">{error} Showing the most recent available dashboard.</div>}

      <div className="dashboard-kpis">
        <MetricCard icon="bi-people" label="Total customers" value={dashboard.totalCustomers} tone="blue" caption="Across your customer lists" />
        <MetricCard icon="bi-folder2-open" label="Datasets" value={dashboard.totalDatasets} tone="violet" caption="Imported customer lists" />
        <MetricCard icon="bi-hand-thumbs-up" label="Interested" value={countFor("interested")} tone="amber" caption="Customers showing interest" />
        <MetricCard icon="bi-check2-circle" label="Converted" value={countFor("converted")} tone="green" caption={`${conversionRate}% of total customers`} />
      </div>

      <div className="dashboard-insights">
        <section className="panel dashboard-pipeline" aria-labelledby="pipeline-heading">
          <div className="dashboard-section-heading">
            <div><h2 id="pipeline-heading">Customer responses</h2><p>A clear picture of where every conversation stands.</p></div>
            <span className="section-chip">{dashboard.totalCustomers} customers</span>
          </div>
          <div className="pipeline-legend"><span>Response status</span><span>Customers</span></div>
          <div className="pipeline-rows">
            {stats.map((stat) => {
              const percentage = dashboard.totalCustomers > 0 ? Math.round(stat.count / dashboard.totalCustomers * 100) : 0;
              return <div className={`pipeline-row tone-${responseTones[stat.value] || "slate"}`} key={stat.value}>
                <span className="pipeline-label"><i className={`bi ${responseIcons[stat.value] || "bi-tag"}`} aria-hidden="true" />{stat.label}</span>
                <div className="pipeline-track" aria-hidden="true"><span style={{ width: `${Math.min(percentage, 100)}%` }} /></div>
                <strong>{stat.count}</strong><span className="pipeline-percentage">{percentage}%</span>
              </div>;
            })}
          </div>
          <div className="pipeline-footer"><i className="bi bi-people" aria-hidden="true" /><span>Every conversation is an opportunity.</span><Link to="/customers">View customers<i className="bi bi-arrow-right" aria-hidden="true" /></Link></div>
        </section>
        <PaymentSummarySection payments={dashboard.payments} />
      </div>

      {targetsError && <div className="alert alert-warning" role="alert">{targetsError} <button className="btn btn-outline-secondary btn-sm ms-2" type="button" onClick={load}>Retry</button></div>}

      {targets?.length > 0 && (
        <section className="panel dashboard-targets">
          <h2 className="h4 mb-1">Monthly Targets</h2>
          <p className="text-secondary small mb-3">Targets assigned by admin for previous, current, and upcoming months.</p>
          <div className="d-grid gap-3">
            {targets.map((target) => (
              <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 border-top pt-3" key={target.id}>
                <div>
                  <div className="fw-semibold">{target.monthLabel}</div>
                  <div className="text-secondary small">{target.converted} of {target.target} converted ({target.percentage}%)</div>
                  <div className="target-track" aria-hidden="true"><span style={{ width: `${Math.min(Math.max(Number(target.percentage) || 0, 0), 100)}%` }} /></div>
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

      <div className="dashboard-lower-grid">
      <section className="panel dashboard-datasets">
        <div className="dashboard-section-heading">
          <div><h2>Recent datasets</h2><p>Your latest imported customer lists.</p></div>
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
                className="dashboard-dataset-row"
                key={dataset.id}
                to={`/datasets/${dataset.id}`}
              >
                <span className="dataset-file-icon"><i className="bi bi-file-earmark-excel" aria-hidden="true" /></span>
                <span className="dataset-file-copy"><strong>{dataset.name}</strong><small>{dataset.original_filename}</small><small>{formatDate(dataset.uploaded_at)}</small></span>
                <span className="dataset-customer-count"><AnimatedNumber value={dataset.customer_count} /><small>customers</small></span>
                <i className="bi bi-chevron-right dataset-row-arrow" aria-hidden="true" />
              </Link>
            ))}
          </div>
        ) : (
          <div className="empty-state text-center">
            <span className="dashboard-empty-icon"><i className="bi bi-folder2-open" aria-hidden="true" /></span>
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

      <section className="panel dashboard-sales">
        <div className="dashboard-section-heading">
          <div>
            <h2>Sales activity</h2>
            <p>Make every visit count.</p>
          </div>
          <Link className="btn btn-outline-secondary btn-sm" to="/sales/visits/add"><i className="bi bi-plus-lg" aria-hidden="true" />Add Visit</Link>
        </div>
        <div className="dashboard-sales-grid">
          <SmallMetric label="Total Visits" value={dashboard.sales.totalVisits} />
          <SmallMetric label="Today's Visits" value={dashboard.sales.todaysVisits} />
          <SmallMetric label="This Month" value={dashboard.sales.monthVisits} />
          <SmallMetric label="Total Expenses" value={formatCurrency(dashboard.sales.totalVisitExpenses)} />
        </div>
        <Link className="dashboard-sales-link" to="/sales">View sales activity<i className="bi bi-arrow-right" aria-hidden="true" /></Link>
      </section>
      </div>
      <div className="dashboard-footnote"><span>VESTANO CRM</span><span>Built around better customer relationships.</span></div>
    </div>
  );
}

function MetricCard({ icon, label, value, tone = "blue", caption }) {
  return (
    <div className={`dashboard-kpi tone-${tone}`}>
      <div className="kpi-topline"><span>{label}</span><span className="kpi-icon"><i className={`bi ${icon}`} aria-hidden="true" /></span></div>
      <div className="kpi-value"><AnimatedNumber value={value} /></div>
      <div className="kpi-caption"><span className="kpi-dot" />{caption}</div>
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
    <section className="panel dashboard-payments" aria-labelledby="payment-summary-heading">
      <div className="dashboard-section-heading"><div><h2 id="payment-summary-heading">Payment overview</h2><p>A snapshot of your customer payments.</p></div><span className="payment-wallet"><i className="bi bi-wallet2" aria-hidden="true" /></span></div>
      <div className="payment-total"><span>Total expected payment</span><strong><AnimatedNumber value={formatCurrency(totals.totalAmount)} /></strong></div>
      <div className="payment-amounts">
        <div><span><i className="payment-status-dot paid" aria-hidden="true" />Paid amount</span><strong><AnimatedNumber value={formatCurrency(totals.paidAmount)} /></strong></div>
        <div><span><i className="payment-status-dot pending" aria-hidden="true" />Pending amount</span><strong><AnimatedNumber value={formatCurrency(totals.pendingAmount)} /></strong></div>
      </div>
      <div className="payment-counts">
        <div><strong>{totals.paidCount}</strong><span>Paid</span></div>
        <div><strong>{totals.pendingCount}</strong><span>Pending</span></div>
        <div><strong>{totals.oneTimeCount}</strong><span>One-time</span></div>
        <div><strong>{totals.completedCount}</strong><span>Completed</span></div>
      </div>
    </section>
  );
}

function SmallMetric({ label, value }) {
  const isExpense = label.includes("Expenses");

  return (
    <div className={`sales-stat ${isExpense ? "sales-stat-expense" : ""}`}>
      <span>{label}</span>
      <strong><AnimatedNumber value={value} /></strong>
    </div>
  );
}
