import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { useAuth } from "../hooks/useAuth.jsx";
import { useAttendanceAuth } from "../hooks/useAttendanceAuth.jsx";
import { apiClient } from "../services/api.js";
import { deleteLiveTimesheetEntry, fetchAttendanceDashboardTotals, fetchLiveAttendance, fetchLiveTimesheet, isAttendanceAdmin, isAttendanceSuperAdmin, manageLiveEmployee, requestAttendancePasswordOtp, reviewLiveTimesheetEntry, saveLiveAttendanceMapping, saveLiveTimesheetEntry, updateAttendanceProfileImage } from "../services/attendanceSupabase.js";
import { buildAttendanceDays, calculateAttendanceDay, countedAttendanceTime, dateInputValue, formatDuration, timeFromTimestamp } from "../utils/attendance.js";
import OvertimePanel from "../components/OvertimePanel.jsx";

const errorText = (error) => error.response?.data?.detail || "Unable to load attendance.";
const viewCopy = {
  overview: ["Attendance overview", "A quick summary of your team attendance and timesheets."],
  timesheet: ["My timesheet", "Review your own working hours and daily punches."],
  profile: ["My profile", "Manage your attendance profile and account security."],
  attendance: ["Attendance", "Track employee check-ins, check-outs, breaks, and working hours."],
  approvals: ["Attendance approvals", "Review submitted timesheets that need attention."],
  overtime: ["Overtime approvals", "Review and manage employee overtime requests."],
  employees: ["Attendance employees", "Manage attendance visibility and employee punch-code links."],
};

