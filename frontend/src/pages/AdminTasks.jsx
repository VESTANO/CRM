import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";
import { useTasks } from "../hooks/useTasks.js";
import { useTaskClock } from "../hooks/useTaskClock.js";
import { getTaskStatus, isTaskOverdue } from "../utils/tasks.js";
import TaskStatusBadge from "../components/TaskStatusBadge.jsx";
import TaskPhotos from "../components/TaskPhotos.jsx";
import TaskSubmissionDetails from "../components/TaskSubmissionDetails.jsx";
import TaskReviewForm from "../components/TaskReviewForm.jsx";
import TimedAlert from "../components/TimedAlert.jsx";
import { useAuth } from "../hooks/useAuth.jsx";
import "../styles/mobile-tasks.css";

export default function AdminTasks() {
  const { userId } = useParams();
  const { tasks: allTasks, error: taskError, refresh } = useTasks({ all: true });
  const { csrfToken } = useAuth();
  const [message, setMessage] = useState("");
  const tasks = useMemo(() => allTasks && (userId ? allTasks.filter((task) => String(task.assignee) === String(userId)) : allTasks), [allTasks, userId]);
  const now = useTaskClock(tasks);
  const [user, setUser] = useState(() => userId ? peekCachedResponse(`/admin/users/${userId}/`)?.data || null : null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      setUser(userId ? peekCachedResponse(`/admin/users/${userId}/`)?.data || null : null);
      setError("");
      if (!userId) return;
      try {
        const userResponse = await adminApi.detail(userId);
        if (!active) return;
        setUser(userResponse.data);
        setError("");
      } catch (requestError) {
        if (!active) return;
        setError(
          requestError.response?.status === 403
            ? "Administrator access required."
            : "Unable to load assigned tasks."
        );
      }
    };

    load();
    return () => { active = false; };
  }, [userId]);

  if ((error || taskError) && tasks === null) return <div className="alert alert-danger" role="alert">{error || taskError}</div>;

  const pendingCount = tasks?.filter((task) => getTaskStatus(task, now) === "pending").length || 0;
  const overdueCount = tasks?.filter((task) => isTaskOverdue(task, now)).length || 0;
  const completedCount = tasks?.filter((task) => task.status === "done").length || 0;
  const awaitingCount = tasks?.filter((task) => task.status === "submitted").length || 0;
  const rejectedCount = tasks?.filter((task) => task.status === "rejected").length || 0;
  const reviewed = (successMessage) => { setMessage(successMessage); refresh(); };

  return (
    <div className="tasks-workspace">
      {(error || taskError) && <div className="alert alert-warning" role="alert">{error || taskError}</div>}
      <TimedAlert message={message} />
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/admin-panel">Admin Panel</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Assigned Tasks</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Administration</div>
          <h1 className="h2 mb-2">{user ? `${user.username}'s Tasks` : "Assigned Tasks"}</h1>
          <p className="text-secondary mb-0">Check After photos and submission notes, then approve the work or reject it for changes.</p>
        </div>
        <Link className="btn btn-outline-secondary" to="/admin-panel">
          Back to Admin Panel
        </Link>
      </div>

      <section className="metric-grid mb-4">
        <div className="summary-card">
          <span className="metric-icon"><i className="bi bi-clipboard-check" /></span>
          <div className="text-secondary small">Awaiting Approval</div>
          <div className="summary-value">{awaitingCount}</div>
        </div>
        <div className="summary-card">
          <span className="metric-icon"><i className="bi bi-arrow-repeat" /></span>
          <div className="text-secondary small">Rejected</div>
          <div className="summary-value">{rejectedCount}</div>
        </div>
        <div className="summary-card">
          <span className="metric-icon"><i className="bi bi-list-task" /></span>
          <div className="text-secondary small">Total Tasks</div>
          <div className="summary-value">{tasks?.length || 0}</div>
        </div>
        <div className="summary-card">
          <span className="metric-icon"><i className="bi bi-hourglass-split" /></span>
          <div className="text-secondary small">Pending</div>
          <div className="summary-value">{pendingCount}</div>
        </div>
        <div className="summary-card task-overdue-summary">
          <span className="metric-icon"><i className="bi bi-exclamation-circle" /></span>
          <div className="text-secondary small">Overdue</div>
          <div className="summary-value">{overdueCount}</div>
        </div>
        <div className="summary-card">
          <span className="metric-icon"><i className="bi bi-check2-circle" /></span>
          <div className="text-secondary small">Completed</div>
          <div className="summary-value">{completedCount}</div>
        </div>
      </section>

      <section className="panel p-0 responsive-table">
        <div className="table-panel-header">
          <h2 className="h5 mb-1">Task List</h2>
          <p className="text-secondary small mb-0">
            {user ? `Tasks assigned to ${user.username}.` : "All tasks assigned to CRM users."}
          </p>
        </div>
        <p className="table-scroll-hint">Scroll horizontally to see all task details.</p>
        <div className="table-responsive" tabIndex={0} role="region" aria-label="Assigned tasks table, scroll horizontally to see all columns">
          <table className="table table-hover align-middle mb-0 admin-tasks-table">
            <thead className="table-light">
              <tr>
                <th>User</th>
                <th>Task</th>
                <th>Details</th>
                <th>Photos</th>
                <th>Due</th>
                <th>Status</th>
                <th>Assigned By</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {tasks === null ? (
                <tr><td colSpan="8" className="text-secondary">Loading tasks...</td></tr>
              ) : tasks.length ? (
                tasks.map((task) => {
                  const status = getTaskStatus(task, now);
                  return (
                  <tr key={task.id}>
                    <td data-label="User">{task.assignee_username}</td>
                    <td data-label="Task" className="fw-semibold">{task.title}</td>
                    <td data-label="Details">{task.note || <span className="text-secondary">No details</span>}</td>
                    <td data-label="Photos"><TaskPhotos task={task} emptyLabel /><TaskSubmissionDetails task={task} /></td>
                    <td data-label="Due">{task.due_at ? <span className={isTaskOverdue(task, now) ? "task-overdue-text fw-semibold" : undefined}>{formatDateTime(task.due_at)}</span> : <span className="text-secondary">No deadline</span>}</td>
                    <td data-label="Status">
                      <TaskStatusBadge status={status} />
                    </td>
                    <td data-label="Assigned By">{task.assigned_by_username || "Admin"}</td>
                    <td data-label="Review">{task.status === "submitted" ? <TaskReviewForm key={`${task.id}-${task.current_submission?.id}`} task={task} csrfToken={csrfToken} onSaved={reviewed} /> : <span className="small text-secondary">{task.status === "rejected" ? "Waiting for new After photos" : task.status === "done" ? "Review complete" : "Waiting for submission"}</span>}</td>
                  </tr>
                  );
                })
              ) : (
                <tr><td colSpan="8" className="text-secondary">No assigned tasks yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
