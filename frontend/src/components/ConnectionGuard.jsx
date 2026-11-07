import { useCallback, useEffect, useRef, useState } from "react";
import StatusPage from "../pages/StatusPage.jsx";
import { CRM_SUPABASE_PUBLISHABLE_KEY, CRM_SUPABASE_URL } from "../services/crmSupabase.js";
import { createConnectionMonitor } from "../services/connectionMonitor.js";

export default function ConnectionGuard({ children }) {
  const [online, setOnline] = useState(() => navigator.onLine);
  const [reconnected, setReconnected] = useState(false);
  const previousOnline = useRef(navigator.onLine);
  const dismissTimer = useRef();
  const monitor = useRef();

  const updateStatus = useCallback((connected) => {
    if (connected && !previousOnline.current) {
      setReconnected(true);
      window.clearTimeout(dismissTimer.current);
      dismissTimer.current = window.setTimeout(() => setReconnected(false), 5000);
    } else if (!connected) {
      setReconnected(false);
      window.clearTimeout(dismissTimer.current);
    }
    previousOnline.current = connected;
    setOnline(connected);
  }, []);

  const checkConnection = useCallback(() => monitor.current?.check(), []);

  useEffect(() => {
    const connection = createConnectionMonitor({
      onStatus: updateStatus,
      probe: async (signal) => {
        const response = await fetch(`${CRM_SUPABASE_URL}/auth/v1/health?connection_probe=${Date.now()}`, {
          method: "GET",
          cache: "no-store",
          headers: { apikey: CRM_SUPABASE_PUBLISHABLE_KEY },
          signal,
        });
        return response.ok;
      },
    });
    monitor.current = connection;
    return () => {
      connection.dispose();
      monitor.current = undefined;
      window.clearTimeout(dismissTimer.current);
    };
  }, [updateStatus]);

  return <>
    {online && reconnected && <div className="crm-connection-restored" role="status" aria-live="polite" aria-atomic="true">
      <span className="crm-connection-icon" aria-hidden="true"><i className="bi bi-wifi" /></span>
      <div><strong>Back online</strong><span>Your internet connection has been restored.</span></div>
      <button type="button" aria-label="Dismiss connection message" onClick={() => setReconnected(false)}><i className="bi bi-x-lg" aria-hidden="true" /></button>
    </div>}
    {!online && <StatusPage kind="offline" onRetry={checkConnection} />}
    {/* Keep the workspace mounted so connection loss does not erase form inputs. */}
    <div hidden={!online} style={!online ? { display: "none" } : undefined}>{children}</div>
  </>;
}
