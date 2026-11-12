import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import { useStoreContext } from "../hooks/useStoreContext.js";
import { attendanceApi } from "../services/api.js";

function indiaDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function indiaTime(timestamp) {
  if (!timestamp) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(new Date(timestamp));
}

function indiaClockTime(offsetMinutes = 0) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + offsetMinutes * 60_000));
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${value.hour}:${value.minute}`;
}

function formatMinutes(minutes) {
  if (!Number.isFinite(minutes)) return "—";
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function workingHours(minutes, status) {
  if (!Number.isFinite(minutes)) return status === "checked_in" ? "In progress" : "—";
  return formatMinutes(minutes);
}

const initialValues = () => ({ attendanceDate: indiaDate(), checkIn: "09:30", checkOut: "17:30", breakTime: indiaClockTime(), breakEndTime: indiaClockTime(30), note: "" });

const modeCopy = {
  check_in: {
    heading: "Mark check-in",
    description: "Select the employees who are present now. This saves only their check-in; record their check-out when they leave.",
    timeLabel: "Check-in time",
    button: "Save check-in",
    empty: "Everyone selected already has attendance recorded for this date.",
  },
  check_out: {
    heading: "Record check-out",
    description: "Only employees with an open manual check-in are available below. Select the people leaving now and save their check-out.",
    timeLabel: "Check-out time",
    button: "Save check-out",
    empty: "No employees have an open manual check-in for this date.",
  },
  break: {
    heading: "Record break",
    description: "Select the employees taking a break, then record the break start and end times.",
    timeLabel: "Break start time",
    button: "Save break",
    empty: "No employees have an open manual check-in for this date.",
  },
};

export default function ManualAttendance({ view = "mark" }) {
  const { user } = useAuth();
  const storeId = useStoreContext();
  const [employees, setEmployees] = useState([]);
  const [records, setRecords] = useState([]);
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState([]);
  const [entryMode, setEntryMode] = useState("check_in");
  const [values, setValues] = useState(initialValues);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const needsStore = user?.is_superuser && !storeId;
  const recordsView = view === "records";
  const attendanceDate = values.attendanceDate;
  const copy = modeCopy[entryMode];

  useEffect(() => {
    if (needsStore) { setLoading(false); setEmployees([]); setRecords([]); return; }
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([attendanceApi.manualEmployees(attendanceDate), attendanceApi.manualRecords(attendanceDate)])
      .then(([employeesResponse, recordsResponse]) => {
        if (!active) return;
        setEmployees(employeesResponse.data.results || []);
        setRecords(recordsResponse.data.results || []);
      })
      .catch((requestError) => { if (active) setError(requestError.response?.data?.detail || "Unable to load manual attendance."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [attendanceDate, needsStore, refreshVersion, storeId]);

  const eligibleEmployees = useMemo(() => employees.filter((employee) => (
    entryMode === "check_in" ? employee.state === "not_started" : employee.state === "checked_in"
  )), [employees, entryMode]);

  useEffect(() => {
    setSelectedEmployeeIds(eligibleEmployees.map((employee) => employee.id));
  }, [entryMode, employees]);

  useEffect(() => {
    if (entryMode !== "break") return;
    setValues((current) => {
      if (current.breakTime && current.breakEndTime) return current;
      return {
        ...current,
        breakTime: current.breakTime || indiaClockTime(),
        breakEndTime: current.breakEndTime || indiaClockTime(30),
      };
    });
  }, [entryMode]);

  const change = (event) => {
    setMessage("");
    setValues((current) => ({ ...current, [event.target.name]: event.target.value }));
  };
  const switchMode = (mode) => {
    setMessage("");
    setError("");
    if (mode === "break") {
      setValues((current) => ({
        ...current,
        breakTime: current.breakTime || indiaClockTime(),
        breakEndTime: current.breakEndTime || indiaClockTime(30),
      }));
    }
    setEntryMode(mode);
  };
  const setAllEligible = () => setSelectedEmployeeIds(eligibleEmployees.map((employee) => employee.id));
  const toggleEmployee = (employeeId) => setSelectedEmployeeIds((current) => current.includes(employeeId)
    ? current.filter((id) => id !== employeeId)
    : [...current, employeeId]);
  const submit = async (event) => {
    event.preventDefault();
    if (saving || !selectedEmployeeIds.length) return;
    setSaving(true); setMessage(""); setError("");
    try {
      const { data } = await attendanceApi.createManual({
        action: entryMode,
        employee_ids: selectedEmployeeIds,
        attendance_date: attendanceDate,
        ...(entryMode === "check_in"
          ? { check_in: values.checkIn }
          : entryMode === "check_out"
            ? { check_out: values.checkOut }
            : { break_time: values.breakTime, break_end: values.breakEndTime }),
        note: values.note,
      });
      const actionLabel = entryMode === "check_in" ? "Check-in" : entryMode === "check_out" ? "Check-out" : "Break";
      const skipText = data.skippedCount
        ? entryMode === "check_in"
          ? ` ${data.skippedCount} employee${data.skippedCount === 1 ? " already has" : "s already have"} attendance for this date.`
          : ` ${data.skippedCount} employee${data.skippedCount === 1 ? " has" : "s have"} no open manual check-in.`
        : "";
      setMessage(`${actionLabel} saved for ${data.createdCount} employee${data.createdCount === 1 ? "" : "s"}.${skipText}`);
      setValues((current) => ({ ...current, note: "" }));
      setRefreshVersion((current) => current + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.detail || "Unable to save manual attendance.");
    } finally {
      setSaving(false);
    }
  };

  if (needsStore) return <section className="panel"><div className="eyebrow">STORE REQUIRED</div><h1 className="h3">Manual Attendance</h1><p className="text-secondary">Choose a store before recording attendance for its employees.</p><Link className="btn btn-primary" to="/admin-panel/stores">Open Stores</Link></section>;

  const pageTitle = recordsView ? "Employee Attendance" : "Manual Attendance";
  const pageDescription = recordsView
    ? "Review every active employee's manual check-in and check-out for the selected date."
    : "Record the daily roster in two steps: check employees in when they arrive, then add their check-out when they leave.";

  return <>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/attendance/manual">Manual Attendance</Link></li>{recordsView && <li className="breadcrumb-item active" aria-current="page">Employee Attendance</li>}</ol></nav>
    <div className="page-header mb-4"><div><div className="eyebrow">NON-BIOMETRIC STORE</div><h1 className="h2 mb-2">{pageTitle}</h1><p className="text-secondary mb-0">{pageDescription}</p></div></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {message && <div className="alert alert-success" role="status">{message}</div>}
    {recordsView ? <section className="panel" aria-labelledby="manual-attendance-records-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-end gap-3 mb-4"><div><h2 id="manual-attendance-records-heading" className="h5 mb-1">Employee Attendance List</h2><p className="text-secondary small mb-0">All active employees for the date you choose. Employees without a check-in are shown as absent.</p></div><div><label className="form-label" htmlFor="manual-attendance-records-date">Attendance date</label><input id="manual-attendance-records-date" className="form-control" name="attendanceDate" type="date" value={attendanceDate} onChange={change} required /></div></div>
      {loading ? <p role="status" className="mb-0">Loading employee attendance…</p> : records.length ? <div className="table-responsive"><table className="table align-middle mb-0"><thead><tr><th>Employee</th><th>Employee ID</th><th>Check-in</th><th>Check-out</th><th>Break</th><th>Working hours</th><th>Admin note</th><th>Status</th></tr></thead><tbody>{records.map((record) => <tr key={record.userId}><td><strong>{record.employeeName}</strong></td><td>{record.employeeId || "—"}</td><td>{indiaTime(record.checkIn)}</td><td>{indiaTime(record.checkOut)}</td><td>{record.breakMinutes ? formatMinutes(record.breakMinutes) : "—"}</td><td>{workingHours(record.workingMinutes, record.status)}</td><td className="text-wrap" style={{ minWidth: 180 }}>{record.notes?.join(" · ") || "—"}</td><td><span className={`badge ${record.status === "checked_out" ? "text-bg-success" : record.status === "checked_in" ? "text-bg-warning" : "text-bg-danger"}`}>{record.status === "checked_out" ? "Checked out" : record.status === "checked_in" ? "Checked in" : "Absent"}</span></td></tr>)}</tbody></table></div> : <p className="text-secondary mb-0">No active employees are available for this store.</p>}
    </section> : <section className="panel" aria-labelledby="manual-attendance-form-heading">
      <div className="d-flex flex-wrap justify-content-between align-items-start gap-3 mb-4"><div><h2 id="manual-attendance-form-heading" className="h5 mb-1">Daily attendance</h2><p className="text-secondary small mb-0">Check employees in, add each break as it happens, then record their check-out when they leave.</p></div><div className="btn-group" role="group" aria-label="Manual attendance action"><button type="button" className={`btn ${entryMode === "check_in" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => switchMode("check_in")}>Check-in</button><button type="button" className={`btn ${entryMode === "break" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => switchMode("break")}>Break</button><button type="button" className={`btn ${entryMode === "check_out" ? "btn-primary" : "btn-outline-primary"}`} onClick={() => switchMode("check_out")}>Check-out</button></div></div>
      {loading ? <p role="status">Loading employees…</p> : <form className="row g-3" onSubmit={submit}>
        <div className="col-12"><h3 className="h6 mb-1">{copy.heading}</h3><p className="text-secondary small mb-0">{copy.description}</p></div>
        <div className={entryMode === "break" ? "col-md-4" : "col-md-6"}><label className="form-label" htmlFor="manual-attendance-date">Attendance date</label><input id="manual-attendance-date" className="form-control" name="attendanceDate" type="date" value={attendanceDate} onChange={change} required /></div>
        <div className={entryMode === "break" ? "col-md-4" : "col-md-6"}><label className="form-label" htmlFor="manual-attendance-time">{copy.timeLabel}</label><input id="manual-attendance-time" className="form-control" name={entryMode === "check_in" ? "checkIn" : entryMode === "check_out" ? "checkOut" : "breakTime"} type="time" value={entryMode === "check_in" ? values.checkIn : entryMode === "check_out" ? values.checkOut : values.breakTime} onChange={change} required /></div>
        {entryMode === "break" && <div className="col-md-4"><label className="form-label" htmlFor="manual-attendance-break-end">Break end time</label><input id="manual-attendance-break-end" className="form-control" name="breakEndTime" type="time" value={values.breakEndTime} onChange={change} required /><div className="form-text">Working hours are reduced automatically. Add another entry for another break.</div></div>}
        <div className="col-12"><label className="form-label" htmlFor="manual-attendance-note">Note <span className="text-secondary">(optional)</span></label><textarea id="manual-attendance-note" className="form-control" name="note" rows="2" maxLength="500" value={values.note} onChange={change} placeholder="Optional note for this manual entry" /></div>
        <div className="col-12"><div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2"><div><label className="form-label mb-0">{entryMode === "check_in" ? "Employees to check in" : entryMode === "check_out" ? "Employees to check out" : "Employees taking a break"}</label><div className="form-text">{selectedEmployeeIds.length} of {eligibleEmployees.length} selected</div></div><div className="d-flex gap-2"><button className="btn btn-sm btn-outline-primary" type="button" onClick={setAllEligible} disabled={!eligibleEmployees.length}>Select all</button><button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => setSelectedEmployeeIds([])} disabled={!selectedEmployeeIds.length}>Clear all</button></div></div>
          {eligibleEmployees.length ? <div className="border rounded p-3" style={{ maxHeight: 340, overflowY: "auto" }}>{eligibleEmployees.map((employee) => <label className="form-check d-flex align-items-center gap-2 py-2 border-bottom" key={employee.id}><input className="form-check-input m-0" type="checkbox" checked={selectedEmployeeIds.includes(employee.id)} onChange={() => toggleEmployee(employee.id)} /><span><strong>{employee.name}</strong><span className="text-secondary ms-2">{employee.employeeId}</span></span></label>)}</div> : <p className="text-secondary small border rounded p-3 mb-0">{copy.empty}</p>}</div>
        <div className="col-12 d-flex gap-2"><button className="btn btn-primary" type="submit" disabled={saving || !selectedEmployeeIds.length}>{saving ? "Saving…" : `${copy.button} for ${selectedEmployeeIds.length || ""} Employee${selectedEmployeeIds.length === 1 ? "" : "s"}`}</button><Link className="btn btn-outline-secondary" to="/attendance/manual/records">View employee attendance</Link></div>
        {!employees.length && <div className="col-12"><p className="text-secondary small mb-0">No active employees are available for this store.</p></div>}
      </form>}
    </section>}
  </>;
}
