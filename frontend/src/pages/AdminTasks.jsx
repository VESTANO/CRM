import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";

export default function AdminTasks() {
  const { userId } = useParams();
  const [tasks, setTasks] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const [tasksResponse, userResponse] = await Promise.all([
          adminApi.tasks(userId ? { userId } : {}),
          userId ? adminApi.detail(userId) : Promise.resolve({ data: null }),
        ]);
        setTasks(tasksResponse.data.results || []);
        setUser(userResponse.data);
        setError("");
      } catch (requestError) {
        setError(
          requestError.response?.status === 403
            ? "Administrator access required."
            : "Unable to load assigned tasks."
        );
      }
    };

    load();
  }, [userId]);

  if (error) return <div className="alert alert-danger">{error}</div>;

  const pendingCount = tasks?.filter((task) => task.status === "pending").length || 0;
  const completedCount = tasks?.filter((task) => task.status === "done").length || 0;

  return (
    <>
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
          <p className="text-secondary mb-0">Review tasks assigned by admin and see whether users completed them.</p>
        </div>
        <Link className="btn btn-outline-secondary" to="/admin-panel">
          Back to Admin Panel
        </Link>
      </div>

      <section className="metric-grid mb-4">
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
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th>User</th>
                <th>Task</th>
                <th>Details</th>
                <th>Due</th>
                <th>Status</th>
                <th>Assigned By</th>
              </tr>
            </thead>
            <tbody>
              {tasks === null ? (
                <tr><td colSpan="6" className="text-secondary">Loading tasks...</td></tr>
              ) : tasks.length ? (
                tasks.map((task) => (
                  <tr key={task.id}>
                    <td data-label="User">{task.assignee_username}</td>
                    <td data-label="Task" className="fw-semibold">{task.title}</td>
                    <td data-label="Details">{task.note || <span className="text-secondary">No details</span>}</td>
                    <td data-label="Due">{task.due_at ? formatDateTime(task.due_at) : <span className="text-secondary">No deadline</span>}</td>
                    <td data-label="Status">
                      <span className={`badge text-bg-${task.status === "done" ? "success" : "danger"}`}>
                        {task.status === "done" ? "Completed" : "Pending"}
                      </span>
                    </td>
                    <td data-label="Assigned By">{task.assigned_by_username || "Admin"}</td>
                  </tr>
                ))
              ) : (
                <tr><td colSpan="6" className="text-secondary">No assigned tasks yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
