import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi, reportsApi, peekCachedResponse, salesApi } from "../services/api.js";
import { formatCurrency } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { LoadingPanel } from "../components/RequestState.jsx";
import "../styles/mobile-business.css";

import { useStoreFeatures } from "../hooks/useStoreFeatures.jsx";
import { useAuth } from "../hooks/useAuth.jsx";

const chartPalette = [
  { fill: "#DCE4E8", border: "#405565", text: "#172B3A" },
  { fill: "#F8E3D4", border: "#D97736", text: "#172B3A" },
  { fill: "#C9D5DD", border: "#405565", text: "#172B3A" },
  { fill: "#E6B48F", border: "#A85421", text: "#172B3A" },
  { fill: "#F5F1E9", border: "#405565", text: "#172B3A" },
  { fill: "#FFFFFF", border: "#172B3A", text: "#172B3A" },
];
const customerColors = chartPalette.slice(0, 5);
const visitColors = [chartPalette[0], chartPalette[3], chartPalette[1], chartPalette[2], chartPalette[5]];
function currentReportMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || "";
  return value("year") + "-" + value("month");
}

function isCustomerReport(data) {
  return Boolean(data) && Array.isArray(data.responseStats);
}

function isSalesReport(data) {
  return Boolean(data) && Array.isArray(data.statuses) && Array.isArray(data.recentMonths);
}

