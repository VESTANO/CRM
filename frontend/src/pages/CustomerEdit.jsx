import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CustomerChangeHistory, FieldRows } from "./CustomerDetail.jsx";
import { customersApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { formatDate, formatDateTime } from "../utils/formatters.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";

export default function CustomerEdit() {
  const { datasetId, recordId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const detailUrl = `/datasets/${datasetId}/customers/${recordId}/`;
  const cachedDetail = peekCachedResponse(detailUrl)?.data || null;
  const [detail, setDetail] = useState(cachedDetail);
  const [form, setForm] = useState(() => cachedDetail ? {
    response: cachedDetail.record.response,
    callback_date: cachedDetail.record.callback_date || "",
    note: cachedDetail.record.note || "",
  } : { response: "", callback_date: "", note: "" });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [callbackDialog, setCallbackDialog] = useState({ open: false, mode: "edit", previousResponse: "" });
  const [callbackDateDraft, setCallbackDateDraft] = useState("");
  const [callbackDateError, setCallbackDateError] = useState("");

  useEffect(() => {
    setDetail(peekCachedResponse(detailUrl)?.data || null);
    setError("");
    customersApi
      .detail(datasetId, recordId)
      .then(({ data }) => {
        setDetail(data);
        setForm({
          response: data.record.response,
          callback_date: data.record.callback_date || "",
          note: data.record.note || "",
        });
      })
      .catch((err) => {
        if (err.response?.status === 404) {
          setError("Customer not found or you do not have permission to edit it.");
        } else {
          setError("Unable to load customer details.");
        }
      });
  }, [datasetId, recordId, detailUrl]);

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    setError("");
    if (form.response === "callback" && !form.callback_date) {
      setCallbackDateDraft("");
      setCallbackDateError("");
      setCallbackDialog({ open: true, mode: "edit", previousResponse: "callback" });
      return;
    }
    setIsSubmitting(true);
    try {
      await customersApi.update(datasetId, recordId, form, csrfToken);
      window.dispatchEvent(new Event("crm:callbacks-updated"));
      navigate(`/datasets/${datasetId}/customers/${recordId}`, {
        state: { message: "Customer CRM information updated successfully." },
      });
    } catch (err) {
      if (err.response?.data?.errors) {
        setErrors(err.response.data.errors);
      } else {
        setError("Unable to save customer information.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const changeResponse = (event) => {
    const response = event.target.value;
    if (response === "callback" && form.response !== "callback") {
      setCallbackDateDraft("");
      setCallbackDateError("");
      setCallbackDialog({ open: true, mode: "select", previousResponse: form.response });
      setForm({ ...form, response, callback_date: "" });
      return;
    }
    setForm({ ...form, response, callback_date: response === "callback" ? form.callback_date : "" });
  };

  const editCallbackDate = () => {
    setCallbackDateDraft(form.callback_date || "");
    setCallbackDateError("");
    setCallbackDialog({ open: true, mode: "edit", previousResponse: "callback" });
  };

  const cancelCallbackDate = () => {
    if (callbackDialog.mode === "select") {
      setForm({ ...form, response: callbackDialog.previousResponse, callback_date: "" });
    }
    setCallbackDialog({ open: false, mode: "edit", previousResponse: "" });
    setCallbackDateError("");
  };

  const confirmCallbackDate = () => {
    if (!callbackDateDraft) {
      setCallbackDateError("Choose a date for the callback.");
      return;
    }
    setForm({ ...form, response: "callback", callback_date: callbackDateDraft });
    setCallbackDialog({ open: false, mode: "edit", previousResponse: "" });
    setCallbackDateError("");
  };

  if (error) {
    return <div className="alert alert-danger">{error}</div>;
  }

  if (!detail) {
    return <div className="panel">Loading customer edit form...</div>;
  }

  const { dataset, record, fieldRows, responseChoices, changeHistory = [] } = detail;

  return (
    <>
      <nav aria-label="breadcrumb" className="mb-3">
        <ol className="breadcrumb mb-0">
          <li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${dataset.id}`}>{dataset.name}</Link></li>
          <li className="breadcrumb-item"><Link to={`/datasets/${dataset.id}/customers/${record.id}`}>Customer Details</Link></li>
          <li className="breadcrumb-item active" aria-current="page">Edit</li>
        </ol>
      </nav>

      <div className="page-header d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4">
        <div>
          <h1 className="h2 mb-2">Edit Customer</h1>
          <p className="text-secondary mb-0">{dataset.name} · CRM fields only</p>
        </div>
        <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${record.id}`}>Back</Link>
      </div>

      <div className="row g-4">
        <div className="col-lg-5">
          <div className="panel">
            <form onSubmit={submit} noValidate>
              <div className="mb-3">
                <label className="form-label" htmlFor="customer-response">Response</label>
                <select
                  className="form-select"
                  id="customer-response"
                  value={form.response}
                  onChange={changeResponse}
                >
                  {responseChoices.map((choice) => (
                    <option key={choice.value} value={choice.value}>{choice.label}</option>
                  ))}
                </select>
                <FieldErrors errors={errors.response} />
              </div>
              {record.callback_completed_at && (
                <div className="alert alert-success border mb-3">
                  <div className="fw-semibold">Callback completed</div>
                  <div className="small">
                    {formatDateTime(record.callback_completed_at)}
                    {record.callback_completed_by_username ? ` by ${record.callback_completed_by_username}` : ""}
                  </div>
                  <div className="small mt-1">The selected outcome and later edits are listed in Change History.</div>
                </div>
              )}
              {form.response === "callback" && (
                <div className="alert alert-light border d-flex flex-wrap justify-content-between align-items-center gap-2 mb-3">
                  <div>
                    <div className="fw-semibold">Callback Date</div>
                    <div className="text-secondary small">
                      {form.callback_date ? formatDate(form.callback_date) : "Not scheduled"}
                    </div>
                  </div>
                  <button className="btn btn-outline-primary btn-sm" type="button" onClick={editCallbackDate}>
                    {form.callback_date ? "Change date" : "Set date"}
                  </button>
                  <FieldErrors errors={errors.callback_date} />
                </div>
              )}
              <div className="mb-3">
                <label className="form-label" htmlFor="customer-note">Note</label>
                <textarea
                  className="form-control"
                  id="customer-note"
                  rows="5"
                  placeholder="Add CRM notes for this customer"
                  maxLength="2000"
                  value={form.note}
                  onChange={(event) => setForm({ ...form, note: event.target.value })}
                />
                <FieldErrors errors={errors.note} />
              </div>
              <div className="d-flex flex-wrap gap-2">
                <button className="btn btn-primary" type="submit" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save"}
                </button>
                <Link className="btn btn-outline-secondary" to={`/datasets/${dataset.id}/customers/${record.id}`}>Cancel</Link>
              </div>
            </form>
          </div>
        </div>
        <div className="col-lg-7">
          <div className="panel bg-light mb-4">
            <h2 className="h5 mb-3">Original Excel Data</h2>
            <FieldRows rows={fieldRows} />
          </div>
          <CustomerChangeHistory entries={changeHistory} className="mb-0" />
        </div>
      </div>

      {callbackDialog.open && (
        <CallbackDateDialog
          value={callbackDateDraft}
          error={callbackDateError}
          onChange={setCallbackDateDraft}
          onCancel={cancelCallbackDate}
          onConfirm={confirmCallbackDate}
        />
      )}
    </>
  );
}

function CallbackDateDialog({ value, error, onChange, onCancel, onConfirm }) {
  const dialogRef = useRef(null);
  const dateRef = useRef(null);
  useDialogFocus({ open: true, dialogRef, initialFocusRef: dateRef, onCancel });
  return (
    <>
      <div className="modal d-block business-dialog" ref={dialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="callback-date-dialog-title">
        <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h2 className="modal-title fs-5" id="callback-date-dialog-title">Set Callback Date</h2>
              <button className="btn-close" type="button" aria-label="Close" onClick={onCancel} />
            </div>
            <div className="modal-body">
              <label className="form-label" htmlFor="callback-date-dialog-input">Callback Date</label>
              <input
                className={`form-control ${error ? "is-invalid" : ""}`}
                id="callback-date-dialog-input"
                ref={dateRef}
                type="date"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                autoFocus
              />
              {error && <div className="invalid-feedback">{error}</div>}
              <div className="form-text">This customer will appear in the Callbacks page on the selected date.</div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline-secondary" type="button" onClick={onCancel}>Cancel</button>
              <button className="btn btn-primary" type="button" onClick={onConfirm}>Set Callback</button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}

function FieldErrors({ errors }) {
  if (!errors?.length) return null;
  return errors.map((error) => (
    <div className="text-danger small mt-2" key={error}>{error}</div>
  ));
}
