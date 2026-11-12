import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";

function userRole(user) {
  if (user.is_superuser || user.role === "super_admin") return "Super Admin";
  if (user.is_admin) return "Admin";
  return "User";
}

function currentMonthValue() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

function dateTimeLocal(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function AdminUsers() {
  const [searchParams] = useSearchParams();
  const storeFilter = searchParams.get("store") || "";
  const superAdminsOnly = searchParams.get("role") === "super_admin";
  const { user: signedInUser, csrfToken } = useAuth();
  const userListRequest = (storeFilter || superAdminsOnly) ? { params: { ...(storeFilter ? { store: storeFilter } : {}), ...(superAdminsOnly ? { role: "super_admin" } : {}) } } : {};
  const [users, setUsers] = useState(() => (
    peekCachedResponse("/admin/users/", userListRequest)?.data?.results
    ?? (!storeFilter ? peekCachedResponse("/admin/summary/")?.data?.users : null)
    ?? null
  ));
  const [error, setError] = useState("");
  const [taskUser, setTaskUser] = useState(null);
  const [taskValues, setTaskValues] = useState({ title: "", note: "", due_at: "" });
  const [taskError, setTaskError] = useState("");
  const [taskSaving, setTaskSaving] = useState(false);
  const [taskMessage, setTaskMessage] = useState("");
  const [taskPerformance, setTaskPerformance] = useState(() => peekCachedResponse("/admin/tasks/")?.data?.results || []);
  const [targetPerformance, setTargetPerformance] = useState(() => peekCachedResponse("/admin/targets/")?.data || []);
  const [targetUser, setTargetUser] = useState(null);
  const [targetMonth, setTargetMonth] = useState(currentMonthValue());
  const [targetMetric, setTargetMetric] = useState("count");
  const [targetInput, setTargetInput] = useState("");
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState("");
  const taskDialogRef = useRef(null);
  const taskTitleRef = useRef(null);
  const targetDialogRef = useRef(null);
  const targetMonthRef = useRef(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const { data } = await adminApi.listUsers(storeFilter, superAdminsOnly ? "super_admin" : "");
      setUsers(data.results);
      adminApi.targets().then(({ data: targets }) => setTargetPerformance(targets)).catch(() => {});
      adminApi.tasks().then(({ data: tasks }) => setTaskPerformance(tasks.results || [])).catch(() => {});
    } catch (requestError) {
      const denied = requestError.response?.status === 403;
      if (denied) setUsers(null);
      setError(denied ? "Administrator access required." : "Unable to load users.");
    }
  }, [storeFilter, superAdminsOnly]);

  useEffect(() => { load(); }, [load]);
  const closeTaskDialog = () => {
    if (taskSaving) return;
    setTaskUser(null);
    setTaskValues({ title: "", note: "", due_at: "" });
    setTaskError("");
  };
  useDialogFocus({ open: Boolean(taskUser), dialogRef: taskDialogRef, initialFocusRef: taskTitleRef, onCancel: closeTaskDialog, busy: taskSaving });
  const closeTargetDialog = () => {
    if (targetSaving) return;
    setTargetUser(null);
    setTargetMonth(currentMonthValue());
    setTargetMetric("count");
    setTargetInput("");
    setTargetError("");
  };
  useDialogFocus({ open: Boolean(targetUser), dialogRef: targetDialogRef, initialFocusRef: targetMonthRef, onCancel: closeTargetDialog, busy: targetSaving });

  if (error && users === null) return <RequestError message={error} onRetry={load} />;
  if (users === null) return <LoadingPanel label="Loading all users" />;

  // The API is store-scoped, and this guard also prevents a cached response
  // from a previously viewed store appearing during navigation.
  const visibleUsers = storeFilter ? users.filter((user) => user.store_id === storeFilter) : users;
  const activeCount = visibleUsers.filter((user) => user.is_active).length;
  const isSuperAdmin = Boolean(signedInUser?.is_superuser);
  const backPath = isSuperAdmin ? "/admin-panel/stores" : "/admin-panel";
  const backLabel = isSuperAdmin ? "Back to Stores" : "Back to Admin Panel";
  const title = superAdminsOnly ? "Super Admins" : storeFilter ? "Store Team" : "All Users";
  const taskForUser = (userId) => (taskPerformance || []).find((task) => String(task.assignee) === String(userId)) || null;
  const targetForUser = (userId, month = "") => (targetPerformance || []).find((target) => target.userId === userId && (!month || target.month === month)) || null;
  const openTaskDialog = (target) => {
    const existingTask = taskForUser(target.id);
    setTaskMessage("");
    setTaskError("");
    setTaskValues({ title: existingTask?.title || "", note: existingTask?.note || "", due_at: dateTimeLocal(existingTask?.due_at) });
    setTaskUser({ ...target, taskId: existingTask?.id || null });
  };
  const openTargetDialog = (target) => {
    const existingTarget = targetForUser(target.id);
    setTargetError("");
    setTargetMonth(existingTarget?.month || currentMonthValue());
    setTargetMetric(existingTarget?.metric || "count");
    setTargetInput(existingTarget?.target ?? "");
    setTargetUser(target);
  };
  const changeTargetMonth = (event) => {
    const month = event.target.value;
    const existingTarget = targetUser ? targetForUser(targetUser.id, month) : null;
    setTargetMonth(month);
    setTargetMetric(existingTarget?.metric || "count");
    setTargetInput(existingTarget?.target ?? "");
  };
  const assignTarget = async (event) => {
    event.preventDefault();
    const target = Number(targetInput);
    if (!targetMonth || !Number.isFinite(target) || target <= 0 || (targetMetric === "count" && !Number.isInteger(target))) {
      setTargetError(targetMetric === "count" ? "Enter a positive whole-number target." : "Enter a positive target amount.");
      return;
    }
    setTargetSaving(true);
    setTargetError("");
    try {
      await adminApi.saveTarget({ userId: targetUser.id, month: targetMonth, metric: targetMetric, target }, csrfToken);
      setTaskMessage(`Target assigned to ${targetUser.username}.`);
      setTargetUser(null);
      setTargetMonth(currentMonthValue());
      setTargetMetric("count");
      setTargetInput("");
      adminApi.targets().then(({ data: targets }) => setTargetPerformance(targets)).catch(() => {});
    } catch (requestError) {
      setTargetError(requestError.response?.data?.detail || "Unable to assign target.");
    } finally {
      setTargetSaving(false);
    }
  };
  const assignTask = async (event) => {
    event.preventDefault();
    const taskTitle = taskValues.title.trim();
    if (!taskTitle || !taskUser || taskSaving) {
      if (!taskTitle) setTaskError("Enter a task title.");
      return;
    }
    setTaskSaving(true);
    setTaskError("");
    try {
      const payload = { title: taskTitle, note: taskValues.note.trim(), due_at: taskValues.due_at ? new Date(taskValues.due_at).toISOString() : "" };
      if (taskUser.taskId) await adminApi.updateTask(taskUser.taskId, payload, csrfToken);
      else await adminApi.createTask({ assignee: taskUser.id, ...payload }, csrfToken);
      setTaskMessage(taskUser.taskId ? `Task updated for ${taskUser.username}.` : `Task assigned to ${taskUser.username}.`);
      setTaskUser(null);
      setTaskValues({ title: "", note: "", due_at: "" });
      adminApi.tasks({}, { fresh: true }).then(({ data: tasks }) => setTaskPerformance(tasks.results || [])).catch(() => {});
    } catch (requestError) {
      const errors = requestError.response?.data?.errors;
      setTaskError(requestError.response?.data?.detail || (errors ? Object.values(errors).flat().join(" ") : "Unable to assign task."));
    } finally {
      setTaskSaving(false);
    }
  };
  const deactivate = async (target) => {
    try {
      const { data } = await adminApi.action(target.id, "toggle-active", {}, csrfToken);
      setUsers((current) => current.map((item) => item.id === data.id ? data : item));
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to change this account status.");
    }
  };

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to={superAdminsOnly ? "/admin-panel/users?role=super_admin" : backPath}>{superAdminsOnly ? "Super Admins" : isSuperAdmin ? "Stores" : "Admin Panel"}</Link></li>
          <li className="breadcrumb-item active" aria-current="page">All Users</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4">
        <div>
          <div className="text-secondary small mb-1">Administration</div>
          <h1 className="h2 mb-2">{title}</h1>
          <p className="text-secondary mb-0">{superAdminsOnly ? "Global Super Admin accounts, independent of every store." : storeFilter ? "Accounts in the selected store only." : "Every CRM account, including administrators and inactive users."}</p>
        </div>
        <div className="d-flex flex-wrap gap-2">
          <Link className="btn btn-outline-secondary" to={backPath}>{backLabel}</Link>
          {!isSuperAdmin && <Link className="btn btn-outline-secondary" to="/admin-panel/stores">Stores</Link>}
          <Link className="btn btn-primary" to={superAdminsOnly ? "/admin-panel/users/add?role=super_admin" : storeFilter ? `/admin-panel/users/add?store=${storeFilter}` : "/admin-panel/stores"}><i className="bi bi-person-plus" />{superAdminsOnly ? "Add Super Admin" : storeFilter ? "Add User" : "Choose Store"}</Link>
        </div>
      </div>

      {error && <div className="alert alert-warning" role="alert">{error} Showing the last loaded user list.</div>}
      {taskMessage && <div className="alert alert-success" role="status">{taskMessage}</div>}

      <div className="metric-grid mb-4">
        {[
          ["Total Users", visibleUsers.length, "bi-people"],
          ["Active Users", activeCount, "bi-person-check"],
          ["Inactive Users", visibleUsers.length - activeCount, "bi-person-dash"],
        ].map(([label, value, icon]) => (
          <div className="summary-card" key={label}>
            <span className="metric-icon"><i className={`bi ${icon}`} /></span>
            <div className="text-secondary small">{label}</div>
            <div className="summary-value">{value}</div>
          </div>
        ))}
      </div>

      <section className="panel p-0 mb-4 responsive-table" aria-labelledby="all-users-heading">
        <div className="table-panel-header">
          <h2 className="h5 mb-1" id="all-users-heading">User Directory</h2>
          <p className="text-secondary small mb-0">Showing {visibleUsers.length} user{visibleUsers.length === 1 ? "" : "s"}{storeFilter ? " in this store" : ""}.</p>
        </div>
        {visibleUsers.length ? (
          <>
            <p className="table-scroll-hint">Scroll horizontally to see all user details and actions.</p>
            <div className="table-responsive" tabIndex={0} role="region" aria-label="All users table, scroll horizontally to see all columns">
              <table className="table table-hover align-middle mb-0">
                <thead className="table-light">
                  <tr>
                    {["Username", "Email", ...(storeFilter || superAdminsOnly ? [] : ["Store"]), "Role", "Status", ...(superAdminsOnly ? [] : ["Datasets", "Customers"]), "Actions"].map((heading) => <th scope="col" key={heading}>{heading}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {visibleUsers.map((user) => (
                    <tr key={user.id}>
                      <td data-label="Username"><Link className="fw-semibold" to={`/admin-panel/users/${user.id}`}>{user.username}</Link></td>
                      <td data-label="Email">{user.email || "No email"}</td>
                      {!storeFilter && !superAdminsOnly && <td data-label="Store">{user.store_name || "—"}</td>}
                      <td data-label="Role"><span className={`badge text-bg-${user.is_admin ? "primary" : "secondary"}`}>{userRole(user)}</span></td>
                      <td data-label="Status"><span className={`badge text-bg-${user.is_active ? "success" : "secondary"}`}>{user.is_active ? "Active" : "Inactive"}</span></td>
                      {!superAdminsOnly && <><td data-label="Datasets">{user.dataset_count ?? 0}</td><td data-label="Customers">{user.customer_count ?? 0}</td></>}
                      <td data-label="Actions">
                        <div className="table-actions" role="group" aria-label={`Actions for ${user.username}`}>
                          <Link className="btn btn-outline-primary btn-sm action-view" to={`/admin-panel/users/${user.id}`}>View</Link>
                          {(isSuperAdmin || !user.is_admin) && <Link className="btn btn-outline-secondary btn-sm action-edit" to={`/admin-panel/users/${user.id}/edit`}>Edit</Link>}
                          {!superAdminsOnly && <Link className="btn btn-outline-secondary btn-sm action-datasets" to={`/admin-panel/users/${user.id}/datasets`}>Datasets</Link>}
                          {!superAdminsOnly && !user.is_admin && user.is_active && String(user.designation || "").trim().toLowerCase() === "sales" && <button className="btn btn-outline-secondary btn-sm action-targets" type="button" onClick={() => openTargetDialog(user)}>{targetForUser(user.id) ? "Edit Target" : "Assign Target"}</button>}
                          {!user.is_admin && user.is_active && <button className="btn btn-outline-primary btn-sm action-assign-task" type="button" onClick={() => openTaskDialog(user)}>{taskForUser(user.id) ? "Edit Task" : "Assign task"}</button>}
                          {superAdminsOnly && <button className={`btn btn-outline-${user.is_active ? "danger" : "primary"} btn-sm`} type="button" disabled={user.id === signedInUser?.id} onClick={() => deactivate(user)}>{user.is_active ? "Deactivate" : "Activate"}</button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-state text-center">
            <h3 className="h5">No users yet</h3>
            <p className="text-secondary">Add a user to start managing CRM accounts.</p>
            <Link className="btn btn-primary" to={storeFilter ? `/admin-panel/users/add?store=${storeFilter}` : "/admin-panel/stores"}>{storeFilter ? "Add User" : "Choose Store"}</Link>
          </div>
        )}
      </section>
      {taskUser && <div className="modal d-block business-dialog" ref={taskDialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="user-task-assignment-title" style={{ background: "rgba(0,0,0,0.5)" }}>
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable"><div className="modal-content"><form onSubmit={assignTask}>
          <div className="modal-header"><div><h2 className="modal-title fs-5" id="user-task-assignment-title">{taskUser.taskId ? "Edit Task" : "Assign Task"}</h2><div className="text-secondary small">{taskUser.username}</div></div><button type="button" className="btn-close" aria-label="Close task assignment" onClick={closeTaskDialog} disabled={taskSaving} /></div>
          <div className="modal-body">
            {taskError && <div className="alert alert-danger" role="alert">{taskError}</div>}
            <div className="mb-3"><label className="form-label" htmlFor="user-task-title">Task</label><input id="user-task-title" ref={taskTitleRef} className="form-control" required maxLength="255" value={taskValues.title} onChange={(event) => setTaskValues((current) => ({ ...current, title: event.target.value }))} placeholder="Example: Follow up with pending converted leads" /></div>
            <div className="mb-3"><label className="form-label" htmlFor="user-task-note">Details</label><textarea id="user-task-note" className="form-control" rows="3" value={taskValues.note} onChange={(event) => setTaskValues((current) => ({ ...current, note: event.target.value }))} placeholder="Optional instructions for the user" /></div>
            <div><label className="form-label" htmlFor="user-task-due-at">Due Date and Time</label><input id="user-task-due-at" className="form-control" type="datetime-local" value={taskValues.due_at} onChange={(event) => setTaskValues((current) => ({ ...current, due_at: event.target.value }))} /><div className="form-text">Leave empty if this task does not have a deadline.</div></div>
          </div>
          <div className="modal-footer"><button type="button" className="btn btn-outline-secondary" onClick={closeTaskDialog} disabled={taskSaving}>Cancel</button><button className="btn btn-primary" disabled={taskSaving}>{taskSaving ? "Saving…" : taskUser.taskId ? "Update Task" : "Assign Task"}</button></div>
        </form></div></div>
      </div>}
      {targetUser && <div className="modal d-block business-dialog" ref={targetDialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="user-target-assignment-title" style={{ background: "rgba(0,0,0,0.5)" }}>
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable"><div className="modal-content"><form onSubmit={assignTarget}>
          <div className="modal-header"><div><h2 className="modal-title fs-5" id="user-target-assignment-title">{targetForUser(targetUser.id, targetMonth) ? "Edit Sales Target" : "Assign Sales Target"}</h2><div className="text-secondary small">{targetUser.username}</div></div><button type="button" className="btn-close" aria-label="Close target assignment" onClick={closeTargetDialog} disabled={targetSaving} /></div>
          <div className="modal-body">
            {targetError && <div className="alert alert-danger" role="alert">{targetError}</div>}
            <div className="mb-3"><label className="form-label" htmlFor="user-target-month">Target Month</label><input id="user-target-month" ref={targetMonthRef} className="form-control" type="month" value={targetMonth} onChange={changeTargetMonth} required /></div>
            <div className="mb-3"><label className="form-label" htmlFor="user-target-metric">Target type</label><select id="user-target-metric" className="form-select" value={targetMetric} onChange={(event) => setTargetMetric(event.target.value)}><option value="count">By converted customer count</option><option value="amount">By converted sales amount</option></select></div>
            <div><label className="form-label" htmlFor="user-target-value">{targetMetric === "amount" ? "Target - Converted Sales Amount" : "Target - Converted Clients"}</label><input id="user-target-value" className="form-control" type="number" min="1" step={targetMetric === "amount" ? "0.01" : "1"} value={targetInput} onChange={(event) => setTargetInput(event.target.value)} placeholder={targetMetric === "amount" ? "Example: 50000" : "Example: 20"} required /><div className="form-text">{targetMetric === "amount" ? "Adds the total amounts of converted sales visits in the selected month." : "Counts converted sales visits in the selected month."}</div></div>
          </div>
          <div className="modal-footer"><button type="button" className="btn btn-outline-secondary" onClick={closeTargetDialog} disabled={targetSaving}>Cancel</button><button className="btn btn-primary" disabled={targetSaving}>{targetSaving ? "Saving…" : targetForUser(targetUser.id, targetMonth) ? "Update Target" : "Assign Target"}</button></div>
        </form></div></div>
      </div>}
    </>
  );
}