export default function Reports() {
  const { features } = useStoreFeatures();
  const { user } = useAuth();
  const [customerStats, setCustomerStats] = useState(() => peekCachedResponse("/dashboard/")?.data || null);
  const [visitStats, setVisitStats] = useState(() => peekCachedResponse("/sales/report/")?.data || null);
  const [employeePerformance, setEmployeePerformance] = useState(() => peekCachedResponse("/admin/user-performance/")?.data?.results || null);
  const [salesPerformance, setSalesPerformance] = useState(() => peekCachedResponse("/admin/sales-performance/")?.data?.results || null);
  const [reportMonth, setReportMonth] = useState(currentReportMonth);
  const [error, setError] = useState("");

  const changeReportMonth = (value) => {
    const nextMonth = value || currentReportMonth();
    if (nextMonth === reportMonth) return;
    setEmployeePerformance(null);
    setSalesPerformance(null);
    setReportMonth(nextMonth);
  };

  const load = useCallback(() => {
    setError("");
    const customers = !features.customers ? Promise.resolve() : reportsApi.summary()
      .then(({ data }) => {
        if (!isCustomerReport(data)) throw new Error("Invalid customer report response.");
        setCustomerStats(data);
      })
      .catch(() => setError("Unable to load customer insights."));
    const sales = !features.sales ? Promise.resolve() : salesApi.report()
      .then(({ data }) => {
        if (!isSalesReport(data)) throw new Error("Invalid sales report response.");
        setVisitStats(data);
      })
      .catch(() => setError("Unable to load sales insights."));
    const performance = !features.sales || !user?.is_admin ? Promise.resolve() : adminApi.salesPerformance(reportMonth)
      .then(({ data }) => setSalesPerformance(data.results || []))
      .catch(() => setError("Unable to load the sales team report."));
    const employeeReport = !user?.is_admin ? Promise.resolve() : adminApi.userPerformance(reportMonth)
      .then(({ data }) => setEmployeePerformance(data.results || []))
      .catch(() => setError("Unable to load the employee performance report."));
    return Promise.allSettled([customers, sales, performance, employeeReport]);
  }, [features.customers, features.sales, reportMonth, user?.is_admin]);

  useEffect(() => { load(); }, [load]);

  const maxCustomerCount = Math.max(1, ...(customerStats?.responseStats || []).map((item) => item.count));
  const maxVisitCount = Math.max(1, ...(visitStats?.statuses || []).map((item) => item.count));

  return <div className="business-reports">
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Reports</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">CRM Overview</div><h1 className="h2 mb-2">Reports</h1><p className="text-secondary mb-0">Customer responses and sales activity at a glance.</p></div></div>
    {error && <div className="alert alert-warning" role="alert">{error} <button className="btn btn-outline-secondary btn-sm ms-2" type="button" onClick={load}>Retry</button></div>}
    {user?.is_admin && <div className="panel d-flex flex-wrap align-items-end justify-content-between gap-3 mb-4"><div><h2 className="h6 mb-1">Performance reporting period</h2><p className="text-secondary small mb-0">Choose a month to view employee tasks, short hours, and Sales targets.</p></div><div><label className="form-label small mb-1" htmlFor="performance-report-month">Month</label><input id="performance-report-month" className="form-control" type="month" value={reportMonth} onChange={(event) => changeReportMonth(event.target.value)} /></div></div>}

    {user?.is_admin && employeePerformance === null && <LoadingPanel label={"Loading filtered performance for " + reportMonth} />}
    {user?.is_admin && employeePerformance && <section className="panel mb-4" aria-labelledby="employee-performance-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3"><div><h2 className="h4 mb-1" id="employee-performance-heading">Employee Performance</h2><p className="text-secondary mb-0">Task completion and short hours for every active employee in the selected month.</p></div><Link className="btn btn-outline-primary btn-sm" to="/admin-panel/users">All Users</Link></div>
      {employeePerformance.length ? <><EmployeePerformanceGraph people={employeePerformance} /><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Employee</th><th>Designation</th><th>Assigned tasks</th><th>Completed</th><th>Pending</th><th>Short-hour days</th><th>Completion</th></tr></thead><tbody>{employeePerformance.map((person) => <tr key={person.userId}><td className="fw-semibold">{person.username}</td><td>{person.designation || <span className="text-secondary">—</span>}</td><td>{person.assignedTasks}</td><td>{person.completedTasks}</td><td>{person.pendingTasks}</td><td>{person.shortDays || <span className="text-secondary">—</span>}</td><td>{person.percentage === null ? <span className="text-secondary">No tasks</span> : person.percentage + "%"}</td></tr>)}</tbody></table></div></> : <p className="text-secondary mb-0">No active employees in this store yet.</p>}
    </section>}

    {features.customers && (customerStats ? <section className="panel mb-4" aria-labelledby="customer-insights-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3"><div><h2 className="h4 mb-1" id="customer-insights-heading">Customer Insights</h2><p className="text-secondary mb-0">Customer response across your accessible datasets.</p></div><Link className="btn btn-outline-primary btn-sm" to="/datasets">Customer Lists</Link></div>
      <div className="reports-summary-grid mb-4">
        <Summary label="Total customers" value={customerStats.totalCustomers} icon="bi-people" />
        <Summary label="Datasets" value={customerStats.totalDatasets} icon="bi-folder2-open" />
      </div>
      <Breakdown title="Customer response" items={customerStats.responseStats.map((item, index) => ({ ...item, color: customerColors[index % customerColors.length] }))} max={maxCustomerCount} />
    </section> : !error && <LoadingPanel label="Loading customer insights" />)}

    {features.sales && (visitStats ? <section className="panel" aria-labelledby="sales-insights-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3"><div><h2 className="h4 mb-1" id="sales-insights-heading">Sales Insights</h2><p className="text-secondary mb-0">Visit outcomes, activity, and recorded expenses.</p></div><Link className="btn btn-outline-primary btn-sm" to="/sales">Sales</Link></div>
      <div className="reports-summary-grid mb-4">
        <Summary label="Total visits" value={visitStats.totalVisits} icon="bi-calendar2-check" />
        <Summary label="Visit expenses" value={formatCurrency(visitStats.totalExpenses)} icon="bi-cash-stack" />
        <Summary label="Months with visits" value={visitStats.activeMonths} icon="bi-calendar3" />
      </div>
      <div className="row g-4">
        <div className="col-lg-6"><Breakdown title="Visit outcomes" items={visitStats.statuses.map((item, index) => ({ ...item, color: visitColors[index % visitColors.length] }))} max={maxVisitCount} empty="No visit outcomes recorded yet." /></div>
        <div className="col-lg-6"><h3 className="h6 mb-3">Visits over the last 6 months</h3>{visitStats.recentMonths.every((item) => item.count === 0) ? <p className="text-secondary mb-0">No visits recorded in this period.</p> : <MonthlyTrend months={visitStats.recentMonths} />}</div>
      </div>
    </section> : !error && <LoadingPanel label="Loading sales insights" />)}
    {features.sales && user?.is_admin && salesPerformance && <section className="panel mt-4" aria-labelledby="sales-performance-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3"><div><h2 className="h4 mb-1" id="sales-performance-heading">Sales Performance</h2><p className="text-secondary mb-0">Selected-month performance for active Sales-designated users.</p></div><Link className="btn btn-outline-primary btn-sm" to="/admin-panel/users">All Users</Link></div>
      {salesPerformance.length ? <UserPerformanceGraph people={salesPerformance} /> : null}
      {salesPerformance.length ? <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Salesperson</th><th>Converted customers</th><th>Converted amount</th><th>Target</th><th>Progress</th><th>Remaining</th></tr></thead><tbody>{salesPerformance.map((person) => <tr key={person.userId}><td className="fw-semibold">{person.username}</td><td>{person.convertedCount}</td><td>{formatCurrency(person.convertedAmount)}</td><td>{person.target === null ? <span className="text-secondary">No target</span> : person.metric === "amount" ? formatCurrency(person.target) : `${person.target} customers`}</td><td>{person.percentage === null ? "—" : `${person.percentage}%`}</td><td>{person.remaining === null ? "—" : person.metric === "amount" ? formatCurrency(person.remaining) : person.remaining}</td></tr>)}</tbody></table></div> : <p className="text-secondary mb-0">No active Sales users in this store yet.</p>}
    </section>}
    {!features.customers && !features.sales && <p className="text-secondary">No report sections are enabled for this store.</p>}
  </div>;
}

