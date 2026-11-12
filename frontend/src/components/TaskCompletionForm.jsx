import { useEffect, useId, useState } from "react";
import { tasksApi } from "../services/api.js";
import { taskCompletionPayload } from "../utils/taskImages.js";
import TaskImagePicker from "./TaskImagePicker.jsx";
import { useStoreFeatures } from "../hooks/useStoreFeatures.jsx";

export default function TaskCompletionForm({ task, csrfToken, onSaved }) {
  const { features } = useStoreFeatures();
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const noteId = useId();
  const rejected = task.status === "rejected";
  const submissionId = task.current_submission?.id;
  const taskImagesEnabled = Boolean(features.task_images);
  const requiresPhoto = taskImagesEnabled && (Boolean(task.assignment_images?.length) || rejected);
  useEffect(() => { setFiles([]); setNote(""); setError(""); }, [submissionId, task.status]);
  if (task.status === "done") return null;
  if (task.status === "submitted") return <div className="task-awaiting-review small mt-3" role="status">Awaiting admin approval. Your photos and note have been submitted for review.</div>;

  const submit = async (event) => {
    event.preventDefault();
    if (saving || preparing) return;
    setError("");
    if (requiresPhoto && !files.length) { setError(rejected ? "Upload new After photos before resubmitting this task." : "Upload at least one After photo to show the completed work."); return; }
    setSaving(true);
    try {
      await tasksApi.update(task.id, taskCompletionPayload(files, note, rejected ? submissionId : null), csrfToken);
      setFiles([]);
      setNote("");
      onSaved(rejected ? "Task resubmitted for admin approval." : "Task submitted for admin approval.");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to save task. Please try again.");
    } finally { setSaving(false); }
  };
  return <form className="task-completion-form mt-3" onSubmit={submit}>
    {rejected && <p className="small task-overdue-text">Arrange the section again using the admin's rejection note{taskImagesEnabled ? ", then upload new After photos." : "."}</p>}
    {taskImagesEnabled && <><TaskImagePicker label={rejected ? "New After photos (required)" : `After photos${requiresPhoto ? " (required)" : " (optional)"}`}
      files={files} onChange={(next) => { setFiles(next); setError(""); }} disabled={saving} onBusyChange={setPreparing} />
      {requiresPhoto && <div className="form-text">Show the arranged section or finished work so your admin can review it.</div>}</>}
    <label className="form-label mt-3" htmlFor={noteId}>{rejected ? "Resubmission note (optional)" : "Submission note (optional)"}</label>
    <textarea id={noteId} className="form-control" rows={3} maxLength={4000} value={note} disabled={saving}
      onChange={(event) => setNote(event.target.value)} placeholder={rejected ? "Explain what you have rearranged or corrected." : "Describe the finished work or anything your admin should check."} />
    {error && <div role="alert" className="alert alert-danger py-2 mt-2 mb-2">{error}</div>}
    <button className="btn btn-outline-success btn-sm mt-3" type="submit" disabled={saving || preparing}>
      {preparing ? "Preparing photos..." : saving ? "Uploading and submitting..." : rejected ? "Resubmit for review" : "Submit for review"}
    </button>
  </form>;
}
