export function getTaskStatus(task, now = Date.now()) {
  if (task.status === "done") return task.current_submission?.status === "approved" ? "approved" : "completed";
  if (task.status === "submitted" || task.status === "rejected") return task.status;
  return isTaskOverdue(task, now) ? "overdue" : "pending";
}

export function isTaskOverdue(task, now = Date.now()) {
  if (!["pending", "rejected"].includes(task.status)) return false;
  const due = task.due_at ? Date.parse(task.due_at) : NaN;
  return Number.isFinite(due) && due < Number(now);
}

export function nextTaskDeadlineDelay(tasks, now = Date.now()) {
  const upcoming = (tasks || [])
    .filter((task) => ["pending", "rejected"].includes(task.status) && task.due_at)
    .map((task) => Date.parse(task.due_at))
    .filter((due) => Number.isFinite(due) && due >= Number(now));
  if (!upcoming.length) return null;
  return Math.min(Math.min(...upcoming) - Number(now) + 1, 2_147_483_647);
}

export function compareNewestTasks(a, b) {
  const createdAt = (task) => Date.parse(task.created_at) || 0;
  return createdAt(b) - createdAt(a) || Number(b.id) - Number(a.id);
}