function Summary({ label, value, icon }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className={`summary-card compact ${typeof value === "string" ? "reports-summary-currency" : ""}`}><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className="reports-summary-value"><AnimatedNumber value={value} active={isVisible} /></div></div>;
}

function Breakdown({ title, items, max, empty = "No customer data recorded yet." }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className={`reports-chart-reveal ${isVisible ? "is-visible" : ""}`}><h3 className="h6 mb-3">{title}</h3>{items.length ? <div className="reports-breakdown">{items.map((item) => <div className="reports-breakdown-row" key={item.value}><div className="reports-breakdown-label">{item.label}</div><div className="reports-breakdown-track"><div className="reports-breakdown-bar" style={{ width: `${(item.count / max) * 100}%`, "--bar-fill": item.color.fill, "--bar-border": item.color.border }} /></div><div className="reports-breakdown-count" style={{ color: item.color.text }}><AnimatedNumber value={item.count} active={isVisible} /></div></div>)}</div> : <p className="text-secondary mb-0">{empty}</p>}</div>;
}

function EmployeePerformanceGraph({ people }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className={"user-performance-graph reports-chart-reveal mb-4 " + (isVisible ? "is-visible" : "")} aria-label="Current-month employee task completion">
    <div className="d-flex flex-wrap justify-content-between gap-2 mb-3"><h3 className="h6 mb-0">Task completion by employee</h3><span className="text-secondary small">Selected month</span></div>
    <div className="user-performance-list">
      {people.map((person, index) => {
        const progress = person.percentage === null ? null : Math.max(0, Number(person.percentage) || 0);
        return <div className="user-performance-row" key={person.userId}>
          <div className="user-performance-meta"><strong>{person.username}</strong><span>{progress === null ? "No tasks assigned" : person.completedTasks + " of " + person.assignedTasks + " tasks completed"}{person.shortDays ? " · " + person.shortDays + " short-hour day" + (person.shortDays === 1 ? "" : "s") : ""}</span></div>
          <div className="user-performance-track" role="progressbar" aria-label={person.username + " task completion"} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress || 0)}>
            <div className="user-performance-bar" style={{ width: Math.min(progress || 0, 100) + "%", "--performance-color": chartPalette[index % chartPalette.length].border }} />
          </div>
          <strong className="user-performance-value">{progress === null ? "—" : Math.round(progress) + "%"}</strong>
        </div>;
      })}
    </div>
  </div>;
}

