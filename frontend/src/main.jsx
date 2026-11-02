import React from "react";
import { createRoot } from "react-dom/client";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap/dist/js/bootstrap.bundle.min.js";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./styles/app.css";
import "./styles/luxe-theme.css";
import "./styles/admin.css";
import App from "./App.jsx";

class AppErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return <div className="panel m-4"><h1 className="h4">CRM could not load</h1><p className="text-secondary">{this.state.error.message || "Unexpected application error."}</p><button className="btn btn-primary" type="button" onClick={() => window.location.reload()}>Reload CRM</button></div>;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </React.StrictMode>
);
