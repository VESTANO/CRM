import { useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import PasswordInput from "../components/PasswordInput.jsx";

export default function Login() {
  const { isAuthenticated, login } = useAuth();
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);
    try {
      await login(form);
      navigate(location.state?.from?.pathname || "/dashboard", { replace: true });
    } catch (err) {
      setError(err.response?.data?.detail || "Invalid username or password.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="auth-main">
      <div className="content-wrap">
        <div className="row justify-content-center login-shell">
          <div className="col-sm-10 col-md-7 col-lg-5">
            <div className="panel login-card">
              <div className="text-center mb-4">
                <div className="brand-mark mx-auto mb-3">C</div>
                <h1 className="h3 mb-1">Customer CRM</h1>
                <p className="text-secondary mb-0">Sign in to manage customer datasets.</p>
              </div>

              {error && <div className="alert alert-danger" role="alert">{error}</div>}

              <form onSubmit={handleSubmit} noValidate>
                <div className="mb-3">
                  <label className="form-label" htmlFor="username">Username</label>
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
                <div className="mb-3">
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
                <button className="btn btn-primary w-100" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Logging in..." : "Login"}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
