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
        aria-label={revealed ? "Hide password" : "Show password while hovering"}
        title={revealed ? "Hide password" : "Show password while hovering"}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setRevealed(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setRevealed(false);
        }}
        onPointerDown={(event) => {
          if (event.pointerType === "touch") setRevealed((current) => !current);
        }}
        onFocus={() => setRevealed(true)}
        onBlur={() => setRevealed(false)}
      >
        <i className={`bi ${revealed ? "bi-eye-slash" : "bi-eye"}`} aria-hidden="true" />
      </button>
    </div>
  );
}
