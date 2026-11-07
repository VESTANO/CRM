import { useState } from "react";

export default function PasswordInput({ id, name, value, onChange, autoComplete, required = false }) {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="input-group">
      <input
        id={id}
        name={name}
        className="form-control"
        type={revealed ? "text" : "password"}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        required={required}
      />
      <button
        className="btn btn-outline-secondary"
        type="button"
        aria-label={revealed ? "Hide password" : "Show password"}
        aria-pressed={revealed}
        title={revealed ? "Hide password" : "Show password"}
        onClick={() => setRevealed((current) => !current)}
      >
        <i className={`bi ${revealed ? "bi-eye-slash" : "bi-eye"}`} aria-hidden="true" />
      </button>
    </div>
  );
}
