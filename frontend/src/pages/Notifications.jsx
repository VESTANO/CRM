import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import { useTasks } from "../hooks/useTasks.js";
import { useTaskClock } from "../hooks/useTaskClock.js";
import { getTaskStatus, isTaskOverdue, compareNewestTasks } from "../utils/tasks.js";
import TaskStatusBadge from "../components/TaskStatusBadge.jsx";
import TimedAlert from "../components/TimedAlert.jsx";
import TaskPhotos from "../components/TaskPhotos.jsx";
import TaskCompletionForm from "../components/TaskCompletionForm.jsx";
import TaskReviewForm from "../components/TaskReviewForm.jsx";
import TaskSubmissionDetails from "../components/TaskSubmissionDetails.jsx";
import { formatDateTime } from "../utils/formatters.js";
import TaskNotificationInbox from "../components/TaskNotificationInbox.jsx";
import "../styles/mobile-tasks.css";

export default function Notifications() {
  const { csrfToken, user } = useAuth();
  const location = useLocation();
  const isAdmin = Boolean(user?.is_admin);
  const { tasks, error: taskError, refresh: loadTasks } = useTasks({ all: isAdmin });
  const now = useTaskClock(tasks);
  const [message, setMessage] = useState("");
  const scrolledTo = useRef("");
  const actionCount = tasks?.filter((task) => ["pending", "rejected"].includes(task.status)).length || 0;
  const awaitingCount = tasks?.filter((task) => task.status === "submitted").length || 0;
  const overdueCount = tasks?.filter((task) => isTaskOverdue(task, now)).length || 0;
  const order = isAdmin ? { submitted: 0, rejected: 1, pending: 2, done: 3 } : { rejected: 0, pending: 1, submitted: 2, done: 3 };
  const visibleTasks = (tasks || []).filter((task) => !isAdmin || task.current_submission || task.status === "done")
    .slice().sort(isAdmin ? (a, b) => order[a.status] - order[b.status] : compareNewestTasks);
  useEffect(() => {
    const target = location.hash.slice(1);
    if (!/^task-\d+$/.test(target)) { scrolledTo.current = ""; return; }
    const key = `${location.key}|${target}`;
    const element = document.getElementById(target);
    if (element && scrolledTo.current !== key) {
      element.scrollIntoView({ behavior: "smooth", block: "start" });
      scrolledTo.current = key;
    }
  }, [location.hash, location.key, tasks]);

  if (new URLSearchParams(location.search).has("reminder") || /^#reminder-\d+$/.test(location.hash)) {
    return <Navigate to={`/reminders${location.search}${location.hash}`} replace />;
  }
  const taskSaved = (successMessage) => { setMessage(successMessage); loadTasks(); };

  return <div className="task-notifications-workspace">
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item active" aria-current="page">Notifications</li></ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">Notifications</div><h1 className="h2 mb-2">Notifications</h1><p className="text-secondary mb-0">{isAdmin ? "Review submitted work and approve it or return it with a rejection note." : "Review assigned tasks, submit your work, and follow admin feedback."}</p></div></div>
    {taskError && <div className="alert alert-danger" role="alert">{taskError}</div>}
    <TimedAlert message={message} />
    <TaskNotificationInbox />
    <section className="panel mb-4">
      <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
        <h2 className="h5 mb-0">{isAdmin ? "Task reviews" : "Task notifications"}</h2>
        <div className="d-flex flex-wrap gap-2">
          {!isAdmin && actionCount > 0 && <span className="badge task-status-pending">{actionCount} needing action</span>}
          {awaitingCount > 0 && <span className="badge task-status-submitted">{awaitingCount} awaiting approval</span>}
          {!isAdmin && overdueCount > 0 && <span className="badge task-status-overdue">{overdueCount} overdue</span>}
        </div>
      </div>
      {tasks === null ? <div className="text-secondary">Loading tasks...</div> : visibleTasks.length ? <div className="list-group list-group-flush">
        {visibleTasks.map((task) => {
          const status = getTaskStatus(task, now);
          const overdue = isTaskOverdue(task, now);
          return <div className="list-group-item px-0 py-3 task-notification-target" id={`task-${task.id}`} key={task.id}>
            <div className={`fw-semibold ${task.status === "done" ? "text-secondary" : ""}`}>
              <TaskStatusBadge status={status} className="me-2" />
              {isAdmin ? `${task.assignee_username}: ` : ""}{task.title}
            </div>
            {task.note && <div className="text-secondary small mt-1 task-note-text">{task.note}</div>}
            {!isAdmin && <div className="text-secondary small mt-1">{task.assigned_by_username ? `Assigned by ${task.assigned_by_username}` : "Assigned by admin"}</div>}
            {task.due_at && <div className={`small mt-1 ${overdue ? "task-overdue-text" : "text-secondary"}`}>{overdue ? "Overdue since" : "Due"} {formatDateTime(task.due_at)}</div>}
            {task.status === "done" && !task.current_submission && task.completed_at && <div className="text-secondary small mt-1">Completed {formatDateTime(task.completed_at)}</div>}
            <TaskPhotos task={task} />
            <TaskSubmissionDetails task={task} />
            {isAdmin ? <TaskReviewForm key={`${task.id}-${task.current_submission?.id}`} task={task} csrfToken={csrfToken} onSaved={taskSaved} />
              : <TaskCompletionForm task={task} csrfToken={csrfToken} onSaved={taskSaved} />}
          </div>;
        })}
      </div> : <div className="empty-state text-center"><h3 className="h5">{isAdmin ? "No submitted tasks" : "No assigned tasks"}</h3><p className="text-secondary mb-0">{isAdmin ? "User submissions will appear here for review." : "Tasks assigned by admin will appear here."}</p></div>}
    </section>
  </div>;
}
