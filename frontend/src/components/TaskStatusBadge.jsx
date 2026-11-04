const labels = { pending: "Pending", overdue: "Overdue", completed: "Completed", submitted: "Awaiting approval", rejected: "Rejected", approved: "Approved" };

export default function TaskStatusBadge({ status, className = "" }) {
  return (
    <span className={`badge task-status-${status} ${className}`}>
      {status === "overdue" && <i className="bi bi-exclamation-circle me-1" aria-hidden="true" />}
      {labels[status]}
    </span>
  );
}
