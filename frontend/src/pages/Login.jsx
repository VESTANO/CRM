import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import PasswordInput from "../components/PasswordInput.jsx";
import { dashboardApi, targetsApi } from "../services/api.js";

export default function Login() {
  const { isAuthenticated, login } = useAuth();
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await login(form);
      // Start the dashboard reads immediately; targets must not delay opening
      // the workspace after authentication has already succeeded.
      void dashboardApi.summary().catch(() => {});
      void targetsApi.list().catch(() => {});
      // A CRM sign-in always begins at the CRM dashboard. Attendance is an
      // optional workspace reached from the sidebar after sign-in.
      navigate("/dashboard", {
        replace: true,
      });
    } catch (err) {
      setError(err.response?.data?.detail || "Invalid username or password.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-main luxe-login">
      <aside className="login-brand-panel" aria-label="Vestano CRM">
        <div className="login-brand-top">
          <span className="brand-mark">V</span>
          <span><strong>VESTANO</strong><small>INTERNATIONAL</small></span>
        </div>
        <div className="login-brand-story">
          <span className="login-eyebrow">CUSTOMER RELATIONSHIPS</span>
          <h2>Good service<br /><em>moves business</em><br />forward.</h2>
          <p>Customer lists, follow-ups and sales activity, gathered in one considered workspace.</p>
          <div className="login-brand-rule" />
          <div className="login-brand-caption"><span>01</span><span>THE VESTANO CRM WORKSPACE</span></div>
        </div>
        <div className="login-brand-footer"><span>VESTANO CRM</span><span>EST. 2018</span></div>
      </aside>

      <section className="login-access-panel">
        <div className="login-access-top"><span>STAFF ACCESS</span><span>SECURE WORKSPACE</span></div>
        <div className="login-card">
          <div className="login-card-mark">V</div>
          <div className="eyebrow">WELCOME BACK</div>
          <h1>Sign in</h1>
          <p className="login-intro">Sign in to your CRM workspace.</p>

          {error && <div className="alert alert-danger" role="alert">{error}</div>}

          <form onSubmit={handleSubmit} noValidate>
            <div className="mb-3">
              <label className="form-label" htmlFor="username">Username or email</label>
              <input
                id="username"
                className="form-control"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                autoComplete="username"
                required
                autoFocus
              />
            </div>
            <div className="mb-4">
              <label className="form-label" htmlFor="password">Password</label>
              <PasswordInput
                id="password"
                name="password"
                value={form.password}
                onChange={(event) => setForm({ ...form, password: event.target.value })}
                autoComplete="current-password"
                required
              />
            </div>
            <button className="btn btn-primary w-100 login-submit" type="submit" disabled={isSubmitting}>
              <span>{isSubmitting ? "Logging in..." : "Continue to CRM"}</span>
              {!isSubmitting && <i className="bi bi-arrow-right" aria-hidden="true" />}
            </button>
          </form>
          <div className="login-security-note"><i className="bi bi-shield-lock" aria-hidden="true" /> Your account is protected</div>
        </div>
        <div className="login-access-footer"><span>VESTANO / CUSTOMER OPERATIONS</span><span>© {new Date().getFullYear()}</span></div>
      </section>
    </main>
  );
}
