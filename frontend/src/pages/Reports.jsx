import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { dashboardApi, salesApi } from "../services/api.js";
import { formatCurrency } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";

const chartPalette = [
  { fill: "#abc8ea", border: "#557da9", text: "#304c69" },
  { fill: "#acd8ba", border: "#548564", text: "#31573d" },
  { fill: "#edb8bd", border: "#a95e68", text: "#743c45" },
  { fill: "#eed69a", border: "#9d7925", text: "#644b16" },
  { fill: "#a6d4d4", border: "#4b8585", text: "#2d5a5a" },
  { fill: "#c6b8df", border: "#78649f", text: "#51416f" },
];
const customerColors = chartPalette.slice(0, 5);
const visitColors = [chartPalette[0], chartPalette[3], chartPalette[1], chartPalette[2], chartPalette[5]];
const monthFormatter = new Intl.DateTimeFormat("en", { month: "short" });

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export default function Reports() {
  const [customerStats, setCustomerStats] = useState(null);
  const [visits, setVisits] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([dashboardApi.summary(), salesApi.list()])
      .then(([dashboardResponse, visitResponse]) => {
        setCustomerStats(dashboardResponse.data);
        setVisits(visitResponse.data.results);
      })
      .catch(() => setError("Unable to load reports."));
  }, []);

  const visitStats = useMemo(() => {
    if (!visits) return null;

    const statuses = new Map();
    const months = new Map();
    let totalExpenses = 0;
    for (const visit of visits) {
      statuses.set(visit.status, {
        label: visit.status_label,
        count: (statuses.get(visit.status)?.count || 0) + 1,
      });
      totalExpenses += Number(visit.expense || 0);
      const date = new Date(`${visit.visit_date}T00:00:00`);
      if (!Number.isNaN(date.getTime())) {
        const key = monthKey(date);
        months.set(key, { date, count: (months.get(key)?.count || 0) + 1 });
      }
    }

    const recentMonths = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setDate(1);
      date.setMonth(date.getMonth() - (5 - index));
      const key = monthKey(date);
      return { key, label: monthFormatter.format(date), count: months.get(key)?.count || 0 };
    });

    return {
      statuses: Array.from(statuses, ([value, data]) => ({ value, ...data })),
      recentMonths,
      totalExpenses,
      totalVisits: visits.length,
      activeMonths: Array.from(months.values()).filter((month) => month.count > 0).length,
    };
  }, [visits]);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!customerStats || !visitStats) return <div className="panel">Loading reports...</div>;

  const maxCustomerCount = Math.max(1, ...customerStats.responseStats.map((item) => item.count));
  const maxVisitCount = Math.max(1, ...visitStats.statuses.map((item) => item.count));

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Reports</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">CRM Overview</div><h1 className="h2 mb-2">Reports</h1><p className="text-secondary mb-0">Customer responses and sales activity at a glance.</p></div></div>

    <section className="panel mb-4" aria-labelledby="customer-insights-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3"><div><h2 className="h4 mb-1" id="customer-insights-heading">Customer Insights</h2><p className="text-secondary mb-0">Customer response across your accessible datasets.</p></div><Link className="btn btn-outline-primary btn-sm" to="/datasets">Customer Lists</Link></div>
      <div className="reports-summary-grid mb-4">
        <Summary label="Total customers" value={customerStats.totalCustomers} icon="bi-people" />
        <Summary label="Datasets" value={customerStats.totalDatasets} icon="bi-folder2-open" />
      </div>
      <Breakdown title="Customer response" items={customerStats.responseStats.map((item, index) => ({ ...item, color: customerColors[index % customerColors.length] }))} max={maxCustomerCount} />
    </section>

    <section className="panel" aria-labelledby="sales-insights-heading">
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
    </section>
  </>;
}

function Summary({ label, value, icon }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className="summary-card compact"><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className="reports-summary-value"><AnimatedNumber value={value} active={isVisible} /></div></div>;
}

function Breakdown({ title, items, max, empty = "No customer data recorded yet." }) {
  const [ref, isVisible] = useRevealOnView();
  return <div ref={ref} className={`reports-chart-reveal ${isVisible ? "is-visible" : ""}`}><h3 className="h6 mb-3">{title}</h3>{items.length ? <div className="reports-breakdown">{items.map((item) => <div className="reports-breakdown-row" key={item.value}><div className="reports-breakdown-label">{item.label}</div><div className="reports-breakdown-track"><div className="reports-breakdown-bar" style={{ width: `${(item.count / max) * 100}%`, "--bar-fill": item.color.fill, "--bar-border": item.color.border }} /></div><div className="reports-breakdown-count" style={{ color: item.color.text }}><AnimatedNumber value={item.count} active={isVisible} /></div></div>)}</div> : <p className="text-secondary mb-0">{empty}</p>}</div>;
}

function MonthlyTrend({ months }) {
  const [activeIndex, setActiveIndex] = useState(null);
  const [ref, isVisible] = useRevealOnView();
  const max = Math.max(1, ...months.map((month) => month.count));
  const points = months.map((month, index) => {
    const x = 8 + (index * 84) / (months.length - 1);
    const y = 70 - (month.count / max) * 42;
    return { ...month, x, y };
  });
  const path = points.map(({ x, y }, index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
  const scatterOffsets = [[-18, -18], [8, -25], [19, 12], [-12, 20], [20, -16], [-17, 10]];

  return <div ref={ref} className={`reports-trend reports-chart-reveal ${isVisible ? "is-visible" : ""}`} role="img" aria-label={`Visit counts over the last six months: ${months.map(({ label, count }) => `${label} ${count}`).join(", ")}`} onMouseLeave={() => setActiveIndex(null)}>
    <svg className="reports-trend-line" viewBox="0 0 100 80" preserveAspectRatio="none" aria-hidden="true">
      <path d={path} pathLength="100" />
    </svg>
    <div className="reports-trend-markers" aria-hidden="true">{points.map((point, index) => <span className={`reports-trend-marker ${point.count ? "has-visits" : "no-visits"} ${activeIndex === index ? "is-active" : ""}`} key={point.key} style={{ left: `${point.x}%`, top: `${(point.y / 80) * 100}%`, "--scatter-x": `${scatterOffsets[index % scatterOffsets.length][0]}px`, "--scatter-y": `${scatterOffsets[index % scatterOffsets.length][1]}px` }} onMouseEnter={() => setActiveIndex(index)}><AnimatedNumber value={point.count} active={isVisible} /></span>)}</div>
    <div className="reports-trend-months" aria-hidden="true">{points.map((point, index) => <span className={activeIndex === index ? "is-active" : ""} key={point.key} onMouseEnter={() => setActiveIndex(index)}>{point.label}</span>)}</div>
  </div>;
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
