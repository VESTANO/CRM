import { useState } from "react";
import { adminApi } from "../services/api.js";
import ConfirmationDialog from "./ConfirmationDialog.jsx";
import "../styles/mobile-tasks.css";

export default function TaskReviewForm({ task, csrfToken, onSaved }) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [action, setAction] = useState("");
  if (task.status !== "submitted" || !task.current_submission) return null;
  const close = () => { if (!saving) { setAction(""); setError(""); } };
  const review = async () => {
    if (saving) return;
    setError("");
    if (action === "reject" && !note.trim()) { setError("Add a rejection note explaining what the user needs to arrange again."); return; }
    setSaving(true);
    try {
      await adminApi.updateTask(task.id, {
        review_action: action, submission_id: task.current_submission.id, review_note: note.trim(),
      }, csrfToken);
      setNote("");
      const completedAction = action;
      setAction("");
      onSaved(completedAction === "approve" ? "Task approved." : "Task rejected. The user can read your note and submit new After photos.");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to review this task. Please try again.");
    } finally { setSaving(false); }
  };
  return <div className="task-review-form mt-3">
    <div className="d-flex flex-wrap gap-2 mt-3">
      <button type="button" className="btn btn-success btn-sm" disabled={saving} onClick={() => { setError(""); setAction("approve"); }}>Approve task</button>
      <button type="button" className="btn btn-outline-danger btn-sm" disabled={saving} onClick={() => { setError(""); setAction("reject"); }}>Reject task</button>
    </div>
    <ConfirmationDialog
      open={Boolean(action)}
      title={action === "approve" ? "Approve task submission?" : "Reject task submission?"}
      description={action === "approve" ? "The employee will be notified that this submission is complete." : "The employee will receive your feedback and can submit a revised response."}
      details={<><strong>{task.title}</strong><div className="small text-secondary mt-1">Submission #{task.current_submission.id}</div></>}
      actionLabel={action === "approve" ? "Confirm approval" : "Confirm rejection"}
      tone={action === "reject" ? "danger" : "primary"}
      requiresReason={action === "reject"}
      reason={note}
      reasonLabel="Rejection feedback"
      reasonPlaceholder="Explain what needs to change before the task can be approved."
      onReasonChange={(value) => { setNote(value); setError(""); }}
      onConfirm={review}
      onCancel={close}
      busy={saving}
      error={error}
    />
  </div>;
}
