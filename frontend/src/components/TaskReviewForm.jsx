import { useId, useState } from "react";
import { adminApi } from "../services/api.js";
import ConfirmationDialog from "./ConfirmationDialog.jsx";
import "../styles/mobile-tasks.css";

export default function TaskReviewForm({ task, csrfToken, onSaved }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  if (task.status !== "submitted" || !task.current_submission) return null;
  const close = () => { if (!saving) { setPendingAction(""); setError(""); } };
  const review = async (action) => {
    if (saving) return;
    setError("");
    if (action === "reject" && !note.trim()) { setError("Add a rejection note explaining what the user needs to arrange again."); return; }
    setSaving(true);
    try {
      await adminApi.updateTask(task.id, {
        review_action: action, submission_id: task.current_submission.id, review_note: note.trim(),
      }, csrfToken);
      setNote("");
      setPendingAction("");
      onSaved(action === "approve" ? "Task approved." : "Task rejected. The user can read your note and submit new After photos.");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to review this task. Please try again.");
    } finally { setSaving(false); }
  };
  return <div className="task-review-form mt-3">
    <label className="form-label small fw-semibold" htmlFor={id}>Admin review note</label>
    <textarea id={id} className="form-control" rows={3} maxLength={4000} value={note} disabled={saving}
      onChange={(event) => { setNote(event.target.value); setError(""); }} placeholder="Explain what needs changing if you reject this work." />
    <div className="form-text">Required for rejection. Optional for approval.</div>
    {error && <div className="alert alert-danger py-2 mt-2 mb-2" role="alert">{error}</div>}
    <div className="d-flex flex-wrap gap-2 mt-3">
      <button type="button" className="btn btn-success btn-sm" disabled={saving} onClick={() => { setError(""); setPendingAction("approve"); }}>{saving ? "Saving review..." : "Approve task"}</button>
      <button type="button" className="btn btn-outline-danger btn-sm" disabled={saving} onClick={() => { setError(""); setPendingAction("reject"); }}>Reject task</button>
    </div>
    <ConfirmationDialog
      open={Boolean(pendingAction)}
      title={pendingAction === "approve" ? "Approve task submission?" : "Reject task submission?"}
      description={pendingAction === "approve" ? "The employee will be notified that this submission is complete." : "The employee will receive your feedback and can submit a revised response."}
      details={<><strong>{task.title}</strong><div className="small text-secondary mt-1">Submission #{task.current_submission.id}</div>{pendingAction === "approve" && note.trim() && <div className="small task-note-text mt-2">Review note: {note.trim()}</div>}</>}
      actionLabel={pendingAction === "approve" ? "Confirm approval" : "Confirm rejection"}
      tone={pendingAction === "reject" ? "danger" : "primary"}
      requiresReason={pendingAction === "reject"}
      reason={note}
      reasonLabel="Rejection feedback"
      reasonPlaceholder="Explain what needs to change before the task can be approved."
      onReasonChange={(value) => { setNote(value); setError(""); }}
      onConfirm={() => review(pendingAction)}
      onCancel={close}
      busy={saving}
      error={error}
    />
  </div>;
}
