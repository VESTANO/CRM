export function LoadingPanel({ label = "Loading content" }) {
  return <section className="panel request-loading" role="status" aria-live="polite" aria-label={label}>
    <span className="request-skeleton request-skeleton-title" />
    <span className="request-skeleton" />
    <span className="request-skeleton request-skeleton-short" />
    <span className="visually-hidden">{label}</span>
  </section>;
}

export function RequestError({ message = "Unable to load this page.", onRetry }) {
  return <section className="panel request-error" role="alert">
    <h1 className="h5 mb-2">We could not load this content</h1>
    <p className="text-secondary mb-3">{message}</p>
    {onRetry && <button className="btn btn-primary" type="button" onClick={onRetry}>Retry</button>}
  </section>;
}

export function AppBootLoader({ label = "Preparing your CRM workspace" }) {
  return <main className="crm-boot-loader" role="status" aria-live="polite">
    <section className="crm-boot-card">
      <div className="crm-boot-brand"><span className="brand-mark">V</span><span><strong>VESTANO</strong><small>Customer CRM</small></span></div>
      <div className="crm-boot-spinner" aria-hidden="true" />
      <h1>{label}</h1>
      <p>Restoring your secure session and loading the workspace.</p>
      <div className="crm-boot-progress" aria-hidden="true"><span /></div>
    </section>
  </main>;
}

// Route chunks normally arrive in a moment. Keep the CRM shell visible while
// that happens instead of replacing the whole workspace with the boot card.
export function RouteLoadingIndicator({ label = "Opening page" }) {
  return <div className="route-loading-indicator" role="status" aria-live="polite">
    <span aria-hidden="true" />
    <span className="visually-hidden">{label}</span>
  </div>;
}
