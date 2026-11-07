import React from "react";
import { createRoot } from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
// Share AppLayout's Bootstrap instance to avoid duplicate drawer/scroll handlers.
import "bootstrap";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles/icon-fallback.css";
import "./styles/app.css";
import "./styles/luxe-theme.css";
import "./styles/admin.css";
import "./styles/workspace-theme.css";
import "./styles/mobile-shell.css";
import App from "./App.jsx";
import { ServerErrorPage } from "./pages/StatusPage.jsx";

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) {
    // A tab left open across a Pages deployment can request a route chunk
    // whose hashed filename no longer exists. Reload the new asset manifest
    // once; other render errors still use the normal error page.
    if (!/failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|loading (?:css )?chunk .* failed/i.test(String(error?.message || ""))) return;
    try {
      const key = `vestano-chunk-retry:${window.location.pathname}${window.location.search}`;
      const lastAttempt = Number(window.sessionStorage.getItem(key) || 0);
      if (Date.now() - lastAttempt < 60_000) return;
      window.sessionStorage.setItem(key, String(Date.now()));
      window.location.reload();
    } catch { /* Storage may be unavailable; keep the regular error page. */ }
  }
  render() {
    if (this.state.error) return <ServerErrorPage />;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
