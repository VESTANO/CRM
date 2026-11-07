import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { reportsApi, peekCachedResponse, salesApi } from "../services/api.js";
import { formatCurrency } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { LoadingPanel } from "../components/RequestState.jsx";
import "../styles/mobile-business.css";

import { useStoreFeatures } from "../hooks/useStoreFeatures.jsx";

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
export default function Reports() {
  const { features } = useStoreFeatures();
  const [customerStats, setCustomerStats] = useState(() => peekCachedResponse("/dashboard/")?.data || null);
  const [visitStats, setVisitStats] = useState(() => peekCachedResponse("/sales/report/")?.data || null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setError("");
    const customers = !features.customers ? Promise.resolve() : reportsApi.summary()
      .then(({ data }) => setCustomerStats(data))
      .catch(() => setError("Unable to load customer insights."));
    const sales = !features.sales ? Promise.resolve() : salesApi.report()
      .then(({ data }) => setVisitStats(data))
      .catch(() => setError("Unable to load sales insights."));
    return Promise.allSettled([customers, sales]);
  }, [features.customers, features.sales]);

  useEffect(() => { load(); }, [load]);

  const maxCustomerCount = Math.max(1, ...(customerStats?.responseStats || []).map((item) => item.count));
  const maxVisitCount = Math.max(1, ...(visitStats?.statuses || []).map((item) => item.count));

  return <div className="business-reports">
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Reports</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">CRM Overview</div><h1 className="h2 mb-2">Reports</h1><p className="text-secondary mb-0">Customer responses and sales activity at a glance.</p></div></div>
    {error && <div className="alert alert-warning" role="alert">{error} <button className="btn btn-outline-secondary btn-sm ms-2" type="button" onClick={load}>Retry</button></div>}

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
