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
