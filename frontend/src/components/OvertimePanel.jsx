import { useEffect, useState } from "react";
import { overtimeApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import ConfirmationDialog from "./ConfirmationDialog.jsx";
import { indiaDateInput, indiaDateTimeInput, indiaInputTimestamp } from "../utils/indiaTime.js";
import "../styles/mobile-attendance.css";

const mins = (value) => `${Math.floor(Number(value || 0) / 60)}h ${String(Number(value || 0) % 60).padStart(2, "0")}m`;
const today = indiaDateInput;
const localDateTime = indiaDateTimeInput;

export default function OvertimePanel({ admin = false }) {
  const { csrfToken } = useAuth();
  const [data, setData] = useState({ requests: [], approvedMinutes: 0 });
  const [draft, setDraft] = useState({ workDate: today(), declaredLeaveTime: localDateTime() });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState(null);
  const [rejectionReason, setRejectionReason] = useState("");

  const load = async () => {
    try {
      const response = await overtimeApi.list();
      setData(response.data);
      setError("");
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to load overtime requests.");
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await overtimeApi.create({ ...draft, declaredLeaveTime: indiaInputTimestamp(draft.declaredLeaveTime) }, csrfToken);
      setMessage("OT request submitted for Super Admin verification.");
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to submit OT request.");
    } finally {
      setBusy(false);
    }
  };

  const beginReview = (item, action) => {
    if (busy) return;
    setError("");
    setRejectionReason("");
    setReviewing({ item, action });
  };

  const closeReview = () => {
    if (busy) return;
    setReviewing(null);
    setRejectionReason("");
  };

  const review = async () => {
    if (!reviewing || busy) return;
    const { item, action } = reviewing;
    if (action === "reject" && !rejectionReason.trim()) return;
    setBusy(true);
    setError("");
    try {
      await overtimeApi.review(item.id, action, { message: rejectionReason.trim() }, csrfToken);
      setReviewing(null);
      setRejectionReason("");
      setMessage(action === "approve" ? "Overtime request approved." : "Overtime request rejected with feedback.");
      await load();
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to review OT request.");
    } finally {
      setBusy(false);
    }
  };

  const reviewItem = reviewing?.item;
  const rejecting = reviewing?.action === "reject";

  return <section className="panel mb-4 attendance-overtime">
    <div className="mb-3">
      <div className="eyebrow">OVERTIME</div>
      <h2 className="h5 mb-1">{admin ? "Overtime Approval Management" : "Overtime (OT) Requests"}</h2>
      <p className="text-secondary small mb-0">Times use IST (Asia/Kolkata). Regular hours stop at each employee’s assigned end time plus 5 minutes; final punches are used for OT.</p>
    </div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {message && <div className="alert alert-success" role="status">{message}</div>}
    {!admin && <form className="row g-3 align-items-end border-bottom pb-3 mb-3" onSubmit={submit}>
      <div className="col-md-3"><label className="form-label" htmlFor="ot-work-date">Working date</label><input id="ot-work-date" className="form-control" type="date" required value={draft.workDate} onChange={(event) => setDraft({ ...draft, workDate: event.target.value })} /></div>
      <div className="col-md-4"><label className="form-label" htmlFor="ot-declared-leave">Expected / declared leaving time</label><input id="ot-declared-leave" className="form-control" type="datetime-local" required value={draft.declaredLeaveTime} onChange={(event) => setDraft({ ...draft, declaredLeaveTime: event.target.value })} /></div>
      <div className="col-auto"><button className="btn btn-primary" disabled={busy}>Request OT</button></div>
    </form>}
    <div className="table-responsive">
      <table className="table table-sm align-middle mb-0">
        <thead className="table-light"><tr><th>Date</th>{admin && <th>Employee</th>}<th>Official end</th><th>Declared leaving</th><th>Actual punch-out</th><th>OT</th><th>Status</th>{admin && <th>Action</th>}</tr></thead>
        <tbody>
          {data.requests.map((item) => <tr key={item.id}>
            <td>{item.workDate}</td>
            {admin && <td><strong>{item.employeeName}</strong><div className="small text-secondary">{item.username}</div></td>}
            <td>{item.officialEndTime}</td>
            <td>{new Date(item.declaredLeaveTime).toLocaleString()}</td>
            <td>{item.actualPunchOut ? new Date(item.actualPunchOut).toLocaleString() : <span className="text-warning">Waiting for punch-out</span>}</td>
            <td>{mins(item.status === "approved" ? item.approvedMinutes : item.requestedMinutes)}</td>
            <td><span className={`badge ${item.status === "approved" ? "text-bg-success" : item.status === "rejected" ? "text-bg-danger" : "text-bg-warning"}`}>{item.status}</span>{item.rejectionMessage && <div className="small text-danger">{item.rejectionMessage}</div>}</td>
            {admin && <td>{item.status === "pending" && <div className="d-flex gap-1"><button className="btn btn-sm btn-success" disabled={busy || !item.actualPunchOut} type="button" onClick={() => beginReview(item, "approve")}>Approve</button><button className="btn btn-sm btn-outline-danger" disabled={busy} type="button" onClick={() => beginReview(item, "reject")}>Reject</button></div>}</td>}
          </tr>)}
          {!data.requests.length && <tr><td colSpan={admin ? 8 : 7} className="text-center text-secondary py-3">No overtime requests yet.</td></tr>}
        </tbody>
      </table>
    </div>
    <ConfirmationDialog
      open={Boolean(reviewing)}
      title={rejecting ? "Reject overtime request?" : "Approve overtime request?"}
      description={rejecting ? "The employee will receive your feedback and the request will remain in their history." : "Approved overtime will be recorded from the verified final punch-out time."}
      details={reviewItem && <><strong>{reviewItem.employeeName || reviewItem.username} · {reviewItem.workDate}</strong><div className="small text-secondary mt-1">Verified OT: {reviewItem.actualPunchOut ? mins(reviewItem.verifiedMinutes ?? reviewItem.requestedMinutes) : "Awaiting final punch-out"} · Final punch-out: {reviewItem.actualPunchOut ? new Date(reviewItem.actualPunchOut).toLocaleString() : "Unavailable"}</div></>}
      actionLabel={rejecting ? "Confirm rejection" : "Confirm approval"}
      tone={rejecting ? "danger" : "primary"}
      requiresReason={rejecting}
      reason={rejectionReason}
      reasonLabel="Rejection reason"
      reasonPlaceholder="Explain why this overtime request cannot be approved."
      onReasonChange={(value) => { setRejectionReason(value); setError(""); }}
      onConfirm={review}
      onCancel={closeReview}
      busy={busy}
      error={error}
    />
  </section>;
}
