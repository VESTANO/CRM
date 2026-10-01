import { useEffect, useState } from "react";

export default function TimedAlert({ message, variant = "success" }) {
  const [visible, setVisible] = useState(Boolean(message));

  useEffect(() => {
    setVisible(Boolean(message));
    if (!message) return undefined;
    const timeout = window.setTimeout(() => setVisible(false), 5000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  if (!message || !visible) return null;

  return (
    <div className={`alert alert-${variant} alert-dismissible fade show`} role={variant === "success" ? "status" : "alert"}>
      {message}
      <button className="btn-close" type="button" aria-label="Dismiss message" onClick={() => setVisible(false)} />
    </div>
  );
}
