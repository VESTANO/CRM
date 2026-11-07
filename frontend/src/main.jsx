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
