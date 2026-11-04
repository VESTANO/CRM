import { formatDateTime } from "../utils/formatters.js";
import TaskStatusBadge from "./TaskStatusBadge.jsx";
import TaskPhotos from "./TaskPhotos.jsx";

function SubmissionNotes({ submission }) {
  return <div className="task-submission-notes small">
    <div className="text-secondary">Submitted {formatDateTime(submission.submitted_at)}</div>
    <div className="mt-2"><strong>User note:</strong> <span className="task-note-text">{submission.note || "No note added."}</span></div>
    {submission.reviewed_at && <div className={`mt-2 ${submission.status === "rejected" ? "task-overdue-text" : ""}`}>
      <strong>{submission.status === "rejected" ? "Rejection note:" : "Admin note:"}</strong> <span className="task-note-text">{submission.review_note || "Approved without an additional note."}</span>
      <div className="text-secondary mt-1">Reviewed by {submission.reviewed_by_username || "admin"} · {formatDateTime(submission.reviewed_at)}</div>
    </div>}
  </div>;
}

export default function TaskSubmissionDetails({ task }) {
  const history = task.submissions || [];
  const current = task.current_submission || history[history.length - 1];
  if (!current) return null;
  const previous = history.filter((submission) => submission.id !== current.id).slice().reverse();
  return <div className="task-submission-details mt-3">
    <SubmissionNotes submission={current} />
    {previous.length > 0 && <details className="task-submission-history mt-3">
      <summary>Previous submissions ({previous.length})</summary>
      {previous.map((submission) => <div className="task-previous-submission mt-3" key={submission.id}>
        <TaskStatusBadge status={submission.status} />
        <SubmissionNotes submission={submission} />
        <TaskPhotos task={{ completion_images: submission.images }} />
      </div>)}
    </details>}
  </div>;
}
