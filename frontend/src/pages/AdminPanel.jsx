import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { formatDateTime } from "../utils/formatters.js";
import AnimatedNumber from "../components/AnimatedNumber.jsx";
import { useAuth } from "../hooks/useAuth.jsx";

function getTargetsForUser(targets, userId) {
  return targets?.filter((target) => target.userId === userId) || [];
}

function getTargetForMonth(targets, userId, month) {
  return targets?.find(
    (target) => target.userId === userId && target.month === month
  ) || null;
}

function progressLabel(target) {
  if (!target) return "No target";
  return `${target.monthLabel}: ${target.converted} / ${target.target} (${target.percentage}%)`;
}

function currentMonthValue() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

export default function AdminPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [targetUser, setTargetUser] = useState(null);
  const [targetMonth, setTargetMonth] = useState(currentMonthValue());
  const [targetInput, setTargetInput] = useState("");
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetMessage, setTargetMessage] = useState("");
  const [targetMessageType, setTargetMessageType] = useState("success");
  const [taskUser, setTaskUser] = useState(null);
  const [taskValues, setTaskValues] = useState({ title: "", note: "", due_at: "" });
  const [taskSaving, setTaskSaving] = useState(false);
  const { csrfToken } = useAuth();

  const load = async () => {
    try {
      const [summaryResponse, targetsResponse] = await Promise.all([
        adminApi.summary(),
        adminApi.targets(),
      ]);

      setData({
        ...summaryResponse.data,
        targetPerformance: targetsResponse.data,
      });
      setError("");
    } catch (requestError) {
      setError(
        requestError.response?.status === 403
          ? "Administrator access required."
          : "Unable to load admin panel."
      );
    }
  };

  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="alert alert-danger">{error}</div>;
  if (!data) return <div className="panel">Loading admin panel...</div>;

  const pageCount = Math.ceil(data.users.length / 5);
  const visibleUsers = data.users.slice((page - 1) * 5, page * 5);
  const warningTargets = data.targetPerformance?.filter((target) => target.needsWarning) || [];
  const targetBeingEdited = targetUser && targetMonth
    ? getTargetForMonth(data.targetPerformance, targetUser.id, targetMonth)
    : null;

  const openTargetModal = (user) => {
    const userTargets = getTargetsForUser(data.targetPerformance, user.id);
    const initialMonth = userTargets[0]?.month || currentMonthValue();
    const initialTarget = getTargetForMonth(data.targetPerformance, user.id, initialMonth);

    setTargetUser(user);
    setTargetMonth(initialMonth);
    setTargetInput(initialTarget?.target ?? "");
    setTargetMessage("");
  };

  const changeTargetMonth = (event) => {
    const month = event.target.value;
    const existingTarget = targetUser
      ? getTargetForMonth(data.targetPerformance, targetUser.id, month)
      : null;

    setTargetMonth(month);
    setTargetInput(existingTarget?.target ?? "");
    setTargetMessage("");
  };

  const closeTargetModal = () => {
    setTargetUser(null);
    setTargetMonth(currentMonthValue());
    setTargetInput("");
  };

  const assignTarget = async () => {
    const target = Number(targetInput);

    if (!targetMonth) {
      setTargetMessageType("danger");
      setTargetMessage("Choose a month for this target.");
      return;
    }
    if (!Number.isInteger(target) || target <= 0) {
      setTargetMessageType("danger");
      setTargetMessage("Target must be a positive whole number.");
      return;
    }

    setTargetSaving(true);
    setTargetMessage("");

    try {
      if (targetBeingEdited?.id) {
        await adminApi.updateTarget(targetBeingEdited.id, { target }, csrfToken);
      } else {
        await adminApi.saveTarget(
          { userId: targetUser.id, month: targetMonth, target },
          csrfToken
        );
      }

      setTargetMessageType("success");
      setTargetMessage(
        targetBeingEdited
          ? `Target updated for ${targetUser.username}.`
          : `Target assigned to ${targetUser.username}.`
      );
      closeTargetModal();
      await load();
    } catch (requestError) {
      setTargetMessageType("danger");
      setTargetMessage(
        requestError.response?.data?.detail ||
          requestError.response?.data?.errors?.target?.[0] ||
          "Unable to assign target."
      );
    } finally {
      setTargetSaving(false);
    }
  };

  const openTaskModal = (user) => {
    setTaskUser(user);
    setTaskValues({ title: "", note: "", due_at: "" });
    setTargetMessage("");
  };

  const closeTaskModal = () => {
    setTaskUser(null);
    setTaskValues({ title: "", note: "", due_at: "" });
  };

  const assignTask = async () => {
    const title = taskValues.title.trim();
    if (!title) {
      setTargetMessageType("danger");
      setTargetMessage("Enter a task for this user.");
      return;
    }

    setTaskSaving(true);
    setTargetMessage("");

    try {
      await adminApi.createTask(
        {
          assignee: taskUser.id,
          title,
          note: taskValues.note,
          due_at: taskValues.due_at ? new Date(taskValues.due_at).toISOString() : null,
        },
        csrfToken
      );
      setTargetMessageType("success");
      setTargetMessage(`Task assigned to ${taskUser.username}.`);
      closeTaskModal();
      await load();
    } catch (requestError) {
      const errors = requestError.response?.data?.errors;
      setTargetMessageType("danger");
      setTargetMessage(
        requestError.response?.data?.detail ||
          (errors ? Object.values(errors).flat().join(" ") : "Unable to assign task.")
      );
    } finally {
      setTaskSaving(false);
    }
  };

  return (
    <>
      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Administration</div>
          <h1 className="h2 mb-2">Admin Panel</h1>
          <p className="text-secondary mb-0">Manage users, datasets, and CRM activity.</p>
        </div>
        <Link className="btn btn-primary" to="/admin-panel/users/add">
          <i className="bi bi-person-plus me-1" />
          Add User
        </Link>
      </div>

      {targetMessage && !targetUser && !taskUser && (
        <div className={`alert alert-${targetMessageType}`}>{targetMessage}</div>
      )}

      {warningTargets.length > 0 && (
        <section className="alert alert-warning">
          <h2 className="h6 mb-2">Target performance warnings</h2>
          <div className="d-grid gap-2">
            {warningTargets.map((target) => (
              <div key={target.id}>
                {target.warningMessage} Current progress is {progressLabel(target)}.
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="metric-grid mb-4">
        {[
          ["Total Users", data.metrics.totalUsers, "bi-people"],
          ["Active Users", data.metrics.activeUsers, "bi-person-check"],
          ["Total Datasets", data.metrics.totalDatasets, "bi-collection"],
          ["Total Customers", data.metrics.totalCustomers, "bi-person-lines-fill"],
        ].map(([label, value, icon]) => (
          <div className="summary-card" key={label}>
            <span className="metric-icon"><i className={`bi ${icon}`} /></span>
            <div className="text-secondary small">{label}</div>
            <div className="summary-value"><AnimatedNumber value={value} /></div>
          </div>
        ))}
      </div>

      <section className="panel mb-4">
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-3">
          <div>
            <h2 className="h5 mb-1">Assigned Tasks</h2>
            <p className="text-secondary small mb-0">View pending and completed tasks assigned to users.</p>
          </div>
          <Link className="btn btn-outline-primary" to="/admin-panel/tasks">
            <i className="bi bi-list-task me-1" />
            View All Tasks
          </Link>
        </div>
      </section>

      <section className="panel p-0 mb-4 responsive-table">
        <div className="table-panel-header">
          <h2 className="h5 mb-1">Users</h2>
          <p className="text-secondary small mb-0">CRM account access and dataset target progress overview.</p>
        </div>
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead className="table-light">
              <tr>
                <th>Username</th>
                <th>Lists</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Targets</th>
                <th>Tasks</th>
                <th>Date joined</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((user) => {
                const userTargets = getTargetsForUser(data.targetPerformance, user.id);
                return (
                  <tr key={user.id}>
                    <td data-label="Username">
                      <div className="fw-semibold">{user.username}</div>
                    </td>
                    <td data-label="Lists">
                      <span className="text-secondary small">
                        <AnimatedNumber value={user.dataset_count} /> datasets ·{" "}
                        <AnimatedNumber value={user.customer_count} /> customers
                      </span>
                    </td>
                    <td data-label="Email">{user.email || "No email"}</td>
                    <td data-label="Role">
                      <span className="badge text-bg-primary">{user.is_admin ? "Admin" : "User"}</span>
                    </td>
                    <td data-label="Status">
                      <span className={`badge text-bg-${user.is_active ? "success" : "secondary"}`}>
                        {user.is_active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td data-label="Targets">
                      {user.is_admin ? (
                        <span className="text-secondary small">Admin user</span>
                      ) : userTargets.length ? (
                        <div className="d-flex flex-column align-items-start gap-1">
                          {userTargets.map((target) => (
                            <span className={`badge text-bg-${target.statusColor}`} key={target.id}>
                              {progressLabel(target)}
                            </span>
                          ))}
                          {userTargets.some((target) => target.needsWarning) && (
                            <span className="badge text-bg-warning">
                              Failed target {Math.max(...userTargets.map((target) => target.lowTargetCount))} times
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="badge text-bg-secondary">No target</span>
                      )}
                    </td>
                    <td data-label="Tasks">
                      {user.is_admin ? (
                        <span className="text-secondary small">Admin user</span>
                      ) : (
                        <Link className="btn btn-outline-primary btn-sm" to={`/admin-panel/users/${user.id}/tasks`}>
                          View Tasks
                        </Link>
                      )}
                    </td>
                    <td data-label="Date joined">{formatDateTime(user.date_joined)}</td>
                    <td data-label="Actions">
                      <div className="btn-group btn-group-sm table-actions">
                        <Link className="btn btn-outline-primary" to={`/admin-panel/users/${user.id}`}>View</Link>
                        <Link className="btn btn-outline-secondary" to={`/admin-panel/users/${user.id}/edit`}>Edit</Link>
                        <Link className="btn btn-outline-secondary" to={`/admin-panel/users/${user.id}/datasets`}>Datasets</Link>
                        {!user.is_admin && (
                          <>
                            <button
                              className="btn btn-outline-success"
                              type="button"
                              onClick={() => openTargetModal(user)}
                            >
                              Manage Targets
                            </button>
                            <button
                              className="btn btn-outline-primary"
                              type="button"
                              onClick={() => openTaskModal(user)}
                            >
                              Assign Task
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="d-flex justify-content-between align-items-center px-3 pb-3">
            <span className="text-secondary small">Page {page} of {pageCount}</span>
            <div className="d-flex gap-2">
              <button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setPage((current) => current - 1)} disabled={page <= 1}>Previous</button>
              <button className="btn btn-outline-primary btn-sm" type="button" onClick={() => setPage((current) => current + 1)} disabled={page >= pageCount}>Next</button>
            </div>
          </div>
        )}
      </section>

      <div className="row g-4">
        <div className="col-lg-6">
          <section className="panel">
            <h2 className="h5 mb-3">Recent datasets</h2>
            {data.recentDatasets.map((dataset) => (
              <Link className="list-group-item list-group-item-action px-0 py-3" to={`/datasets/${dataset.id}`} key={dataset.id}>
                <span className="fw-semibold d-block">{dataset.name}</span>
                <span className="text-secondary small">{dataset.owner_username} · <AnimatedNumber value={dataset.customer_count} /> customers</span>
              </Link>
            ))}
          </section>
        </div>
        <div className="col-lg-6">
          <section className="panel">
            <h2 className="h5 mb-3">Recently created users</h2>
            {data.recentUsers.map((user) => (
              <Link className="list-group-item list-group-item-action px-0 py-3" to={`/admin-panel/users/${user.id}`} key={user.id}>
                <span className="fw-semibold d-block">{user.username}</span>
                <span className="text-secondary small">{user.email || "No email"} · {formatDateTime(user.date_joined)}</span>
              </Link>
            ))}
          </section>
        </div>
      </div>

      {targetUser && (
        <div className="modal d-block" tabIndex="-1" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title">
                    {targetBeingEdited ? "Edit Dataset Target" : "Assign Dataset Target"}
                  </h5>
                  <div className="text-secondary small">{targetUser.username}</div>
                </div>
                <button type="button" className="btn-close" onClick={closeTargetModal} />
              </div>
              <div className="modal-body">
                {targetMessage && (
                  <div className={`alert alert-${targetMessageType}`}>{targetMessage}</div>
                )}
                <div className="mb-3">
                  <label className="form-label">Sales User</label>
                  <input className="form-control" value={targetUser.username} disabled />
                </div>
                <div className="mb-3">
                  <label className="form-label" htmlFor="target-month">Target Month</label>
                  <input
                    id="target-month"
                    className="form-control"
                    type="month"
                    value={targetMonth}
                    onChange={changeTargetMonth}
                  />
                  <div className="form-text">Converted sales visits in this month will count toward the target.</div>
                </div>
                <div>
                  <label className="form-label">Target - Converted Clients</label>
                  <input
                    className="form-control"
                    type="number"
                    min="1"
                    step="1"
                    value={targetInput}
                    onChange={(event) => setTargetInput(event.target.value)}
                    placeholder="Example: 20"
                  />
                  <div className="form-text">Number of clients this user should convert from the selected dataset.</div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={closeTargetModal}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={assignTarget}
                  disabled={targetSaving}
                >
                  {targetSaving ? "Saving..." : targetBeingEdited ? "Update Target" : "Assign Target"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {taskUser && (
        <div className="modal d-block" tabIndex="-1" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="modal-dialog modal-dialog-centered">
            <div className="modal-content">
              <div className="modal-header">
                <div>
                  <h5 className="modal-title">Assign Task</h5>
                  <div className="text-secondary small">{taskUser.username}</div>
                </div>
                <button type="button" className="btn-close" onClick={closeTaskModal} />
              </div>
              <div className="modal-body">
                {targetMessage && (
                  <div className={`alert alert-${targetMessageType}`}>{targetMessage}</div>
                )}
                <div className="mb-3">
                  <label className="form-label" htmlFor="task-title">Task</label>
                  <input
                    id="task-title"
                    className="form-control"
                    maxLength={255}
                    value={taskValues.title}
                    onChange={(event) => setTaskValues((current) => ({ ...current, title: event.target.value }))}
                    placeholder="Example: Follow up with pending converted leads"
                  />
                </div>
                <div className="mb-3">
                  <label className="form-label" htmlFor="task-note">Details</label>
                  <textarea
                    id="task-note"
                    className="form-control"
                    rows="3"
                    value={taskValues.note}
                    onChange={(event) => setTaskValues((current) => ({ ...current, note: event.target.value }))}
                    placeholder="Optional instructions for the user"
                  />
                </div>
                <div>
                  <label className="form-label" htmlFor="task-due-at">Due Date and Time</label>
                  <input
                    id="task-due-at"
                    className="form-control"
                    type="datetime-local"
                    value={taskValues.due_at}
                    onChange={(event) => setTaskValues((current) => ({ ...current, due_at: event.target.value }))}
                  />
                  <div className="form-text">Leave empty if this task does not have a deadline.</div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-outline-secondary" onClick={closeTaskModal}>Cancel</button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={assignTask}
                  disabled={taskSaving}
                >
                  {taskSaving ? "Assigning..." : "Assign Task"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
