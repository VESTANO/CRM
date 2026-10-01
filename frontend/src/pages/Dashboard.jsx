import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { dashboardApi, datasetsApi } from "../services/api.js";
import { formatCurrency, formatDate } from "../utils/formatters.js";

const responseIcons = {
  no_response: "bi-chat-dots",
  interested: "bi-hand-thumbs-up",
  not_interested: "bi-hand-thumbs-down",
  callback: "bi-telephone",
  converted: "bi-check2-circle",
};

export default function Dashboard() {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState("");
  const [allDatasets, setAllDatasets] = useState(null);
  const [datasetPage, setDatasetPage] = useState(1);
  const [datasetError, setDatasetError] = useState("");
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const datasetsExpanded = allDatasets !== null;
  const datasets = datasetsExpanded ? allDatasets : dashboard?.recentDatasets || [];
  const pageCount = Math.ceil(datasets.length / 5);
  const visibleDatasets = datasetsExpanded
    ? datasets.slice((datasetPage - 1) * 5, datasetPage * 5)
    : datasets;

  useEffect(() => {
    dashboardApi
      .summary()
      .then(({ data }) => setDashboard(data))
      .catch(() => setError("Unable to load dashboard data."));
  }, []);

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

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!dashboard) {
    return <div className="panel">Loading dashboard...</div>;
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
                  <span className="recent-dataset-count badge text-bg-light">{dataset.customer_count} customers</span>
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
        <div className="summary-value">{value}</div>
      </div>
    </div>
  );
}

function SmallMetric({ label, value }) {
  return (
    <div className="summary-card compact">
      <div className="text-secondary small">{label}</div>
      <div className="fs-4 fw-bold">{value}</div>
    </div>
  );
}
