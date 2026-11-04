import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { peekCachedResponse, remindersApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import TimedAlert from "../components/TimedAlert.jsx";
import { prepareReminderNotifications, reminderWorkerUrl, saveReminderWithNotifications } from "../services/reminderPush.js";

const workerUrl = reminderWorkerUrl(import.meta.env.BASE_URL);

function localDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeValue(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatReminderDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Reminders() {
  const { user, csrfToken } = useAuth();
  const [reminders, setReminders] = useState(() => peekCachedResponse("/reminders/")?.data?.results || null);
  const [values, setValues] = useState({ text: "", date: "", time: "" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState("Desktop alerts connect automatically when you set a reminder.");
  const [notificationWarning, setNotificationWarning] = useState("");
  const [showDueReminders, setShowDueReminders] = useState(false);
  const [editingReminder, setEditingReminder] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());
  const notifiedDueReminders = useRef(new Set());
  const initializedDueReminders = useRef(false);
  const now = new Date(nowTick);
  const today = localDateValue(now);
  const minTime = values.date === today ? localTimeValue(new Date(now.getTime() + 60_000)) : undefined;
  const dueReminders = reminders?.filter((reminder) => new Date(reminder.reminder_at).getTime() <= nowTick) || [];
  const visibleReminders = showDueReminders ? dueReminders : reminders?.filter((r) => new Date(r.reminder_at).getTime() > nowTick) || [];
  const upcomingReminders = reminders?.filter((reminder) => new Date(reminder.reminder_at).getTime() > nowTick) || [];

  const loadReminders = () => remindersApi.list()
    .then(({ data }) => setReminders(data.results))
    .catch(() => setError("Unable to load reminders."));

  const connectNotifications = () => prepareReminderNotifications({
    notification: "Notification" in window && "PushManager" in window ? window.Notification : null,
    serviceWorker: navigator.serviceWorker, workerUrl, ownerId: user?.id,
    loadConfig: async () => (await remindersApi.pushConfig()).data,
    saveSubscription: (subscription) => remindersApi.subscribePush(subscription, csrfToken),
  });

  useEffect(() => {
    loadReminders();
    const clockInterval = window.setInterval(() => setNowTick(Date.now()), 1000);
    const refreshInterval = window.setInterval(loadReminders, 30000);
    if ("Notification" in window && Notification.permission === "granted") {
      connectNotifications().then(() => setNotificationStatus("Desktop notifications connected."))
        .catch(() => setNotificationWarning("Desktop alerts could not reconnect. Setting a reminder will retry automatically."));
    }
    return () => {
      window.clearInterval(clockInterval);
      window.clearInterval(refreshInterval);
    };
  }, []);

  useEffect(() => {
    if (reminders === null) return;
    if (!initializedDueReminders.current) {
      dueReminders.forEach((reminder) => notifiedDueReminders.current.add(reminder.id));
      initializedDueReminders.current = true;
      return;
    }
    if (!dueReminders.length) return;
    const newlyDue = dueReminders.filter((reminder) => !notifiedDueReminders.current.has(reminder.id));
    if (!newlyDue.length) return;

    setShowDueReminders(true);
    const firstReminder = newlyDue[0];
    setMessage(`Reminder due: ${firstReminder.text}`);
    for (const reminder of newlyDue) {
      notifiedDueReminders.current.add(reminder.id);
      // System notifications are delivered once by the server and service worker.
    }
  }, [dueReminders]);

  useEffect(() => {
    if (!reminders?.length) return;
    const reminderId = new URLSearchParams(window.location.search).get("reminder") || window.location.hash.match(/^#reminder-(\d+)$/)?.[1];
    if (!reminderId) return;
    if (reminders.some((reminder) => String(reminder.id) === reminderId && new Date(reminder.reminder_at).getTime() <= Date.now())) {
      setShowDueReminders(true);
    }
    document.getElementById(`reminder-${reminderId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [reminders, showDueReminders]);

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setMessage("");
    const scheduledAt = new Date(`${values.date}T${values.time}`);
    if (!Number.isFinite(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      setError("Choose a future date and time.");
      return;
    }
    setSaving(true);
    try {
      const payload = { text: values.text, reminder_at: scheduledAt.toISOString() };
      const { notificationError } = await saveReminderWithNotifications({
        prepareNotifications: connectNotifications,
        saveReminder: () => editingReminder
          ? remindersApi.update(editingReminder.id, payload, csrfToken)
          : remindersApi.create(payload, csrfToken),
      });
      setNotificationWarning(notificationError ? `Reminder saved. ${notificationError}` : "");
      if (!notificationError) setNotificationStatus("Desktop notifications connected.");
      setValues({ text: "", date: "", time: "" });
      setMessage(editingReminder ? "Reminder updated successfully." : "Reminder set successfully.");
      setEditingReminder(null);
      await loadReminders();
    } catch (requestError) {
      const errors = requestError.response?.data?.errors;
      setError(errors ? Object.values(errors).flat().join(" ") : "Unable to set reminder.");
    } finally {
      setSaving(false);
    }
  };

  const edit = (reminder) => {
    const scheduledAt = new Date(reminder.reminder_at);
    setEditingReminder(reminder);
    setShowDueReminders(new Date(reminder.reminder_at).getTime() <= Date.now());
    setValues({ text: reminder.text, date: localDateValue(scheduledAt), time: localTimeValue(scheduledAt) });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const cancelEdit = () => {
    setEditingReminder(null);
    setValues({ text: "", date: "", time: "" });
  };

  const remove = async (reminderId) => {
    setError("");
    try {
      await remindersApi.remove(reminderId, csrfToken);
      setReminders((current) => current.filter((reminder) => reminder.id !== reminderId));
    } catch {
      setError("Unable to remove reminder.");
    }
  };

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Reminders</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">Reminders</div><h1 className="h2 mb-2">Reminders</h1><p className="text-secondary mb-0">Set personal reminders and manage browser reminder alerts.</p></div></div>

    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <TimedAlert message={message} />
    {notificationWarning && <div className="alert alert-warning" role="status">{notificationWarning}</div>}

    <section className="panel mb-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3"><h2 className="h5 mb-0">{editingReminder ? "Edit reminder" : "Set a reminder"}</h2><span className="text-secondary small">{notificationStatus}</span></div>
      <form className="row g-3 align-items-end" onSubmit={submit}>
        <div className="col-12"><label className="form-label" htmlFor="reminder-text">Reminder</label><input id="reminder-text" className="form-control" maxLength={500} placeholder="What do you need to remember?" value={values.text} onChange={(event) => setValues((current) => ({ ...current, text: event.target.value }))} required /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="reminder-date">Date</label><input id="reminder-date" className="form-control" type="date" min={today} value={values.date} onChange={(event) => setValues((current) => ({ ...current, date: event.target.value }))} required /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="reminder-time">Time</label><input id="reminder-time" className="form-control" type="time" min={minTime} value={values.time} onChange={(event) => setValues((current) => ({ ...current, time: event.target.value }))} required /></div>
        <div className="col-lg-4 d-flex flex-wrap gap-2"><button className="btn btn-primary" type="submit" disabled={saving}><i className={`bi ${editingReminder ? "bi-check-lg" : "bi-bell"} me-1`} />{saving ? "Saving..." : editingReminder ? "Save Changes" : "Set Reminder"}</button>{editingReminder && <button className="btn btn-outline-secondary" type="button" onClick={cancelEdit}>Cancel</button>}</div>
      </form>
    </section>

    <section className="panel">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h2 className="h5 mb-0">Your reminders</h2><div className="btn-group btn-group-sm"><button className={`btn ${!showDueReminders ? "btn-primary" : "btn-outline-primary"}`} type="button" onClick={() => setShowDueReminders(false)}>Upcoming ({upcomingReminders.length})</button><button className={`btn ${showDueReminders ? "btn-primary" : "btn-outline-primary"}`} type="button" onClick={() => setShowDueReminders(true)}>Due ({dueReminders.length})</button></div></div>
      {reminders === null ? <div className="text-secondary">Loading reminders...</div> : reminders.length ? (
        <div className="list-group list-group-flush">
          {visibleReminders.map((reminder) => <div className="list-group-item px-0 py-3 d-flex flex-wrap justify-content-between align-items-center gap-3" id={`reminder-${reminder.id}`} key={reminder.id}>
              <div className="min-w-0"><div className="fw-semibold">{reminder.text}</div><div className="text-secondary small">{formatReminderDate(reminder.reminder_at)}</div><div className="text-secondary small">{reminder.notification_status || "Scheduled"}</div>{reminder.last_delivery_error && <div className="text-warning small">{reminder.last_delivery_error}</div>}</div>
              <div className="d-flex align-items-center gap-2"><span className="badge text-bg-light">{showDueReminders ? "Due" : "Upcoming"}</span><button className="btn btn-outline-primary btn-sm" type="button" aria-label="Edit reminder" title="Edit reminder" onClick={() => edit(reminder)}><i className="bi bi-pencil" aria-hidden="true" /></button><button className="btn btn-outline-danger btn-sm" type="button" aria-label="Remove reminder" title="Remove reminder" onClick={() => remove(reminder.id)}><i className="bi bi-trash" aria-hidden="true" /></button></div>
            </div>)}
          {!visibleReminders.length && <div className="empty-state text-center"><p className="text-secondary mb-0">{showDueReminders ? "No due reminders." : "No upcoming reminders."}</p></div>}
        </div>
      ) : <div className="empty-state text-center"><h3 className="h5">No reminders yet</h3><p className="text-secondary mb-0">Your reminders will appear here.</p></div>}
    </section>
  </>;
}
