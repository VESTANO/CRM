import { useId, useState } from "react";
import { adminApi } from "../services/api.js";

export default function TaskReviewForm({ task, csrfToken, onSaved }) {
  const id = useId();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (task.status !== "submitted" || !task.current_submission) return null;
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
      <button type="button" className="btn btn-success btn-sm" disabled={saving} onClick={() => review("approve")}>{saving ? "Saving review..." : "Approve task"}</button>
      <button type="button" className="btn btn-outline-danger btn-sm" disabled={saving} onClick={() => review("reject")}>Reject task</button>
    </div>
  </div>;
}
