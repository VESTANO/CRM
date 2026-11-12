import { useId, useRef } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

export default function ConfirmationDialog({
  open,
  title,
  description,
  details,
  actionLabel,
  tone = "primary",
  requiresReason = false,
  showNote = false,
  noteRequired = false,
  reason = "",
  reasonLabel = "Reason",
  reasonPlaceholder = "Add a clear reason for this decision.",
  noteHelpText,
  noteMaxLength = 4000,
  onReasonChange,
  onConfirm,
  onCancel,
  busy = false,
  error = "",
}) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const dialogRef = useRef(null);
  const cancelRef = useRef(null);
  useDialogFocus({ open, dialogRef, initialFocusRef: cancelRef, onCancel, busy });

  if (!open) return null;
  const noteVisible = showNote || requiresReason;
  const noteIsRequired = noteRequired || requiresReason;
  const describedBy = [description ? descriptionId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;

  return <>
    <div className="modal d-block crm-confirmation-dialog" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={describedBy} ref={dialogRef} tabIndex="-1">
      <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
        <div className="modal-content">
          <div className="modal-header">
            <div className="d-flex align-items-start gap-2">
              <span className={`crm-confirmation-icon tone-${tone}`} aria-hidden="true"><i className={`bi bi-${tone === "danger" ? "exclamation-octagon" : "check2-circle"}`} /></span>
              <div><h2 className="modal-title fs-5 mb-1" id={titleId}>{title}</h2>{description && <p className="text-secondary small mb-0" id={descriptionId}>{description}</p>}</div>
            </div>
            <button className="btn-close" type="button" aria-label="Close dialog" onClick={onCancel} disabled={busy} />
          </div>
          <div className="modal-body">
            {details && <div className="crm-confirmation-details mb-3">{details}</div>}
            {noteVisible && <div>
              <label className="form-label fw-semibold" htmlFor={`${titleId}-reason`}>{reasonLabel}</label>
              <textarea id={`${titleId}-reason`} className="form-control" rows="4" maxLength={noteMaxLength} required={noteIsRequired}
                value={reason} disabled={busy} onChange={(event) => onReasonChange?.(event.target.value)} placeholder={reasonPlaceholder} />
              <div className="form-text">{noteHelpText || (noteIsRequired ? "This reason will be shown to the affected employee." : "Optional. This note will be shown to the affected employee.")}</div>
            </div>}
            {error && <div className="alert alert-danger mb-0 mt-3" id={errorId} role="alert">{error}</div>}
          </div>
          <div className="modal-footer">
            <button className="btn btn-outline-secondary" type="button" ref={cancelRef} onClick={onCancel} disabled={busy}>Cancel</button>
            <button className={`btn btn-${tone === "danger" ? "danger" : "success"}`} type="button" onClick={onConfirm} disabled={busy || (noteIsRequired && !reason.trim())}>
              {busy ? "Processing…" : actionLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
    <div className="modal-backdrop show crm-confirmation-backdrop" aria-hidden="true" />
  </>;
}