export default function Attendance({ view = "attendance" }) {
  const { user, csrfToken } = useAuth();
  const { profile: attendanceProfile, permission, isLoading: attendanceAuthLoading, error: attendanceAuthError, login: loginAttendance, logout: logoutAttendance } = useAttendanceAuth();
  const crmAdmin = Boolean(user?.is_admin);
  const [mode, setMode] = useState("live");
  const admin = mode === "live" ? isAttendanceAdmin(attendanceProfile) : crmAdmin;
  const superAdmin = mode === "live" ? isAttendanceSuperAdmin(attendanceProfile) : crmAdmin;
  const loginRequired = mode === "live" && !attendanceProfile;
  const [filters, setFilters] = useState({ from: "", to: "", userId: "" });
  const [data, setData] = useState({ records: [], employees: [], punchCodes: [], devices: [], availableFrom: "", availableTo: "" });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const loadedRef = useRef(false);
  const [mapping, setMapping] = useState({ punchCode: "", userId: "" });
  const [message, setMessage] = useState("");
  const [dashboardTotals, setDashboardTotals] = useState(null);
  const loadFallback = useCallback(async () => {
    const initialLoad = !loadedRef.current;
    if (initialLoad) setLoading(true); else setRefreshing(true);
    try { const response = await apiClient.get("/attendance/", { params: filters }); setData(response.data); setError(""); }
    catch (requestError) { setError(errorText(requestError)); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [filters]);
  const loadLive = useCallback(async () => {
    if (!attendanceProfile || !permission?.allowed) { setLoading(false); return; }
    const initialLoad = !loadedRef.current;
    if (initialLoad) setLoading(true); else setRefreshing(true);
    try { setData(await fetchLiveAttendance({ ...filters, profile: attendanceProfile })); setError(""); }
    catch (requestError) { setError(requestError.message || "Unable to load live attendance."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [attendanceProfile, filters, permission]);
  const load = mode === "live" ? loadLive : loadFallback;
  useEffect(() => { if (mode === "live" ? attendanceProfile && permission?.allowed : true) load(); }, [load, mode, attendanceProfile, permission]);
  useEffect(() => {
    const liveRefreshPage = view === "attendance" || (view === "overview" && !isAttendanceAdmin(attendanceProfile));
    if (!liveRefreshPage) return undefined;
    const id = window.setInterval(load, mode === "live" ? 15000 : 30000);
    return () => window.clearInterval(id);
  }, [attendanceProfile, load, mode, view]);
  useEffect(() => {
    if (view !== "overview" || !attendanceProfile) return undefined;
    let active = true;
    const refresh = async () => { try { const next = await fetchAttendanceDashboardTotals(attendanceProfile); if (active) setDashboardTotals(next); } catch { /* Overview attendance remains available if totals RPC is unavailable. */ } };
    refresh();
    if (isAttendanceAdmin(attendanceProfile)) return () => { active = false; };
    const id = window.setInterval(refresh, 15000); return () => { active = false; window.clearInterval(id); };
  }, [attendanceProfile, view]);
  const days = useMemo(() => buildAttendanceDays(data.records), [data.records]);
  const totals = useMemo(() => days.reduce((summary, day) => {
    const employee = data.employees.find((item) => item.id === day.userId) || {};
    const result = calculateAttendanceDay(day.punches, new Date(), employee);
    return { hours: summary.hours + (result.workingHours || 0), breaks: summary.breaks + (result.breakHours || 0), open: summary.open + (result.isOpen ? 1 : 0) };
  }, { hours: 0, breaks: 0, open: 0 }), [days, data.employees]);
  const saveMapping = async (event) => {
    event.preventDefault();
    try { const response = await apiClient.post("/attendance/mappings/", mapping, { headers: { "X-CSRFToken": csrfToken } }); setMessage(`${response.data.matched} punches linked to ${response.data.employee.name}.`); await load(); }
    catch (requestError) { setError(errorText(requestError)); }
  };
  const exportExcel = () => {
    const rows = days.map((day) => {
      const shift = data.employees.find((employee) => employee.id === day.userId) || {};
      const result = calculateAttendanceDay(day.punches, new Date(), shift);
      return [day.date, day.employeeName, countedAttendanceTime(day.punches[0], shift, "start"), result.isOpen ? "Open" : countedAttendanceTime(day.punches.at(-1), shift, "end"), formatDuration(result.breakHours), result.breakCount, formatDuration(result.workingHours), result.employeeStatus, day.punches.length];
    });
    const worksheet = XLSX.utils.aoa_to_sheet([["Date", "Employee", "Check in", "Check out", "Break time", "Break count", "Net working hours", "Employee status", "Punch count"], ...rows]);
    worksheet["!cols"] = [{ wch: 14 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 18 }, { wch: 16 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
    XLSX.writeFile(workbook, `attendance-${dateInputValue(new Date())}.xlsx`);
  };
  const [title, description] = viewCopy[view] || viewCopy.attendance;
  const switchToFallback = () => { setMode("fallback"); setError(""); loadFallback(); };
  const switchToLive = () => { setMode("live"); setError(""); };
  const saveLiveMapping = async (event) => { event.preventDefault(); try { const matched = await saveLiveAttendanceMapping(mapping.punchCode, mapping.userId); setMessage(`${matched || 0} punches linked successfully.`); setMapping({ punchCode: "", userId: "" }); await load(); } catch (requestError) { setError(requestError.message || "Unable to link the attendance punch code."); } };
  if (attendanceAuthLoading && !attendanceProfile) return <><div className="page-header mb-4"><div><div className="eyebrow">ATTENDANCE SECURITY</div><h1 className="h2 mb-2">{title}</h1><p className="text-secondary mb-0">Restoring the live attendance session…</p></div></div><section className="panel text-center py-5">Loading attendance authentication…</section></>;
  return <>
    <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4"><div><div className="eyebrow">{view === "attendance" ? "ESSL PUNCH RECORDS" : "Vestano International"}</div><h1 className="h2 mb-2">{title}</h1><p className="text-secondary mb-0">{description}</p></div><div className="d-flex align-items-center gap-2"><span className={`badge ${mode === "live" && attendanceProfile ? "text-bg-success" : "text-bg-secondary"}`}>{mode === "live" && attendanceProfile ? "Live Supabase" : "Attendance login required"}</span>{refreshing && <span className="text-secondary small">Refreshing…</span>}{attendanceProfile && <button className="btn btn-outline-secondary" onClick={logoutAttendance} type="button">Sign out attendance</button>}{!loginRequired && <button className="btn btn-outline-secondary" onClick={load} disabled={loading}><i className="bi bi-arrow-clockwise me-1" />{refreshing ? "Refreshing" : "Refresh"}</button>}</div></div>
    {error && <div className="alert alert-danger">{error}</div>}{message && <div className="alert alert-success">{message}</div>}
    {loginRequired && <AttendanceLogin error={attendanceAuthError} loading={attendanceAuthLoading} onLogin={loginAttendance} />}
    {!loginRequired && mode === "live" && attendanceProfile && permission && !permission.allowed && <section className="panel mb-4 border-danger"><h2 className="h5">Live attendance permission unavailable</h2><p className="text-secondary mb-3">{permission.message}</p></section>}
    {!loginRequired && mode === "fallback" && <div className="alert alert-warning d-flex flex-wrap justify-content-between align-items-center gap-2"><span><strong>Imported CRM backup:</strong> this data is from the ZIP snapshot, not live Vestano records.</span><button className="btn btn-sm btn-outline-dark" type="button" onClick={switchToLive}>Return to live attendance</button></div>}
    {!loginRequired && view === "overview" && <Overview days={days} data={data} totals={totals} dashboardTotals={dashboardTotals} loading={loading} admin={admin} profile={attendanceProfile} />}
    {!loginRequired && view === "timesheet" && <TimesheetView profile={attendanceProfile} employees={data.employees} />}
    {!loginRequired && view === "profile" && <ProfileView profile={attendanceProfile} />}
    {!loginRequired && view === "employees" && (mode === "live" ? (superAdmin ? <AdminLiveEmployees data={data} onRefresh={load} /> : <LiveEmployees data={data} admin={admin} />) : <Employees data={data} admin={admin} mapping={mapping} setMapping={setMapping} saveMapping={saveMapping} />)}
    {!loginRequired && view === "approvals" && <LiveApprovals profile={attendanceProfile} employees={data.employees} />}
    {!loginRequired && view === "overtime" && <OvertimePanel admin={crmAdmin || superAdmin} />}
    {!loginRequired && view === "attendance" && <><div className="metric-grid attendance-metrics mb-4"><Metric icon="bi-calendar-check" label="Daily records" value={days.length} /><Metric icon="bi-clock-history" label="Punches" value={data.records.length} /><Metric icon="bi-hourglass-split" label="Net hours" value={formatDuration(totals.hours)} /><Metric icon="bi-calendar-range" label="Saved range" value={<><SavedRangeDate value={data.availableFrom || "—"} /><span className="saved-range-separator">to</span><SavedRangeDate value={data.availableTo || "—"} /></>} /></div>{superAdmin && <section className="panel mb-4"><div className="table-panel-header"><div className="eyebrow">ADMIN DEVICE SETUP</div><h2 className="h5 mb-1">eSSL network push settings</h2><p className="text-secondary small mb-3">The machine user code must match the employee Employee ID.</p></div><div className="row g-3 small"><div className="col-md-3"><span className="text-secondary d-block">Protocol</span><strong>ADMS / iClock push</strong></div><div className="col-md-3"><span className="text-secondary d-block">Connected devices</span><strong>{data.devices?.length || 0}</strong></div><div className="col-md-3"><span className="text-secondary d-block">Last sync</span><strong>{data.lastSync ? data.lastSync.slice(0, 19).replace("T", " ") : "Waiting for device"}</strong></div><div className="col-md-3"><span className="text-secondary d-block">Saved records</span><strong>{data.records.length}</strong></div></div></section>}{superAdmin && <section className="panel mb-4"><div className="table-panel-header"><div className="eyebrow">EMPLOYEE ATTENDANCE LINK</div><h2 className="h5 mb-1">Link machine code to employee</h2><p className="text-secondary small mb-3">Only the Super Admin can map biometric punch codes.</p></div>{!data.punchCodes?.length && <div className="alert alert-info mb-3">No unlinked punch codes are currently available. New device punches will appear here.</div>}<form className="row g-3 align-items-end" onSubmit={saveLiveMapping}><div className="col-md-4"><label className="form-label" htmlFor="liveMappingCode">Machine punch code</label><select id="liveMappingCode" className="form-select" required disabled={!data.punchCodes?.length} value={mapping.punchCode} onChange={(event) => setMapping({ ...mapping, punchCode: event.target.value })}><option value="">Select punch code</option>{data.punchCodes.map((code) => <option key={code.punchCode} value={code.punchCode}>{code.punchCode} — {code.employeeName || "Not linked"}</option>)}</select></div><div className="col-md-5"><label className="form-label" htmlFor="liveMappingEmployee">Employee name</label><select id="liveMappingEmployee" className="form-select" required disabled={!data.punchCodes?.length} value={mapping.userId} onChange={(event) => setMapping({ ...mapping, userId: event.target.value })}><option value="">Select employee</option>{data.employees.filter((employee) => employee.role === "employee").map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div><div className="col-auto"><button className="btn btn-primary" type="submit" disabled={!data.punchCodes?.length}>Link employee</button></div></form></section>}<section className="panel mb-4"><div className="row g-3 align-items-end">{admin && <div className="col-md-4"><label className="form-label" htmlFor="attendanceEmployee">Filter by employee</label><select id="attendanceEmployee" className="form-select" value={filters.userId} onChange={(event) => setFilters({ ...filters, userId: event.target.value })}><option value="">All employees</option>{data.employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div>}<div className="col-md-3"><label className="form-label" htmlFor="attendanceFrom">From</label><input id="attendanceFrom" className="form-control" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceTo">To</label><input id="attendanceTo" className="form-control" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></div><div className="col-auto"><button className="btn btn-primary" onClick={load}>Apply filters</button></div><div className="col-auto"><button className="btn btn-outline-secondary" onClick={() => setFilters({ ...filters, from: "", to: "", userId: "" })}>Clear</button></div></div></section><section className="panel mb-4 d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ATTENDANCE EXPORT</div><h2 className="h5 mb-1">Download attendance report</h2><p className="text-secondary small mb-0">Export the records selected by your filters.</p></div><button className="btn btn-primary" type="button" onClick={exportExcel}><i className="bi bi-file-earmark-excel me-1" />Download XLSX</button></section><AttendanceTable days={days} data={data} admin={admin} loading={loading} /></>}
  </>;
}

function ProfileView({ profile }) {
  const [image, setImage] = useState(profile?.profileImage || "");
  const [savedImage, setSavedImage] = useState(profile?.profileImage || "");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const canResetPassword = ["admin", "super_admin"].includes(String(profile?.role || "").toLowerCase());
  const initials = (profile?.name || "User").split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  const readImage = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const source = new Image();
      source.onload = () => {
        const maxDimension = 512;
        const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(source.width * scale));
        canvas.height = Math.max(1, Math.round(source.height * scale));
        canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
        setImage(canvas.toDataURL("image/jpeg", 0.8));
      };
      source.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  };
  const hasImageChange = image !== savedImage && Boolean(image || savedImage);
  const save = async (event) => { event.preventDefault(); setBusy(true); setError(""); setMessage(""); try { await updateAttendanceProfileImage(image); setSavedImage(image); setMessage(image ? "Profile image saved." : "Profile image removed."); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } };
  const removeImage = async () => { setBusy(true); setError(""); setMessage(""); try { await updateAttendanceProfileImage(null); setImage(""); setSavedImage(""); setMessage("Profile image removed."); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } };
  const resetPassword = async () => { setBusy(true); setError(""); setMessage(""); try { await requestAttendancePasswordOtp(profile.email); setMessage(`Password reset email sent to ${String(profile.email || "").replace(/^(.{2}).*(@.*)$/, "$1***$2")}.`); } catch (requestError) { setError(requestError.message); } finally { setBusy(false); } };
  return <section className="panel"><div className="eyebrow">PERSONAL ACCOUNT</div><h2 className="h4 mb-1">My Profile</h2><p className="text-secondary mb-4">Manage your profile image and reset your password securely by email OTP.</p><form onSubmit={save}><div className="row g-4"><div className="col-md-4 text-center"><div className="summary-card mb-3">{image ? <img src={image} alt="Profile" style={{ width: 128, height: 128, objectFit: "cover", borderRadius: "50%" }} /> : <div className="display-4">{initials}</div>}<h3 className="h5 mt-3">{profile?.name || "Attendance user"}</h3><p className="text-secondary mb-3">{profile?.employeeId || "—"}</p><input className="form-control" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => readImage(event.target.files?.[0])} /><button className="btn btn-outline-secondary btn-sm mt-2" type="button" disabled={busy || !image} onClick={removeImage}>Remove image</button></div></div><div className="col-md-8"><div className="row g-3"><div className="col-md-6"><div className="text-secondary small">Employee ID</div><strong>{profile?.employeeId || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Role</div><strong>{profile?.role === "super_admin" ? "Super Admin" : profile?.role === "admin" ? "Admin" : "Employee"}</strong></div><div className="col-md-6"><div className="text-secondary small">Email</div><strong>{profile?.email || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Department</div><strong>{profile?.department || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Manager</div><strong>{profile?.manager || "—"}</strong></div></div><div className="d-flex flex-wrap gap-2 mt-4"><button className="btn btn-primary" disabled={busy || !hasImageChange}>{busy ? "Saving…" : "Save profile image"}</button>{canResetPassword && <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={resetPassword}>Reset password by email OTP</button>}</div></div></div></form>{message && <div className="alert alert-success mt-4 mb-0">{message}</div>}{error && <div className="alert alert-danger mt-4 mb-0">{error}</div>}</section>;
}

function TimesheetView({ profile, employees }) {
  const admin = isAttendanceAdmin(profile);
  const [filters, setFilters] = useState({ from: "", to: "", status: "", employeeId: "" });
  const [entries, setEntries] = useState([]);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const loadedRef = useRef(false);
  const load = useCallback(async () => {
    if (!profile) return;
    const initial = !loadedRef.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try { setEntries(await fetchLiveTimesheet({ ...filters, profile })); setError(""); }
    catch (requestError) { setError(requestError.message || "Unable to load live timesheet entries."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [filters, profile]);
  useEffect(() => { load(); }, [load]);
  const openEntry = (entry = null) => setDraft(entry ? { ...entry } : { date: dateInputValue(new Date()), category: "Project Work", project: "", details: "", startTime: profile?.shiftStartTime || "09:00", endTime: profile?.shiftEndTime || "17:30", breakHours: 0.5, workStatus: "Completed", billable: false, comments: "" });
  const saveEntry = async (event) => { event.preventDefault(); setSaving(true); try { await saveLiveTimesheetEntry(draft); setDraft(null); await load(); } catch (saveError) { setError(saveError.message); } finally { setSaving(false); } };
  const removeEntry = async (id) => {
    const entry = entries.find((candidate) => candidate.id === id) || {};
    const approvedWarning = entry.approvalStatus === "Approved"
      ? "This timesheet is approved. Deleting it will remove the approved record and its audit history. Continue?"
      : "Delete this work entry?";
    if (!window.confirm(approvedWarning)) return;
    try { await deleteLiveTimesheetEntry(entry.id); await load(); } catch (deleteError) { setError(deleteError.message); }
  };
  const exportTimesheet = () => {
    const rows = entries.map((entry) => [
      entry.date,
      entry.employeeName || "",
      entry.employeeId || "",
      entry.project || "",
      entry.details || "",
      entry.startTime || "",
      entry.endTime || "",
      Number(entry.breakHours || 0),
      Number(entry.totalHours || 0),
      Number(entry.overtime || 0),
      entry.workStatus || "",
      entry.approvalStatus || "Submitted",
      entry.approvalComment || "",
      entry.billable ? "Yes" : "No",
      entry.comments || "",
    ]);
    const worksheet = XLSX.utils.aoa_to_sheet([[
      "Date", "Employee", "Employee ID", "Project", "Work details", "Start", "End",
      "Break hours", "Total hours", "Overtime", "Work status", "Approval status",
      "Approval comment", "Billable", "Comments",
    ], ...rows]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Timesheet");
    XLSX.writeFile(workbook, `timesheet-${dateInputValue(new Date())}.xlsx`);
  };
  const canDelete = !admin || profile?.role === "super_admin";
  return <section className="panel p-0 responsive-table">
    <div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">DAILY WORK LOG</div><h2 className="h5 mb-1">My Timesheet</h2><p className="text-secondary small mb-0">Add work details, track hours, and follow approval status.</p></div><div className="d-flex flex-wrap align-items-center gap-2"><span className="text-secondary small">{refreshing ? "Refreshing…" : "Live Supabase"}</span>{admin && <button className="btn btn-outline-primary btn-sm" type="button" onClick={exportTimesheet} disabled={!entries.length}><i className="bi bi-file-earmark-excel me-1" />Download XLSX</button>}<button className="btn btn-primary btn-sm" type="button" onClick={() => openEntry()}>+ New entry</button></div></div>
    {error && <div className="alert alert-danger m-3">{error}</div>}
    {draft && <form className="p-3 border-bottom row g-3" onSubmit={saveEntry}><div className="col-md-3"><label className="form-label">Date</label><input className="form-control" type="date" required value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></div><div className="col-md-3"><label className="form-label">Project</label><input className="form-control" required value={draft.project} onChange={(event) => setDraft({ ...draft, project: event.target.value })} /></div><div className="col-md-6"><label className="form-label">Work details</label><input className="form-control" required value={draft.details} onChange={(event) => setDraft({ ...draft, details: event.target.value })} /></div><div className="col-md-2"><label className="form-label">Category</label><input className="form-control" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></div><div className="col-md-2"><label className="form-label">Start</label><input className="form-control" type="time" required value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /></div><div className="col-md-2"><label className="form-label">End</label><input className="form-control" type="time" required value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></div><div className="col-md-2"><label className="form-label">Break hours</label><input className="form-control" type="number" min="0" max="8" step="0.25" value={draft.breakHours} onChange={(event) => setDraft({ ...draft, breakHours: event.target.value })} /></div><div className="col-md-2"><label className="form-label">Work status</label><select className="form-select" value={draft.workStatus} onChange={(event) => setDraft({ ...draft, workStatus: event.target.value })}><option>Completed</option><option>In progress</option><option>Blocked</option></select></div><div className="col-md-2 form-check mt-4 ms-2"><input id="timesheetBillable" className="form-check-input" type="checkbox" checked={Boolean(draft.billable)} onChange={(event) => setDraft({ ...draft, billable: event.target.checked })} /><label className="form-check-label" htmlFor="timesheetBillable">Billable</label></div><div className="col-md-6"><label className="form-label">Comments</label><input className="form-control" value={draft.comments || ""} onChange={(event) => setDraft({ ...draft, comments: event.target.value })} /></div><div className="col-12 d-flex gap-2"><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save and submit"}</button><button className="btn btn-outline-secondary" type="button" onClick={() => setDraft(null)}>Cancel</button></div></form>}
    <div className="p-3 border-bottom"><div className="row g-3 align-items-end"><div className="col-md-3"><label className="form-label" htmlFor="timesheetFrom">From</label><input id="timesheetFrom" className="form-control" type="date" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="timesheetTo">To</label><input id="timesheetTo" className="form-control" type="date" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="timesheetStatus">Approval</label><select id="timesheetStatus" className="form-select" value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}><option value="">All statuses</option><option value="Submitted">Submitted</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option></select></div>{admin && <div className="col-md-3"><label className="form-label" htmlFor="timesheetEmployee">Employee</label><select id="timesheetEmployee" className="form-select" value={filters.employeeId} onChange={(event) => setFilters({ ...filters, employeeId: event.target.value })}><option value="">All employees</option>{employees.map((employee) => <option key={employee.id} value={employee.employeeId}>{employee.name} ({employee.employeeId})</option>)}</select></div>}<div className="col-auto"><button className="btn btn-outline-secondary" type="button" onClick={() => setFilters({ from: "", to: "", status: "", employeeId: "" })}>Clear</button></div></div></div>
    <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th>{admin && <th>Employee</th>}<th>Project & work details</th><th>Time</th><th>Hours</th><th>Work status</th><th>Approval</th><th>Actions</th></tr></thead><tbody>{loading ? <tr><td colSpan={admin ? 8 : 7} className="text-center py-5">Loading timesheet…</td></tr> : entries.map((entry) => <tr key={entry.id}><td>{entry.date}</td>{admin && <td><strong>{entry.employeeName || "—"}</strong><div className="small text-secondary">{entry.employeeId || "—"}</div></td>}<td><strong>{entry.project || "—"}</strong><div className="small text-secondary">{entry.details || entry.category || "—"}</div>{entry.comments && <div className="small text-secondary">{entry.comments}</div>}</td><td>{entry.startTime || "—"} – {entry.endTime || "—"}</td><td className="fw-semibold">{Number(entry.totalHours || 0).toFixed(2)}h{entry.overtime ? <div className="small text-secondary">{Number(entry.overtime).toFixed(2)} OT</div> : null}</td><td>{entry.workStatus || "—"}</td><td><span className={`badge ${entry.approvalStatus === "Approved" ? "text-bg-success" : entry.approvalStatus === "Rejected" ? "text-bg-danger" : "text-bg-primary"}`}>{entry.approvalStatus || "Submitted"}</span>{entry.approvalComment && <div className="small text-secondary">{entry.approvalComment}</div>}</td><td>{!admin && entry.approvalStatus !== "Approved" && <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openEntry(entry)}>Edit</button>}{canDelete && <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeEntry(entry.id)}>Delete</button>}</td></tr>)}{!loading && !entries.length && <tr><td colSpan={admin ? 8 : 7} className="text-center py-5 text-secondary">No entries match this view.</td></tr>}</tbody></table></div>
  </section>;
}
function SavedRangeDate({ value }) {
  const parts = String(value || "—").split("-");
  if (parts.length !== 3) return <span className="saved-range-date">{value}</span>;
  return <span className="saved-range-date"><span>{parts[0]}-</span><span>{parts[1]}</span><span>-{parts[2]}</span></span>;
}

function Metric({ icon, label, value }) { return <div className="summary-card"><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className="summary-value">{value}</div></div>; }

function Overview({ days, data, totals, dashboardTotals, loading, admin, profile }) {
  const today = dateInputValue(new Date());
  const todayRecord = days.find((day) => day.date === today);
  const employeeView = !admin;
  const employee = profile || {};
  const todayTotals = todayRecord ? calculateAttendanceDay(todayRecord.punches, new Date(), employee) : null;
  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening";
  const dateLabel = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());
  const metrics = employeeView
    ? [["Hours this month", dashboardTotals ? dashboardTotals.hours.toFixed(1) : "—", "bi-hourglass-split"], ["Pending approval", dashboardTotals?.pending ?? "—", "bi-hourglass"], ["Billable hours", dashboardTotals ? dashboardTotals.billable.toFixed(1) : "—", "bi-cash-stack"], ["Overtime", dashboardTotals ? dashboardTotals.overtime.toFixed(1) : "—", "bi-clock-history"]]
    : [["Team hours", dashboardTotals ? dashboardTotals.hours.toFixed(1) : "—", "bi-hourglass-split"], ["Pending approvals", dashboardTotals?.pending ?? "—", "bi-hourglass"], ["Billable hours", dashboardTotals ? dashboardTotals.billable.toFixed(1) : "—", "bi-cash-stack"], ["Active employees", dashboardTotals?.employees ?? data.employees.length, "bi-people"]];
  return <>
    <section className="panel p-4 mb-4 d-flex flex-wrap justify-content-between align-items-center gap-4"><div><div className="eyebrow">YOUR WORKSPACE</div><h1 className="h2 mb-2">{greeting}{employee.name ? `, ${employee.name.split(" ")[0]}` : ""}</h1><p className="text-secondary mb-0">Here is a clear view of attendance and what needs attention.</p></div><div className="summary-card today-summary-card text-center"><div className="text-secondary small">Today</div><strong className="h5 mb-0">{dateLabel}</strong></div></section>
    <div className="metric-grid mb-4">{metrics.map(([label, value, icon]) => <Metric key={label} icon={icon} label={label} value={value} />)}</div>
    <section className="panel p-4 mb-4"><div className="eyebrow">THIS WEEK</div><h2 className="h4 mb-2">Keep your record current</h2><p className="text-secondary mb-3">Daily attendance records make approvals faster and give your team an accurate picture.</p><Link className="btn btn-outline-primary" to="/attendance/timesheet">Open my timesheet</Link></section>
    {employeeView && <section className="panel p-0 mb-4 responsive-table"><div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-2"><div><div className="eyebrow">MY ATTENDANCE</div><h2 className="h5 mb-0">Recent attendance</h2></div><span className={`badge ${todayTotals ? "text-bg-primary" : "text-bg-secondary"}`}>{todayTotals ? todayTotals.employeeStatus : "No punch today"}</span></div>{todayRecord && <div className="p-3 row g-3"><div className="col-md-2"><div className="text-secondary small">Check in</div><strong>{countedAttendanceTime(todayRecord.punches[0], employee, "start")}</strong></div><div className="col-md-2"><div className="text-secondary small">Check out</div><strong>{todayTotals?.isOpen ? "—" : countedAttendanceTime(todayRecord.punches.at(-1), employee, "end")}</strong></div><div className="col-md-2"><div className="text-secondary small">Break time</div><strong>{formatDuration(todayTotals?.breakHours)}</strong></div><div className="col-md-2"><div className="text-secondary small">Break count</div><strong>{todayTotals?.breakCount || 0}</strong></div><div className="col-md-2"><div className="text-secondary small">Net working</div><strong>{formatDuration(todayTotals?.workingHours)}</strong></div></div>}<AttendanceTable days={days.slice(0, 7)} data={data} admin={false} loading={loading} compact /></section>}
  </>;
}

function LiveApprovals({ profile, employees }) {
  const admin = isAttendanceAdmin(profile);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(null);
  const [comment, setComment] = useState("");
  const loadedRef = useRef(false);
  const load = useCallback(async () => {
    if (!profile || !admin) { setLoading(false); return; }
    const initial = !loadedRef.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try { setEntries(await fetchLiveTimesheet({ status: "Submitted", profile })); setError(""); }
    catch (requestError) { setError(requestError.message || "Unable to load pending approvals."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [admin, profile]);
  useEffect(() => { load(); }, [load]);
  const review = async (status) => {
    if (!reviewing) return;
    try { await reviewLiveTimesheetEntry(reviewing.id, status, comment); setReviewing(null); setComment(""); await load(); }
    catch (requestError) { setError(requestError.message || "Unable to review the timesheet entry."); }
  };
  if (!admin) return <section className="panel"><h2 className="h5">Admin workspace</h2><p className="text-secondary mb-0">Timesheet approvals are available to attendance administrators.</p></section>;
  return <section className="panel p-0 responsive-table">
    <div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ADMIN WORKSPACE</div><h2 className="h5 mb-1">Timesheet Approvals</h2><p className="text-secondary small mb-0">Review submitted work from the live attendance system.</p></div><span className="text-secondary small">{refreshing ? "Refreshing…" : "Live Supabase"}</span></div>
    {error && <div className="alert alert-danger m-3">{error}</div>}
    {reviewing && <div className="p-3 border-bottom bg-light"><strong>{reviewing.employeeName || reviewing.employeeId} · {reviewing.date}</strong><div className="small text-secondary mt-1">{reviewing.project || "—"}: {reviewing.details || "—"} · {Number(reviewing.totalHours || 0).toFixed(2)} hours</div><textarea className="form-control mt-3" rows="2" placeholder="Optional approval comment" value={comment} onChange={(event) => setComment(event.target.value)} /><div className="d-flex gap-2 mt-3"><button className="btn btn-success btn-sm" type="button" onClick={() => review("Approved")}>Approve</button><button className="btn btn-danger btn-sm" type="button" onClick={() => review("Rejected")}>Reject</button><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => setReviewing(null)}>Cancel</button></div></div>}
    <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th><th>Employee</th><th>Project & work details</th><th>Time</th><th>Hours</th><th>Work status</th><th>Action</th></tr></thead><tbody>{loading ? <tr><td colSpan="7" className="text-center py-5">Loading approvals…</td></tr> : entries.map((entry) => <tr key={entry.id}><td>{entry.date}</td><td><strong>{entry.employeeName || "—"}</strong><div className="small text-secondary">{entry.employeeId || "—"}</div></td><td><strong>{entry.project || "—"}</strong><div className="small text-secondary">{entry.details || entry.category || "—"}</div></td><td>{entry.startTime || "—"} – {entry.endTime || "—"}</td><td className="fw-semibold">{Number(entry.totalHours || 0).toFixed(2)}h</td><td>{entry.workStatus || "—"}</td><td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => setReviewing(entry)}>Review</button></td></tr>)}{!loading && !entries.length && <tr><td colSpan="7" className="text-center py-5 text-secondary">No submitted timesheets require approval.</td></tr>}</tbody></table></div>
  </section>;
}

function AttendanceLogin({ error, loading, onLogin }) { const [identity, setIdentity] = useState(""); const [password, setPassword] = useState(""); const [submitting, setSubmitting] = useState(false); const submit = async (event) => { event.preventDefault(); setSubmitting(true); try { await onLogin(identity, password); } catch { /* error is rendered by the parent */ } finally { setSubmitting(false); } }; return <section className="panel mb-4"><div className="row align-items-center g-4"><div className="col-lg-5"><div className="eyebrow">LIVE VESTANO ATTENDANCE</div><h2 className="h4">Sign in to attendance</h2><p className="text-secondary mb-0">Use your existing attendance employee ID/email and password. This session is separate from CRM login and respects Vestano Supabase permissions.</p></div><div className="col-lg-7"><form className="row g-3 align-items-end" onSubmit={submit}><div className="col-md-5"><label className="form-label" htmlFor="attendanceIdentity">Employee ID or email</label><input id="attendanceIdentity" className="form-control" value={identity} onChange={(event) => setIdentity(event.target.value)} autoComplete="username" required /></div><div className="col-md-5"><label className="form-label" htmlFor="attendancePassword">Password</label><input id="attendancePassword" className="form-control" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></div><div className="col-auto"><button className="btn btn-primary" disabled={loading || submitting}>{submitting ? "Signing in…" : "Sign in"}</button></div></form>{error && <div className="alert alert-danger mt-3 mb-0">{error}</div>}</div></div></section>; }

function AdminLiveEmployees({ data, onRefresh }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const focusEditor = () => window.requestAnimationFrame(() => window.requestAnimationFrame(() => document.querySelector("section.panel.p-0.responsive-table form")?.scrollIntoView({ behavior: "smooth", block: "start" })));
  const openNew = () => { setShowPassword(false); setError(""); setDraft({ mode: "create", employeeId: "", name: "", email: "", department: "", manager: "", role: "employee", shiftStartTime: "09:30", shiftEndTime: "17:30", password: "" }); focusEditor(); };
  const openEdit = (employee) => { setShowPassword(false); setError(""); setDraft({ mode: "edit", id: employee.id, employeeId: employee.employeeId || "", name: employee.name || "", email: employee.email || "", department: employee.department || "", manager: employee.manager || "", role: employee.role || "employee", shiftStartTime: employee.shiftStartTime || "09:30", shiftEndTime: employee.shiftEndTime || "17:30", password: "" }); focusEditor(); };
  const submit = async (event) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { mode, id, password, ...values } = draft;
      if (mode === "create") await manageLiveEmployee("create", { ...values, password });
      else await manageLiveEmployee("update", { userId: id, ...values, ...(password ? { password } : {}) });
      setDraft(null); await onRefresh();
    } catch (requestError) { setError(requestError.message || "Employee request failed."); }
    finally { setBusy(false); }
  };
  const toggle = async (employee) => { setBusy(true); setError(""); try { await manageLiveEmployee("update", { userId: employee.id, active: !employee.active }); await onRefresh(); } catch (requestError) { setError(requestError.message || "Unable to update employee access."); } finally { setBusy(false); } };
  const remove = async (employee) => { if (!window.confirm(`Delete ${employee.name}?`)) return; setBusy(true); setError(""); try { await manageLiveEmployee("delete", { userId: employee.id }); await onRefresh(); } catch (requestError) { setError(requestError.message || "Unable to delete employee."); } finally { setBusy(false); } };
  return <section className="panel p-0 responsive-table"><div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ADMINISTRATION</div><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">Create accounts and manage access for the company.</p></div><button className="btn btn-primary" type="button" onClick={openNew}>+ Add employee</button></div>{error && <div className="alert alert-danger m-3">{error}</div>}{draft && <form className="p-3 border-bottom row g-3" onSubmit={submit}><div className="col-md-3"><label className="form-label">Employee ID</label><input className="form-control" required value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value.toUpperCase() })} /></div><div className="col-md-3"><label className="form-label">Name</label><input className="form-control" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div><div className="col-md-3"><label className="form-label">Username / login email</label><input className="form-control" type="email" required value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></div><div className="col-md-3"><label className="form-label">Department</label><input className="form-control" value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })} /></div><div className="col-md-3"><label className="form-label">Manager</label><input className="form-control" value={draft.manager} onChange={(event) => setDraft({ ...draft, manager: event.target.value })} /></div><div className="col-md-2"><label className="form-label">Role</label><select className="form-select" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="employee">Employee</option><option value="admin">Admin</option></select></div><div className="col-md-2"><label className="form-label">Start</label><input className="form-control" type="time" value={draft.shiftStartTime} onChange={(event) => setDraft({ ...draft, shiftStartTime: event.target.value })} /></div><div className="col-md-2"><label className="form-label">End</label><input className="form-control" type="time" value={draft.shiftEndTime} onChange={(event) => setDraft({ ...draft, shiftEndTime: event.target.value })} /></div><div className="col-md-3"><label className="form-label">{draft.mode === "create" ? "Temporary password" : "New password"}</label><div className="input-group"><input className="form-control" type={showPassword ? "text" : "password"} minLength="6" required={draft.mode === "create"} placeholder={draft.mode === "edit" ? "Leave blank to keep current" : ""} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><button className="btn btn-outline-secondary" type="button" aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}><i className={`bi bi-eye${showPassword ? "-slash" : ""}`} aria-hidden="true"></i></button></div></div><div className="col-12 d-flex gap-2"><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : draft.mode === "create" ? "Create employee" : "Save changes"}</button><button className="btn btn-outline-secondary" type="button" onClick={() => setDraft(null)}>Cancel</button></div></form>}<div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Employee</th><th>ID</th><th>Department</th><th>Manager</th><th>Shift</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name || "—"}</strong><div className="small text-secondary">{employee.email || "—"}</div></td><td>{employee.employeeId || "—"}</td><td>{employee.department || "—"}</td><td>{employee.manager || "—"}</td><td>{employee.shiftStartTime || "09:00"}–{employee.shiftEndTime || "17:30"}</td><td><span className="badge text-bg-secondary">{employee.role === "super_admin" ? "Super Admin" : employee.role === "admin" ? "Admin" : "Employee"}</span></td><td><button className={`btn btn-sm ${employee.active ? "btn-outline-danger" : "btn-outline-success"}`} disabled={busy || ["super_admin", "admin"].includes(employee.role)} type="button" onClick={() => toggle(employee)}>{employee.active ? "Deactivate" : "Activate"}</button></td><td><button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openEdit(employee)}>Edit</button>{!employee.active && !["super_admin", "admin"].includes(employee.role) && <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => remove(employee)}>Delete</button>}</td></tr>)}</tbody></table></div></section>;
}

function LiveEmployees({ data, admin }) {
  const recordCounts = data.records.reduce((counts, record) => { counts[record.userId] = (counts[record.userId] || 0) + 1; return counts; }, {});
  return <section className="panel p-0 responsive-table"><div className="table-panel-header d-flex justify-content-between align-items-center"><div><div className="eyebrow">ADMINISTRATION</div><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">Live profiles from the Vestano attendance directory.</p></div><span className="badge text-bg-success">Live Supabase</span></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Employee</th><th>ID</th><th>Department</th><th>Manager</th><th>Shift</th><th>Role</th><th>Attendance records</th><th>Access</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name || "—"}</strong><div className="small text-secondary">{employee.email || "—"}</div></td><td>{employee.employeeId || "—"}</td><td>{employee.department || "—"}</td><td>{employee.manager || "—"}</td><td>{employee.shiftStartTime || "09:00"}–{employee.shiftEndTime || "17:30"}</td><td><span className="badge text-bg-secondary">{employee.role || "employee"}</span></td><td>{recordCounts[employee.id] || 0}</td><td><span className={`badge ${employee.active ? "text-bg-success" : "text-bg-danger"}`}>{employee.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table></div>{!admin && <div className="p-3 text-secondary small">Employee administration is restricted to attendance administrators.</div>}</section>;
}

function Employees({ data, admin, mapping, setMapping, saveMapping, live = false }) { const recordCounts = data.records.reduce((counts, record) => { counts[record.userId] = (counts[record.userId] || 0) + 1; return counts; }, {}); return <><section className="panel p-0 mb-4 responsive-table"><div className="table-panel-header"><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">People available in the {live ? "live Vestano" : "CRM attendance"} directory.</p></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Name</th><th>Employee ID</th><th>Attendance records</th><th>Access</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong><div className="small text-secondary">{employee.email || ""}</div></td><td>{employee.employeeId || "—"}</td><td>{recordCounts[employee.id] || employee.recordCount || 0}</td><td><span className={`badge ${live ? "text-bg-success" : employee.id.startsWith("crm:") ? "text-bg-success" : "text-bg-secondary"}`}>{live ? "Live profile" : employee.id.startsWith("crm:") ? "CRM account" : "Imported"}</span></td></tr>)}</tbody></table></div></section>{admin && !live && data.punchCodes?.length > 0 && <section className="panel"><h2 className="h5">Link Vestano punch codes</h2><p className="text-secondary small">Connect an imported employee to a CRM account without a second login.</p><form className="row g-3 align-items-end" onSubmit={saveMapping}><div className="col-md-4"><label className="form-label" htmlFor="mappingCode">Punch code</label><select id="mappingCode" className="form-select" required value={mapping.punchCode} onChange={(event) => setMapping({ ...mapping, punchCode: event.target.value })}><option value="">Select punch code</option>{data.punchCodes.map((code) => <option key={code.punchCode} value={code.punchCode}>{code.punchCode} — {code.employeeName}</option>)}</select></div><div className="col-md-5"><label className="form-label" htmlFor="mappingUser">CRM account</label><select id="mappingUser" className="form-select" required value={mapping.userId} onChange={(event) => setMapping({ ...mapping, userId: event.target.value })}><option value="">Select CRM account</option>{data.employees.filter((employee) => employee.id.startsWith("crm:")).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div><div className="col-auto"><button className="btn btn-primary">Link employee</button></div></form></section>}</>; }

function AttendanceTable({ days, data, admin, loading, compact = false }) { const columnCount = admin ? 9 : 8; return <section className="panel p-0 mb-4 responsive-table"><div className="table-panel-header"><h2 className="h5 mb-1">{compact ? "Recent attendance" : "Employee attendance"}</h2><p className="text-secondary small mb-0">Times shown in Asia/Kolkata. Attendance is available directly in the CRM.</p></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th>{admin && <th>Employee</th>}<th>Check in</th><th>Check out</th><th>Break time</th><th>Break count</th><th>Net working hours</th><th>Employee status</th><th>Punch count</th></tr></thead><tbody>{loading ? <tr><td colSpan={columnCount} className="text-center py-5">Loading attendance…</td></tr> : days.map((day) => { const shift = data.employees.find((employee) => employee.id === day.userId) || {}; const result = calculateAttendanceDay(day.punches, new Date(), shift); return <tr key={`${day.userId}-${day.date}`}><td>{day.date}</td>{admin && <td><strong>{day.employeeName}</strong><div className="small text-secondary">{day.employeeId}</div></td>}<td>{countedAttendanceTime(day.punches[0], shift, "start")}</td><td>{result.isOpen ? <span className="badge text-bg-primary">Open</span> : countedAttendanceTime(day.punches.at(-1), shift, "end")}</td><td>{formatDuration(result.breakHours)}</td><td>{result.breakCount}</td><td className="fw-semibold">{formatDuration(result.workingHours)}</td><td><span className={`badge ${result.employeeStatusClass === "rejected" ? "text-bg-danger" : result.employeeStatusClass === "submitted" ? "text-bg-primary" : "text-bg-success"}`}>{result.employeeStatus}</span></td><td><strong>{day.punches.length}</strong><div className="small text-secondary">{day.punches.map(timeFromTimestamp).join(", ")}</div></td></tr>; })}{!loading && !days.length && <tr><td colSpan={columnCount} className="text-center py-5 text-secondary">No records for these filters. Clear the date range to view all saved attendance.</td></tr>}</tbody></table></div></section>; }




