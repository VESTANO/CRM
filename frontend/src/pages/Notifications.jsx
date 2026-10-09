import { useEffect, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { tasksApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import TimedAlert from "../components/TimedAlert.jsx";

function formatReminderDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function Notifications() {
  const { csrfToken } = useAuth();
  const location = useLocation();
  const [tasks, setTasks] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const pendingTasks = tasks?.filter((task) => task.status === "pending") || [];
  const completedTasks = tasks?.filter((task) => task.status === "done") || [];

  const loadTasks = () => tasksApi.list()
    .then(({ data }) => setTasks(data.results))
    .catch(() => setError("Unable to load assigned tasks."));

  useEffect(() => {
    loadTasks();
  }, []);

  if (new URLSearchParams(location.search).has("reminder") || /^#reminder-\d+$/.test(location.hash)) {
    return <Navigate to={`/reminders${location.search}${location.hash}`} replace />;
  }

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
    <div className="page-header mb-4"><div><div className="eyebrow">Notifications</div><h1 className="h2 mb-2">Notifications</h1><p className="text-secondary mb-0">Review tasks assigned by admin.</p></div></div>

    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    <TimedAlert message={message} />

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
  </>;
}
