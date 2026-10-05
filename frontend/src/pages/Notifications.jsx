import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { remindersApi, tasksApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import TimedAlert from "../components/TimedAlert.jsx";

function localDateValue(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function localTimeValue(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatReminderDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function decodeApplicationKey(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

export default function Notifications() {
  const { csrfToken } = useAuth();
  const [reminders, setReminders] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [values, setValues] = useState({ text: "", date: "", time: "" });
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushPermission, setPushPermission] = useState("default");
  const [pushSupported, setPushSupported] = useState(true);
  const [pushBusy, setPushBusy] = useState(false);
  const [showDueReminders, setShowDueReminders] = useState(false);
  const [editingReminder, setEditingReminder] = useState(null);
  const now = new Date();
  const today = localDateValue(now);
  const minTime = values.date === today ? localTimeValue(new Date(now.getTime() + 60_000)) : undefined;
  const dueReminders = reminders?.filter((reminder) => new Date(reminder.reminder_at).getTime() <= Date.now()) || [];
  const upcomingReminders = reminders?.filter((reminder) => new Date(reminder.reminder_at).getTime() > Date.now()) || [];
  const pendingTasks = tasks?.filter((task) => task.status === "pending") || [];
  const completedTasks = tasks?.filter((task) => task.status === "done") || [];

  const loadReminders = () => remindersApi.list()
    .then(({ data }) => setReminders(data.results))
    .catch(() => setError("Unable to load reminders."));

  const loadTasks = () => tasksApi.list()
    .then(({ data }) => setTasks(data.results))
    .catch(() => setError("Unable to load assigned tasks."));

  useEffect(() => {
    loadReminders();
    loadTasks();
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    setPushSupported(supported);
    if (!supported) return;
    setPushPermission(Notification.permission);
    navigator.serviceWorker.register("/service-worker.js")
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => setPushEnabled(Boolean(subscription) && Notification.permission === "granted"))
      .catch(() => {});
  }, []);

  const enablePush = async () => {
    setPushBusy(true);
    setError("");
    setMessage("");
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        throw new Error("This browser does not support push notifications.");
      }
      const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
      setPushPermission(permission);
      if (permission !== "granted") throw new Error("Allow notifications in your browser to receive reminders.");
      const { data } = await remindersApi.pushConfig();
      const legacyRegistration = await navigator.serviceWorker.getRegistration("/static/js/");
      const legacySubscription = await legacyRegistration?.pushManager.getSubscription();
      if (legacySubscription) {
        await remindersApi.removePush(legacySubscription.endpoint, csrfToken);
        await legacySubscription.unsubscribe();
        await legacyRegistration.unregister();
      }
      const registration = await navigator.serviceWorker.register("/service-worker.js");
      const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeApplicationKey(data.publicKey),
      });
      await remindersApi.subscribePush(subscription.toJSON(), csrfToken);
      setPushEnabled(true);
      setMessage("Browser notifications are enabled on this device.");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || requestError.message || "Unable to enable browser notifications.");
    } finally {
      setPushBusy(false);
    }
  };

  const disablePush = async () => {
    setPushBusy(true);
    setError("");
    setMessage("");
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        const subscription = await registration.pushManager?.getSubscription();
        if (!subscription) continue;
        await remindersApi.removePush(subscription.endpoint, csrfToken);
        await subscription.unsubscribe();
      }
      setPushEnabled(false);
      setMessage("Browser notifications are disabled on this device.");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || requestError.message || "Unable to disable browser notifications.");
    } finally {
      setPushBusy(false);
    }
  };

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
    if (scheduledAt.getTime() <= Date.now()) {
      setError("Choose a future date and time.");
      return;
    }
    setSaving(true);
    try {
      const payload = { text: values.text, reminder_at: scheduledAt.toISOString() };
      if (editingReminder) {
        await remindersApi.update(editingReminder.id, payload, csrfToken);
      } else {
        await remindersApi.create(payload, csrfToken);
      }
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

  const completeTask = async (taskId) => {
    setError("");
    setMessage("");
    try {
      await tasksApi.update(taskId, { status: "done" }, csrfToken);
      setMessage("Task marked as completed.");
      await loadTasks();
      window.dispatchEvent(new Event("crm:tasks-updated"));
    } catch {
      setError("Unable to update task.");
    }
  };

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Notifications</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">Notifications</div><h1 className="h2 mb-2">Notifications</h1><p className="text-secondary mb-0">Set reminders and review tasks assigned by admin.</p></div></div>

    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <TimedAlert message={message} />

    <section className="panel mb-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-3 mb-3"><h2 className="h5 mb-0">{editingReminder ? "Edit reminder" : "Set a reminder"}</h2><div className="d-flex align-items-center gap-2">{!pushSupported ? <span className="text-secondary small">Browser notifications are not supported.</span> : pushPermission === "denied" ? <span className="text-secondary small">Notifications are blocked in browser settings.</span> : pushEnabled ? <><span className="text-success small">Notifications enabled</span><button className="btn btn-outline-secondary btn-sm" type="button" onClick={disablePush} disabled={pushBusy}>Disable</button></> : <button className="btn btn-outline-primary btn-sm" type="button" onClick={enablePush} disabled={pushBusy}><i className="bi bi-bell me-1" />{pushBusy ? "Enabling..." : "Enable browser notifications"}</button>}</div></div>
      <form className="row g-3 align-items-end" onSubmit={submit}>
        <div className="col-12"><label className="form-label" htmlFor="reminder-text">Reminder</label><input id="reminder-text" className="form-control" maxLength={500} placeholder="What do you need to remember?" value={values.text} onChange={(event) => setValues((current) => ({ ...current, text: event.target.value }))} required /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="reminder-date">Date</label><input id="reminder-date" className="form-control" type="date" min={today} value={values.date} onChange={(event) => setValues((current) => ({ ...current, date: event.target.value }))} required /></div>
        <div className="col-sm-6 col-lg-4"><label className="form-label" htmlFor="reminder-time">Time</label><input id="reminder-time" className="form-control" type="time" min={minTime} value={values.time} onChange={(event) => setValues((current) => ({ ...current, time: event.target.value }))} required /></div>
        <div className="col-lg-4 d-flex flex-wrap gap-2"><button className="btn btn-primary" type="submit" disabled={saving}><i className={`bi ${editingReminder ? "bi-check-lg" : "bi-bell"} me-1`} />{saving ? "Saving..." : editingReminder ? "Save Changes" : "Set Reminder"}</button>{editingReminder && <button className="btn btn-outline-secondary" type="button" onClick={cancelEdit}>Cancel</button>}</div>
      </form>
    </section>

    <section className="panel mb-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h5 mb-0">Task notifications</h2>
        {pendingTasks.length > 0 ? (
          <span className="badge text-bg-danger">
            <i className="bi bi-bell-fill me-1" />
            {pendingTasks.length} new
          </span>
        ) : (
          <span className="badge text-bg-light">No new tasks</span>
        )}
      </div>
      {tasks === null ? <div className="text-secondary">Loading assigned tasks...</div> : tasks.length ? (
        <div className="list-group list-group-flush">
          {pendingTasks.map((task) => (
            <div className="list-group-item px-0 py-3 d-flex flex-wrap justify-content-between align-items-start gap-3" key={task.id}>
              <div className="min-w-0">
                <div className="fw-semibold">
                  <span className="badge text-bg-danger me-2">New</span>
                  {task.title}
                </div>
                {task.note && <div className="text-secondary small mt-1">{task.note}</div>}
                <div className="text-secondary small mt-1">
                  {task.assigned_by_username ? `Assigned by ${task.assigned_by_username}` : "Assigned by admin"}
                  {task.due_at ? ` · Due ${formatReminderDate(task.due_at)}` : ""}
                </div>
              </div>
              <button className="btn btn-outline-success btn-sm" type="button" onClick={() => completeTask(task.id)}>
                <i className="bi bi-check2 me-1" />
                Mark Done
              </button>
            </div>
          ))}
          {completedTasks.map((task) => (
            <div className="list-group-item px-0 py-3 d-flex flex-wrap justify-content-between align-items-start gap-3" key={task.id}>
              <div className="min-w-0">
                <div className="fw-semibold text-secondary">{task.title}</div>
                {task.note && <div className="text-secondary small mt-1">{task.note}</div>}
                <div className="text-secondary small mt-1">
                  Completed
                  {task.due_at ? ` · Due ${formatReminderDate(task.due_at)}` : " · No deadline"}
                </div>
              </div>
              <span className="badge text-bg-success">Completed</span>
            </div>
          ))}
        </div>
      ) : <div className="empty-state text-center"><h3 className="h5">No assigned tasks</h3><p className="text-secondary mb-0">Tasks assigned by admin will appear here.</p></div>}
    </section>

    <section className="panel">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3"><h2 className="h5 mb-0">Your reminders</h2>{dueReminders.length > 0 && <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setShowDueReminders((visible) => !visible)} aria-expanded={showDueReminders}>{showDueReminders ? "Hide due reminders" : "Show due reminders"}</button>}</div>
      {reminders === null ? <div className="text-secondary">Loading reminders...</div> : reminders.length ? (
        <div className="list-group list-group-flush">
          {upcomingReminders.map((reminder) => <div className="list-group-item px-0 py-3 d-flex flex-wrap justify-content-between align-items-center gap-3" id={`reminder-${reminder.id}`} key={reminder.id}>
              <div className="min-w-0"><div className="fw-semibold">{reminder.text}</div><div className="text-secondary small">{formatReminderDate(reminder.reminder_at)}</div></div>
              <div className="d-flex align-items-center gap-2"><span className="badge text-bg-light">Upcoming</span><button className="btn btn-outline-primary btn-sm" type="button" aria-label="Edit reminder" title="Edit reminder" onClick={() => edit(reminder)}><i className="bi bi-pencil" aria-hidden="true" /></button><button className="btn btn-outline-danger btn-sm" type="button" aria-label="Remove reminder" title="Remove reminder" onClick={() => remove(reminder.id)}><i className="bi bi-trash" aria-hidden="true" /></button></div>
            </div>)}
          {showDueReminders && dueReminders.map((reminder) => <div className="list-group-item px-0 py-3 d-flex flex-wrap justify-content-between align-items-center gap-3" id={`reminder-${reminder.id}`} key={reminder.id}>
              <div className="min-w-0"><div className="fw-semibold">{reminder.text}</div><div className="text-secondary small">{formatReminderDate(reminder.reminder_at)}</div></div>
              <div className="d-flex align-items-center gap-2"><span className="badge text-bg-warning">Due</span><button className="btn btn-outline-primary btn-sm" type="button" aria-label="Edit reminder" title="Edit reminder" onClick={() => edit(reminder)}><i className="bi bi-pencil" aria-hidden="true" /></button><button className="btn btn-outline-danger btn-sm" type="button" aria-label="Remove reminder" title="Remove reminder" onClick={() => remove(reminder.id)}><i className="bi bi-trash" aria-hidden="true" /></button></div>
            </div>)}
          {!upcomingReminders.length && !showDueReminders && <div className="empty-state text-center"><p className="text-secondary mb-0">No upcoming reminders.</p></div>}
        </div>
      ) : <div className="empty-state text-center"><h3 className="h5">No reminders yet</h3><p className="text-secondary mb-0">Your reminders will appear here.</p></div>}
    </section>
  </>;
}
