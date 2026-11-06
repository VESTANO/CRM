import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { crmSupabase } from "../services/crmSupabase.js";
import PasswordInput from "./PasswordInput.jsx";

// Supabase recovery links can arrive in either implicit form (#type=recovery)
// or the newer PKCE form (?code=...).  Detect both before the auth client has
// a chance to consume the URL, otherwise a valid recovery link can briefly
// render the normal sign-in page.
const startupRecovery = typeof window !== "undefined" && (() => {
  const query = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.slice(1));
  return hash.get("type") === "recovery" || query.has("code");
})();

export default function PasswordRecoveryGate({ children }) {
  const [recovering, setRecovering] = useState(startupRecovery);
  const navigate = useNavigate();

  useEffect(() => {
    const { data } = crmSupabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!recovering) return children;
  return <PasswordRecovery onComplete={() => {
    setRecovering(false);
    navigate("/dashboard", { replace: true });
  }} onCancel={() => {
    setRecovering(false);
    navigate("/login", { replace: true });
  }} />;
}

function PasswordRecovery({ onComplete, onCancel }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [checking, setChecking] = useState(true);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const verifyRecoveryLink = async () => {
      const recoveryCode = new URLSearchParams(window.location.search).get("code");

      // Exchange PKCE links explicitly. This also handles a page load where
      // Supabase's automatic URL processing completed before our listener.
      if (recoveryCode) {
        const { error: exchangeError } = await crmSupabase.auth.exchangeCodeForSession(recoveryCode);
        if (exchangeError) {
          // The SDK may already have exchanged this code. In that case the
          // session check below is authoritative.
          const { data } = await crmSupabase.auth.getSession();
          if (!data.session) throw exchangeError;
        }
      }

      const { data, error: sessionError } = await crmSupabase.auth.getSession();
      if (!data.session || sessionError) {
        throw sessionError || new Error("No recovery session");
      }
      if (active) setReady(true);
    };

    verifyRecoveryLink().catch(() => {
      if (active) setError("This password setup link has expired or is invalid. Ask your administrator for a new link.");
    }).finally(() => {
      if (active) setChecking(false);
    });
    return () => { active = false; };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (!ready || checking || saving) return;
    if (password.length < 8) {
      setError("Your password must have at least 8 characters.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const { error: updateError } = await crmSupabase.auth.updateUser({ password });
      if (updateError) throw updateError;
      setPassword("");
      setConfirmation("");
      onComplete();
    } catch (updateError) {
      setError(updateError.message || "Unable to save your password. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return <main className="crm-status-page">
    <div className="crm-status-brand" aria-label="Vestano CRM">
      <span className="brand-mark">V</span><span><strong>VESTANO</strong><small>Customer CRM</small></span>
    </div>
    <section className="login-card" aria-labelledby="password-setup-heading">
      <div className="eyebrow">ACCOUNT ACCESS</div>
      <h1 className="h3" id="password-setup-heading">Set your password</h1>
      <p className="login-intro">Choose a password for your CRM and attendance account.</p>
      {checking && <p role="status">Checking your password setup link…</p>}
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      {ready && <form onSubmit={submit}>
        <fieldset disabled={saving}>
          <div className="mb-3">
            <label className="form-label" htmlFor="recovery-password">New password</label>
            <PasswordInput id="recovery-password" name="password" value={password}
              onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
            <div className="form-text">Use at least 8 characters.</div>
          </div>
          <div className="mb-4">
            <label className="form-label" htmlFor="recovery-confirmation">Confirm password</label>
            <PasswordInput id="recovery-confirmation" name="confirmation" value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required />
          </div>
          <button className="btn btn-primary w-100" type="submit">
            {saving ? "Saving password…" : "Save password and open CRM"}
          </button>
        </fieldset>
      </form>}
      {!checking && !ready && <button className="btn btn-outline-secondary w-100" type="button" onClick={onCancel}>Back to sign in</button>}
    </section>
  </main>;
}
