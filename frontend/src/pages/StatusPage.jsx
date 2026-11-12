import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

// This fallback also works outside the router if the application cannot render.
export function ServerErrorPage() {
  const base = import.meta.env.MODE === "pages" || import.meta.env.VITE_PAGES_BUILD === "true" ? "/CRM" : "";
  return <main className="crm-status-page">
    <a href={`${base}/dashboard`} className="crm-status-brand" aria-label="VestaTrack CRM home">
      <span className="brand-mark">V</span><span><strong>VESTATRACK</strong><small>CRM</small></span>
    </a>
    <section className="crm-status-card" aria-labelledby="crm-server-error-title">
      <span className="crm-status-icon" aria-hidden="true"><i className="bi bi-hdd-network" /></span>
      <div className="eyebrow">ERROR 500</div>
      <h1 id="crm-server-error-title">Something went wrong</h1>
      <p>We’re having trouble loading your workspace. Please try again in a moment.</p>
      <div className="d-flex flex-wrap justify-content-center gap-3">
        <button className="btn btn-primary" type="button" onClick={() => {
          if (window.location.pathname.replace(/\/$/, "") === `${base}/500`) window.location.assign(`${base}/dashboard`);
          else window.location.reload();
        }}><i className="bi bi-arrow-clockwise me-2" aria-hidden="true" />Try again</button>
        <a className="btn btn-outline-secondary" href={`${base}/dashboard`}>Back to dashboard</a>
      </div>
      <p className="crm-status-hint">If the problem continues, contact your administrator.</p>
    </section>
    <p className="crm-status-footer">VESTATRACK · CUSTOMER CRM</p>
  </main>;
}

export default function StatusPage({ kind = "not-found", onRetry }) {
  const offline = kind === "offline";
  const navigate = useNavigate();
  const [retryMessage, setRetryMessage] = useState("");
  const retry = () => {
    if (!navigator.onLine) {
      setRetryMessage("You’re still offline. Check your Wi-Fi or mobile connection and try again.");
      return;
    }
    if (onRetry) onRetry();
    else navigate("/dashboard", { replace: true });
  };

  return <main className="crm-status-page">
    <Link to="/dashboard" className="crm-status-brand" aria-label="VestaTrack CRM home">
      <span className="brand-mark">V</span><span><strong>VESTATRACK</strong><small>CRM</small></span>
    </Link>
    <section className="crm-status-card" aria-labelledby="crm-status-title">
      <span className="crm-status-icon" aria-hidden="true"><i className={`bi ${offline ? "bi-wifi-off" : "bi-signpost-split"}`} /></span>
      <div className="eyebrow">{offline ? "CONNECTION LOST" : "ERROR 404"}</div>
      <h1 id="crm-status-title">{offline ? "No internet connection" : "Page not found"}</h1>
      <p>{offline ? "We can’t connect to your workspace right now. Check your internet connection and try again." : "The page you’re looking for may have moved, or the link may be incorrect."}</p>
      {offline ? <>
        <button className="btn btn-primary" type="button" onClick={retry}><i className="bi bi-arrow-clockwise me-2" aria-hidden="true" />Try again</button>
        <p className="crm-status-hint">Your workspace will return automatically when your connection is restored.</p>
        <div className="crm-status-retry" role="status" aria-live="polite">{retryMessage}</div>
      </> : <div className="d-flex flex-wrap justify-content-center gap-3">
        <Link className="btn btn-primary" to="/dashboard">Back to dashboard</Link>
        <button className="btn btn-outline-secondary" type="button" onClick={() => {
          if (window.history.state?.idx > 0) navigate(-1);
          else navigate("/dashboard", { replace: true });
        }}>Go back</button>
      </div>}
    </section>
    <p className="crm-status-footer">VESTATRACK · CUSTOMER CRM</p>
  </main>;
}
