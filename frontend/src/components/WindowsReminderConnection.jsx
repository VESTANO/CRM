import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth.jsx";
import { apiClient, remindersApi } from "../services/api.js";
import { clearReminderDevice, reminderWorkerUrl } from "../services/reminderPush.js";

export default function WindowsReminderConnection() {
  const { user } = useAuth();
  const code = new URLSearchParams(window.location.search).get("windows_pair") || "";
  const [devices, setDevices] = useState([]), [message,setMessage] = useState(""), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const load = () => apiClient.get("/native-reminder-devices/").then(r=>setDevices(r.data.results));
  useEffect(()=>{load().catch(()=>{});},[]);
  const approve = async () => {
    setBusy(true); setError("");
    try {
      const {data} = await apiClient.post("/native-reminder-devices/approve/",{pair_code:code});
      window.localStorage.setItem("crm:native-reminder-owner",user.id);
      window.localStorage.setItem("crm:native-reminder-device",data.id);
      await clearReminderDevice({serviceWorker:navigator.serviceWorker,workerUrl:reminderWorkerUrl(import.meta.env.BASE_URL),removeSubscription:endpoint=>remindersApi.removePush(endpoint,"")}).catch(()=>{});
      setMessage("Windows notifier connected. Future reminders can appear without Chrome running.");
      await load();
    } catch(e) {setError(e.response?.data?.detail||"Unable to connect the Windows notifier.");}
    finally {setBusy(false);}
  };
  const disconnect = async id => {
    setBusy(true); setError("");
    try {
      await apiClient.delete(`/native-reminder-devices/${id}/`);
      if(window.localStorage.getItem("crm:native-reminder-device")===id) {
        window.localStorage.removeItem("crm:native-reminder-owner");
        window.localStorage.removeItem("crm:native-reminder-device");
      }
      await load(); setMessage("Windows notifier disconnected from this CRM account.");
    } catch {setError("Unable to disconnect the Windows notifier.");}
    finally {setBusy(false);}
  };
  if(!code && !devices.length) return null;
  return <section className="panel mb-4"><h2 className="h5">Windows desktop reminders</h2>
    {code && !message && <><p>Connect the Windows notifier you just installed to <strong>{user.username}</strong>. It can read this account’s reminders and show them on this PC while Chrome is closed.</p><button className="btn btn-primary" type="button" onClick={approve} disabled={busy}>Connect this PC</button></>}
    {message && <p className="text-success mt-3" role="status">{message}</p>}{error && <p className="text-danger mt-3" role="alert">{error}</p>}
    {devices.map(d=><div className="d-flex justify-content-between align-items-center gap-2 mt-3" key={d.id}><span>Connected Windows notifier <small className="text-secondary">{d.last_seen_at ? ` · Last connected ${new Date(d.last_seen_at).toLocaleString()}` : " · Waiting for the PC to connect"}</small></span><button className="btn btn-outline-secondary btn-sm" type="button" disabled={busy} onClick={()=>disconnect(d.id)}>Disconnect</button></div>)}
  </section>;
}