function UserPerformanceGraph({ people }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className={"user-performance-graph reports-chart-reveal mb-4 " + (isVisible ? "is-visible" : "")} aria-label="Current-month sales target progress by user">
    <div className="d-flex flex-wrap justify-content-between gap-2 mb-3"><h3 className="h6 mb-0">User target progress</h3><span className="text-secondary small">Selected month</span></div>
    <div className="user-performance-list">
      {people.map((person, index) => {
        const progress = person.percentage === null ? null : Math.max(0, Number(person.percentage) || 0);
        const visualProgress = Math.min(progress || 0, 100);
        const achievement = person.metric === "amount"
          ? formatCurrency(person.convertedAmount) + " / " + formatCurrency(person.target || 0)
          : person.convertedCount + " / " + (person.target || 0) + " customers";
        return <div className="user-performance-row" key={person.userId}>
          <div className="user-performance-meta"><strong>{person.username}</strong><span>{progress === null ? "No target assigned" : achievement}</span></div>
          <div className="user-performance-track" role="progressbar" aria-label={person.username + " target progress"} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(progress || 0)}>
            <div className="user-performance-bar" style={{ width: visualProgress + "%", "--performance-color": chartPalette[index % chartPalette.length].border }} />
          </div>
          <strong className="user-performance-value">{progress === null ? "—" : Math.round(progress) + "%"}</strong>
        </div>;
      })}
    </div>
  </div>;
}

function MonthlyTrend({ months }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const [ref, isVisible] = useRevealOnView();
  const max = Math.max(1, ...months.map((month) => month.count));
  const needsLegend = months.some((month) => month.count > 999);
  const points = months.map((month, index) => {
    const x = 8 + (index * 84) / (months.length - 1);
    const y = 70 - (month.count / max) * 42;
    return { ...month, x, y };
  });
  const path = points.map(({ x, y }, index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
  const scatterOffsets = [[-18, -18], [8, -25], [19, 12], [-12, 20], [20, -16], [-17, 10]];

  return <><div ref={ref} className={`reports-trend reports-chart-reveal ${isVisible ? "is-visible" : ""} ${needsLegend ? "reports-trend--large-counts" : ""}`} role="img" aria-label={`Visit counts over the last six months: ${months.map(({ label, count }) => `${label} ${count}`).join(", ")}`} onMouseLeave={() => setActiveIndex(null)}>
    <svg className="reports-trend-line" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} pathLength="100" />
    </svg>
    <div className="reports-trend-markers" aria-hidden="true">{points.map((point, index) => <span className={`reports-trend-marker ${point.count ? "has-visits" : "no-visits"} ${activeIndex === index ? "is-active" : ""}`} key={point.key} style={{ left: `${point.x}%`, top: `${(point.y / 80) * 100}%`, "--scatter-x": `${scatterOffsets[index % scatterOffsets.length][0]}px`, "--scatter-y": `${scatterOffsets[index % scatterOffsets.length][1]}px` }} onMouseEnter={() => setActiveIndex(index)}><AnimatedNumber value={point.count} active={isVisible} /></span>)}</div>
    <div className="reports-trend-months" aria-hidden="true">{points.map((point, index) => <span className={activeIndex === index ? "is-active" : ""} key={point.key} onMouseEnter={() => setActiveIndex(index)}>{point.label}</span>)}</div>
  </div>{needsLegend && <dl className="reports-trend-values" aria-label="Monthly visit totals">{months.map((month) => <div key={month.key}><dt>{month.label}</dt><dd><AnimatedNumber value={month.count} active={isVisible} /></dd></div>)}</dl>}</>;
}

function useRevealOnView() {
  const ref = useRef(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (!("IntersectionObserver" in window)) {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true);
        observer.unobserve(entry.target);
      }
    }, { threshold: 0.2 });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, isVisible];
}
