import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import { useAttendanceAuth } from "../hooks/useAttendanceAuth.jsx";
import { useLiveAttendance } from "../hooks/useLiveAttendance.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import { useStoreContext } from "../hooks/useStoreContext.js";
import { apiClient, attendanceApi } from "../services/api.js";
import { attendanceSupabase, clearAttendanceReadCache, deleteLiveTimesheetEntry, fetchAttendanceDashboardTotals, fetchAttendanceEmployees, fetchLiveTimesheet, isAttendanceAdmin, isAttendanceSuperAdmin, manageLiveEmployee, requestAttendancePasswordOtp, reviewLiveTimesheetEntry, saveLiveAttendanceMapping, saveLiveTimesheetEntry, updateAttendanceProfileImage } from "../services/attendanceSupabase.js";
import { buildAttendanceDays, calculateAttendanceDay, countedAttendanceTime, dateInputValue, formatDuration, timeFromTimestamp } from "../utils/attendance.js";
import OvertimePanel from "../components/OvertimePanel.jsx";
import ConfirmationDialog from "../components/ConfirmationDialog.jsx";
import { activeStoreId } from "../services/storeContext.js";
import "../styles/mobile-attendance.css";

const errorText = (error) => error.response?.data?.detail || "Unable to load attendance.";
const ABSENT_EMPLOYEE_FILTER = "__absent__";
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
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, csrfToken } = useAuth();
  const { profile: attendanceProfile, permission } = useAttendanceAuth();
  const selectedStoreId = useStoreContext();
  const crmAdmin = Boolean(user?.is_admin);
  const [mode, setMode] = useState("live");
  const admin = mode === "live" ? isAttendanceAdmin(attendanceProfile) : crmAdmin;
  const superAdmin = mode === "live" ? isAttendanceSuperAdmin(attendanceProfile) : !activeStoreId() && crmAdmin;
  const employeeStoreRequired = mode === "live" && superAdmin && !activeStoreId();
  const loginRequired = mode === "live" && !attendanceProfile;
  const savedAttendanceEmployee = searchParams.get("attendance_employee") || "";
  const absentOnly = savedAttendanceEmployee === ABSENT_EMPLOYEE_FILTER;
  const requestedFrom = searchParams.get("attendance_from") || "";
  const requestedTo = searchParams.get("attendance_to") || "";
  // Attendance opens on today so the screen immediately includes every active
  // employee, including people who have not punched in yet.
  const defaultAttendanceDay = view === "attendance" && !requestedFrom && !requestedTo ? dateInputValue(new Date()) : "";
  const attendanceQuery = {
    from: requestedFrom || defaultAttendanceDay,
    to: requestedTo || defaultAttendanceDay,
    userId: absentOnly ? "" : savedAttendanceEmployee,
    absentOnly,
  };
  const [filters, setFilters] = useState(attendanceQuery);
  const [filterForm, setFilterForm] = useState({ ...attendanceQuery, userId: savedAttendanceEmployee });
  const [otherData, setData] = useState({ records: [], employees: [], punchCodes: [], devices: [], availableFrom: "", availableTo: "" });
  const [otherError, setError] = useState("");
  const [otherLoading, setLoading] = useState(true);
  const [otherRefreshing, setRefreshing] = useState(false);
  const loadedRef = useRef(false);
  const [mapping, setMapping] = useState({ punchCode: "", userId: "" });
  const [message, setMessage] = useState("");
  const [dashboardTotals, setDashboardTotals] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const needsPunches = view === "attendance" || (view === "overview" && !isAttendanceAdmin(attendanceProfile));
  const livePunches = mode === "live" && needsPunches;
  const liveFeed = useLiveAttendance({ profile: attendanceProfile, filters, enabled: livePunches && Boolean(attendanceProfile && permission?.allowed), refreshKey });
  const data = livePunches ? liveFeed.data : otherData;
  const error = otherError || (livePunches ? liveFeed.error : "");
  const loading = livePunches ? liveFeed.loading : otherLoading;
  const refreshing = livePunches ? liveFeed.refreshing : otherRefreshing;
  const now = liveFeed.now;
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [leaveRecords, setLeaveRecords] = useState([]);
  const [leaveLoading, setLeaveLoading] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const loadFallback = useCallback(async () => {
    const initialLoad = !loadedRef.current;
    if (initialLoad) setLoading(true); else setRefreshing(true);
    try { const response = await attendanceApi.list(filters); setData(response.data); setError(""); }
    catch (requestError) { setError(errorText(requestError)); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [filters]);
  const loadLive = useCallback(async () => {
    if (!attendanceProfile || !permission?.allowed) { setLoading(false); return; }
    // Employee administration is store-scoped even for a global administrator.
    // Keep the existing read/API guards and offer the Stores entry point first.
    if (view === "employees" && isAttendanceSuperAdmin(attendanceProfile) && !activeStoreId()) {
      setData({ records: [], employees: [], punchCodes: [], devices: [], availableFrom: "", availableTo: "" });
      setError(""); setLoading(false); setRefreshing(false); loadedRef.current = true;
      return;
    }
    const initialLoad = !loadedRef.current;
    if (initialLoad) setLoading(true); else setRefreshing(true);
    try {
      if (["timesheet", "employees", "overview"].includes(view) && !needsPunches) {
        const employees = await fetchAttendanceEmployees(attendanceProfile);
        setData({ records: [], employees, punchCodes: [], devices: [], availableFrom: "", availableTo: "" });
      }
      setError("");
    }
    catch (requestError) { setError(requestError.message || "Unable to load live attendance."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [attendanceProfile, filters, permission, view]);
  const load = mode === "live" ? loadLive : loadFallback;
  const loadLeaveRecords = useCallback(async () => {
    if (view !== "attendance" || !admin) { setLeaveRecords([]); setLeaveError(""); return; }
    setLeaveLoading(true);
    try {
      const response = await attendanceApi.leaves(filters);
      setLeaveRecords(response.data?.results || []);
      setLeaveError("");
    } catch (requestError) {
      setLeaveError(errorText(requestError));
    } finally {
      setLeaveLoading(false);
    }
  }, [admin, filters.from, filters.to, filters.userId, view]);
  const refresh = () => { clearAttendanceReadCache(); setError(""); setRefreshKey((value) => value + 1); void loadLeaveRecords(); if (!livePunches) void load(); };
  useEffect(() => {
    setFilters(attendanceQuery);
    setFilterForm({ ...attendanceQuery, userId: savedAttendanceEmployee });
  }, [attendanceQuery.from, attendanceQuery.to, attendanceQuery.userId, attendanceQuery.absentOnly, savedAttendanceEmployee]);
  const applyAttendanceFilters = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      [["attendance_from", filterForm.from], ["attendance_to", filterForm.to], ["attendance_employee", filterForm.userId]].forEach(([key, value]) => {
        if (value) next.set(key, value); else next.delete(key);
      });
      return next;
    });
    window.setTimeout(() => document.getElementById("attendance-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const clearAttendanceFilters = () => {
    setFilterForm({ from: "", to: "", userId: "" });
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      ["attendance_from", "attendance_to", "attendance_employee"].forEach((key) => next.delete(key));
      return next;
    });
  };
  useEffect(() => { if (!livePunches && (mode === "live" ? attendanceProfile && permission?.allowed : true)) load(); }, [load, mode, attendanceProfile, permission, livePunches]);
  useEffect(() => { void loadLeaveRecords(); }, [loadLeaveRecords, refreshKey]);
  useEffect(() => {
    const liveRefreshPage = view === "attendance" || (view === "overview" && !isAttendanceAdmin(attendanceProfile));
    if (!liveRefreshPage || mode === "live") return undefined;
    const id = window.setInterval(load, 30000);
    return () => window.clearInterval(id);
  }, [attendanceProfile, load, mode, view]);
  useEffect(() => {
    if (view !== "overview" || !attendanceProfile) return undefined;
    let active = true;
    const refresh = async () => { try { const next = await fetchAttendanceDashboardTotals(attendanceProfile); if (active) setDashboardTotals(next); } catch { /* Overview attendance remains available if totals RPC is unavailable. */ } };
    refresh();
    if (isAttendanceAdmin(attendanceProfile)) return () => { active = false; };
    const id = window.setInterval(refresh, 15000); return () => { active = false; window.clearInterval(id); };
  }, [attendanceProfile, refreshKey, view]);
  useEffect(() => {
    if (mode !== "live" || !attendanceProfile?.id || !permission?.allowed) return undefined;
    const adminProfile = isAttendanceAdmin(attendanceProfile);
    const profileFilter = adminProfile && selectedStoreId ? "store_id=eq." + selectedStoreId : "id=eq." + attendanceProfile.id;
    let active = true;
    let refreshTimer;
    const refreshChangedData = () => {
      if (!active) return;
      clearAttendanceReadCache();
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { if (active) setRefreshKey((current) => current + 1); }, 150);
    };
    const channel = attendanceSupabase.channel("attendance-page:" + attendanceProfile.id + ":" + view + ":" + Date.now(), {
      config: { postgres_changes_options: { wait: true } },
    }).on("postgres_changes", { event: "*", schema: "public", table: "profiles", filter: profileFilter }, refreshChangedData)
      .on("postgres_changes", { event: "*", schema: "public", table: "timesheet_entries", ...(!adminProfile ? { filter: "user_id=eq." + attendanceProfile.id } : {}) }, refreshChangedData)
      .subscribe();
    return () => {
      active = false;
      window.clearTimeout(refreshTimer);
      void attendanceSupabase.removeChannel(channel).catch(() => {});
    };
  }, [attendanceProfile?.id, attendanceProfile?.role, mode, permission?.allowed, selectedStoreId, view]);
  const days = useMemo(() => buildAttendanceDays(data.records), [data.records]);
  const totals = useMemo(() => days.reduce((summary, day) => {
    const employee = data.employees.find((item) => item.id === day.userId) || {};
    const result = calculateAttendanceDay(day.punches, now, employee);
    return { hours: summary.hours + (result.workingHours || 0), breaks: summary.breaks + (result.breakHours || 0), open: summary.open + (result.isOpen ? 1 : 0) };
  }, { hours: 0, breaks: 0, open: 0 }), [days, data.employees, now]);
  const attendanceDays = useMemo(() => {
    // A complete date range lets us build a row for each active employee even
    // when the biometric device did not send any punches for that person.
    if (!admin || !filters.from || !filters.to || filters.from > filters.to) return days;
    const employees = data.employees.filter((employee) => employee.active !== false
      && !["admin", "super_admin"].includes(employee.role)
      && (!filters.userId || employee.id === filters.userId));
    const byEmployeeAndDate = new Map(days.map((day) => [`${day.userId}|${day.date}`, day]));
    const today = dateInputValue(now);
    const rows = [];
    const end = new Date(filters.to + "T00:00:00Z");
    for (let date = new Date(filters.from + "T00:00:00Z"), count = 0; date <= end && count < 366; date = new Date(date.getTime() + 86_400_000), count += 1) {
      const workDate = date.toISOString().slice(0, 10);
      for (const employee of employees) {
        const existing = byEmployeeAndDate.get(`${employee.id}|${workDate}`);
        if (existing) rows.push(existing);
        else rows.push({ date: workDate, userId: employee.id, employeeName: employee.name || employee.employeeId || "Employee", employeeId: employee.employeeId || "", punches: [], noPunchState: workDate < today ? "leave" : workDate === today ? "pending" : "scheduled" });
      }
    }
    const sorted = rows.sort((first, second) => second.date.localeCompare(first.date) || String(first.employeeName).localeCompare(String(second.employeeName)));
    return filters.absentOnly ? sorted.filter((day) => day.noPunchState === "leave" || day.noPunchState === "pending") : sorted;
  }, [admin, data.employees, days, filters.from, filters.to, filters.userId, filters.absentOnly, now]);
  const saveMapping = async (event) => {
    event.preventDefault();
    try { const response = await apiClient.post("/attendance/mappings/", mapping, { headers: { "X-CSRFToken": csrfToken } }); setMessage(`${response.data.matched} punches linked to ${response.data.employee.name}.`); await load(); }
    catch (requestError) { setError(errorText(requestError)); }
  };
  const exportExcel = async () => {
    if (exporting || loading || data.historyLoading || leaveLoading) return;
    setExporting(true);
    setExportError("");
    try {
      const XLSX = await import("xlsx");
      const selectedEmployees = data.employees.filter((employee) => employee.active && employee.role === "employee" && (!filters.userId || employee.id === filters.userId));
      const dayByEmployeeDate = new Map(days.map((day) => [day.userId + "|" + day.date, day]));
      const leaveByEmployeeDate = new Map(leaveRecords.map((leave) => [leave.userId + "|" + leave.date, leave]));
      const dates = new Set([...days.map((day) => day.date), ...leaveRecords.map((leave) => leave.date)]);
      if (filters.from && filters.to) {
        for (let date = new Date(filters.from + "T00:00:00Z"), end = new Date(filters.to + "T00:00:00Z"); date <= end; date = new Date(date.getTime() + 86_400_000)) {
          dates.add(date.toISOString().slice(0, 10));
        }
      }
      const rows = [...dates].sort().flatMap((date) => selectedEmployees.map((employee) => {
        const day = dayByEmployeeDate.get(employee.id + "|" + date);
        const leave = leaveByEmployeeDate.get(employee.id + "|" + date);
        if (!day) {
          const today = dateInputValue(new Date());
          if (filters.absentOnly && date > today) return null;
          const status = date < today ? "Leave" : date === today ? "Absent" : "Scheduled";
          return [date, employee.name || "—", employee.employeeId || "—", status, "—", "—", "—", "—", "—", "—", leave?.reason || ""];
        }
        if (filters.absentOnly) return null;
        const result = calculateAttendanceDay(day.punches, new Date(), employee);
        const status = result.employeeStatus === "Short hours" ? "Present – Short hours" : "Present";
        return [date, day.employeeName, day.employeeId || employee.employeeId || "—", status, countedAttendanceTime(day.punches[0], employee, "start"), result.isOpen ? "Open" : countedAttendanceTime(day.punches.at(-1), employee, "end"), formatDuration(result.breakHours), result.breakCount, formatDuration(result.workingHours), day.punches.length, ""];
      })).filter(Boolean);
      const worksheet = XLSX.utils.aoa_to_sheet([["Date", "Employee", "Employee ID", "Attendance status", "Check in", "Check out", "Break time", "Break count", "Net working hours", "Punch count", "Leave reason"], ...rows]);
      worksheet["!cols"] = [{ wch: 14 }, { wch: 24 }, { wch: 16 }, { wch: 24 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 30 }];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Attendance");
      XLSX.writeFile(workbook, `attendance-${dateInputValue(new Date())}.xlsx`);
    } catch {
      setExportError("Unable to download the attendance report. Please refresh the page and try again.");
    } finally {
      setExporting(false);
    }
  };
  const [title, description] = viewCopy[view] || viewCopy.attendance;
  const switchToFallback = () => { setMode("fallback"); setError(""); loadFallback(); };
  const switchToLive = () => { setMode("live"); setError(""); };
  const saveLiveMapping = async (event) => { event.preventDefault(); try { const matched = await saveLiveAttendanceMapping(mapping.punchCode, mapping.userId); setMessage(`${matched || 0} punches linked successfully.`); setMapping({ punchCode: "", userId: "" }); refresh(); } catch (requestError) { setError(requestError.message || "Unable to link the attendance punch code."); } };
  if (loginRequired) return <AttendanceAccessCard />;
  return <div className={`attendance-workspace attendance-view-${view}`}>
    <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4"><div><div className="eyebrow">{view === "attendance" ? "ESSL PUNCH RECORDS" : "VestaTrack"}</div><h1 className="h2 mb-2">{title}</h1><p className="text-secondary mb-0">{description}</p></div><div className="d-flex align-items-center gap-2">{mode !== "live" || !attendanceProfile ? <span className="badge text-bg-secondary">Attendance unavailable</span> : null}{refreshing && <span className="text-secondary small">Refreshing…</span>}{!loginRequired && <button className="btn btn-outline-secondary" onClick={refresh} disabled={loading}><i className="bi bi-arrow-clockwise me-1" />{refreshing ? "Refreshing" : "Refresh"}</button>}</div></div>
    {error && <div className="alert alert-danger">{error}</div>}{message && <div className="alert alert-success">{message}</div>}
    {exportError && <div className="alert alert-danger" role="alert">{exportError}</div>}
    {livePunches && !loading && <p className="text-secondary small" role="status">Punches update automatically.{data.historyLoading ? " Loading earlier attendance…" : ""}</p>}
    {!loginRequired && mode === "live" && attendanceProfile && permission && !permission.allowed && <section className="panel mb-4 border-danger"><h2 className="h5">Live attendance permission unavailable</h2><p className="text-secondary mb-3">{permission.message}</p></section>}
    {!loginRequired && mode === "fallback" && <div className="alert alert-warning d-flex flex-wrap justify-content-between align-items-center gap-2"><span><strong>Imported CRM backup:</strong> this data is from the ZIP snapshot, not live VestaTrack records.</span><button className="btn btn-sm btn-outline-dark" type="button" onClick={switchToLive}>Return to live attendance</button></div>}
    {!loginRequired && view === "overview" && <Overview days={days} data={data} totals={totals} dashboardTotals={dashboardTotals} loading={loading} admin={admin} profile={attendanceProfile} now={now} />}
    {!loginRequired && view === "timesheet" && <TimesheetView profile={attendanceProfile} employees={data.employees} refreshKey={refreshKey} />}
    {!loginRequired && view === "profile" && <ProfileView profile={attendanceProfile} />}
    {!loginRequired && view === "employees" && (mode === "live" ? (superAdmin ? (employeeStoreRequired ? <section className="panel"><h2 className="h5">Open a store to manage employees</h2><p className="text-secondary">Choose a store to view and manage only its attendance employees.</p><Link className="btn btn-primary" to="/admin-panel/stores">Open Stores</Link></section> : <AdminLiveEmployees data={data} onRefresh={load} />) : <LiveEmployees data={data} admin={admin} />) : <Employees data={data} admin={admin} mapping={mapping} setMapping={setMapping} saveMapping={saveMapping} />)}
    {!loginRequired && view === "approvals" && <LiveApprovals profile={attendanceProfile} employees={data.employees} refreshKey={refreshKey} />}
    {!loginRequired && view === "overtime" && <OvertimePanel admin={crmAdmin || superAdmin} />}
    {!loginRequired && view === "attendance" && <><div className="metric-grid attendance-metrics mb-4"><Metric icon="bi-calendar-check" label="Attendance rows" value={attendanceDays.length} /><Metric icon="bi-clock-history" label="Punches" value={data.records.length} /><Metric icon="bi-hourglass-split" label="Net hours" value={formatDuration(totals.hours)} /><Metric icon="bi-calendar-range" label="Saved range" value={<><SavedRangeDate value={data.availableFrom || "—"} /><span className="saved-range-separator">to</span><SavedRangeDate value={data.availableTo || "—"} /></>} /></div>{superAdmin && <section className="panel mb-4"><div className="table-panel-header"><div className="eyebrow">ADMIN DEVICE SETUP</div><h2 className="h5 mb-1">eSSL network push settings</h2><p className="text-secondary small mb-3">The machine user code must match the employee Employee ID.</p></div><div className="row g-3 small"><div className="col-md-3"><span className="text-secondary d-block">Protocol</span><strong>ADMS / iClock push</strong></div><div className="col-md-3"><span className="text-secondary d-block">Connected devices</span><strong>{data.devices?.length || 0}</strong></div><div className="col-md-3"><span className="text-secondary d-block">Last sync</span><strong>{data.lastSync ? data.lastSync.slice(0, 19).replace("T", " ") : "Waiting for device"}</strong></div><div className="col-md-3"><span className="text-secondary d-block">Saved records</span><strong>{data.records.length}</strong></div></div></section>}{superAdmin && <section className="panel mb-4"><div className="table-panel-header"><div className="eyebrow">EMPLOYEE ATTENDANCE LINK</div><h2 className="h5 mb-1">Link machine code to employee</h2><p className="text-secondary small mb-3">Only the Super Admin can map biometric punch codes.</p></div>{!data.punchCodes?.length && <div className="alert alert-info mb-3">No unlinked punch codes are currently available. New device punches will appear here.</div>}<form className="row g-3 align-items-end" onSubmit={saveLiveMapping}><div className="col-md-4"><label className="form-label" htmlFor="liveMappingCode">Machine punch code</label><select id="liveMappingCode" className="form-select" required disabled={!data.punchCodes?.length} value={mapping.punchCode} onChange={(event) => setMapping({ ...mapping, punchCode: event.target.value })}><option value="">Select punch code</option>{data.punchCodes.map((code) => <option key={code.punchCode} value={code.punchCode}>{code.punchCode} — {code.employeeName || "Not linked"}</option>)}</select></div><div className="col-md-5"><label className="form-label" htmlFor="liveMappingEmployee">Employee name</label><select id="liveMappingEmployee" className="form-select" required disabled={!data.punchCodes?.length} value={mapping.userId} onChange={(event) => setMapping({ ...mapping, userId: event.target.value })}><option value="">Select employee</option>{data.employees.filter((employee) => employee.role === "employee").map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div><div className="col-auto"><button className="btn btn-primary" type="submit" disabled={!data.punchCodes?.length}>Link employee</button></div></form></section>}<section className="panel mb-4"><div className="row g-3 align-items-end">{admin && <div className="col-md-4"><label className="form-label" htmlFor="attendanceEmployee">Filter by employee</label><select id="attendanceEmployee" className="form-select" value={filterForm.userId} onChange={(event) => setFilterForm({ ...filterForm, userId: event.target.value })}><option value="">All active employees</option><option value={ABSENT_EMPLOYEE_FILTER}>Absent employees</option>{data.employees.filter((employee) => employee.active !== false && !["admin", "super_admin"].includes(employee.role)).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div>}<div className="col-md-3"><label className="form-label" htmlFor="attendanceFrom">From</label><input id="attendanceFrom" className="form-control" type="date" value={filterForm.from} onChange={(event) => setFilterForm({ ...filterForm, from: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceTo">To</label><input id="attendanceTo" className="form-control" type="date" value={filterForm.to} onChange={(event) => setFilterForm({ ...filterForm, to: event.target.value })} /></div><div className="col-auto"><button className="btn btn-primary" type="button" onClick={applyAttendanceFilters}>Apply filters</button></div><div className="col-auto"><button className="btn btn-outline-secondary" type="button" onClick={clearAttendanceFilters}>Today</button></div></div></section><section className="panel mb-4 d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ATTENDANCE EXPORT</div><h2 className="h5 mb-1">Download attendance report</h2><p className="text-secondary small mb-0">Export the records selected by your filters.</p></div><button className="btn btn-primary" type="button" onClick={exportExcel} disabled={exporting || loading || data.historyLoading}><i className="bi bi-file-earmark-excel me-1" />{data.historyLoading ? "Loading history…" : exporting ? "Preparing…" : "Download XLSX"}</button></section><div id="attendance-results" tabIndex="-1"><AttendanceTable key={[filters.from, filters.to, filters.userId, filters.absentOnly, attendanceProfile?.id, attendanceProfile?.role].join("|")} days={attendanceDays} data={data} admin={admin} loading={loading} now={now} /></div></>}
  </div>;
}

function AttendanceAccessCard() {
  const { restore, isLoading, error } = useAttendanceAuth();
  return <>
    <div className="page-header mb-4"><div className="eyebrow">STAFF ACCESS</div><h1 className="h2 mb-2">Attendance</h1><p className="text-secondary mb-0">Your attendance workspace.</p></div>
    <section className="panel mx-auto text-center py-5" style={{ maxWidth: 520 }} aria-labelledby="attendance-access-heading">
      <span className="metric-icon mx-auto mb-3" aria-hidden="true"><i className="bi bi-shield-lock" /></span>
      <div className="eyebrow mb-2">{isLoading ? "CONNECTING" : "ACCESS UNAVAILABLE"}</div>
      <h2 id="attendance-access-heading" className="h4">{isLoading ? "Opening Attendance…" : "Unable to open Attendance"}</h2>
      <p className="text-secondary mb-4">Attendance opens automatically using your signed-in CRM employee ID.</p>
      {isLoading ? <p role="status">Loading your attendance workspace…</p> : <>
        <div className="alert alert-danger" role="alert">{error || "No active Attendance account matches your CRM employee ID. Ask your administrator to check the account mapping."}</div>
        <button className="btn btn-outline-primary me-2" type="button" onClick={restore}>Retry</button>
      </>}
      <Link className="btn btn-primary" to="/dashboard">Back to dashboard</Link>
    </section>
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
  return <section className="panel"><div className="eyebrow">PERSONAL ACCOUNT</div><h2 className="h4 mb-1">My Profile</h2><p className="text-secondary mb-4">Manage your profile image and reset your password securely by email OTP.</p><form onSubmit={save}><div className="row g-4"><div className="col-md-4 text-center"><div className="summary-card mb-3">{image ? <img src={image} alt="Profile" style={{ width: 128, height: 128, objectFit: "cover", borderRadius: "50%" }} /> : <div className="display-4">{initials}</div>}<h3 className="h5 mt-3">{profile?.name || "Attendance user"}</h3><p className="text-secondary mb-3">{profile?.employeeId || "—"}</p><label className="form-label" htmlFor="attendance-profile-image">Profile image</label><input id="attendance-profile-image" className="form-control" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => readImage(event.target.files?.[0])} /><button className="btn btn-outline-secondary btn-sm mt-2" type="button" disabled={busy || !image} onClick={removeImage}>Remove image</button></div></div><div className="col-md-8"><div className="row g-3"><div className="col-md-6"><div className="text-secondary small">Employee ID</div><strong>{profile?.employeeId || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Role</div><strong>{profile?.role === "super_admin" ? "Super Admin" : profile?.role === "admin" ? "Admin" : "Employee"}</strong></div><div className="col-md-6"><div className="text-secondary small">Email</div><strong>{profile?.email || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Department</div><strong>{profile?.department || "—"}</strong></div><div className="col-md-6"><div className="text-secondary small">Manager</div><strong>{profile?.manager || "—"}</strong></div></div><div className="d-flex flex-wrap gap-2 mt-4"><button className="btn btn-primary" disabled={busy || !hasImageChange}>{busy ? "Saving…" : "Save profile image"}</button>{canResetPassword && <button className="btn btn-outline-secondary" type="button" disabled={busy} onClick={resetPassword}>Reset password by email OTP</button>}</div></div></div></form>{message && <div className="alert alert-success mt-4 mb-0">{message}</div>}{error && <div className="alert alert-danger mt-4 mb-0">{error}</div>}</section>;
}

function TimesheetView({ profile, employees, refreshKey }) {
  const admin = isAttendanceAdmin(profile);
  const [searchParams, setSearchParams] = useSearchParams();
  const timesheetQuery = {
    from: searchParams.get("timesheet_from") || "",
    to: searchParams.get("timesheet_to") || "",
    status: searchParams.get("timesheet_status") || "",
    employeeId: searchParams.get("timesheet_employee") || "",
  };
  const [filters, setFilters] = useState(timesheetQuery);
  const [filterForm, setFilterForm] = useState(timesheetQuery);
  const [entries, setEntries] = useState([]);
  const [draft, setDraft] = useState(null);
  const [additionalDrafts, setAdditionalDrafts] = useState([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [deletingEntry, setDeletingEntry] = useState(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const loadedRef = useRef(false);
  const entryDialogRef = useRef(null);
  const filterDialogRef = useRef(null);
  const closeEntryDialog = () => { setDraft(null); setAdditionalDrafts([]); };
  useDialogFocus({ open: Boolean(draft), dialogRef: entryDialogRef, onCancel: closeEntryDialog, busy: saving });
  useDialogFocus({ open: filtersOpen, dialogRef: filterDialogRef, onCancel: () => setFiltersOpen(false) });
  useEffect(() => {
    setFilters(timesheetQuery);
    setFilterForm(timesheetQuery);
  }, [timesheetQuery.from, timesheetQuery.to, timesheetQuery.status, timesheetQuery.employeeId]);
  const applyTimesheetFilters = () => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      [["timesheet_from", filterForm.from], ["timesheet_to", filterForm.to], ["timesheet_status", filterForm.status], ["timesheet_employee", filterForm.employeeId]].forEach(([key, value]) => {
        if (value) next.set(key, value); else next.delete(key);
      });
      return next;
    });
    setFiltersOpen(false);
    window.setTimeout(() => document.getElementById("timesheet-results")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };
  const clearTimesheetFilters = () => {
    setFilterForm({ from: "", to: "", status: "", employeeId: "" });
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      ["timesheet_from", "timesheet_to", "timesheet_status", "timesheet_employee"].forEach((key) => next.delete(key));
      return next;
    });
    setFiltersOpen(false);
  };
  const load = useCallback(async () => {
    if (!profile) return;
    const initial = !loadedRef.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try { setEntries(await fetchLiveTimesheet({ ...filters, profile })); setError(""); }
    catch (requestError) { setError(requestError.message || "Unable to load live timesheet entries."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [filters, profile]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const newEntryDraft = (date = dateInputValue(new Date())) => ({ date, category: "Project Work", project: "", details: "", startTime: profile?.shiftStartTime || "09:00", endTime: profile?.shiftEndTime || "17:30", breakHours: 0.5, workStatus: "Completed", billable: false, comments: "" });
  const openEntry = (entry = null) => { setAdditionalDrafts([]); setDraft(entry ? { ...entry } : newEntryDraft()); };
  const saveEntry = async (event) => {
    event.preventDefault();
    const draftsToSave = [draft, ...additionalDrafts];
    const timeError = draftsToSave.map(validateTimesheetEntryTime).find(Boolean);
    if (timeError) { setError(timeError); return; }
    let remainingDrafts = draftsToSave;
    setSaving(true);
    try {
      for (let index = 0; index < draftsToSave.length; index += 1) {
        await saveLiveTimesheetEntry(draftsToSave[index]);
        remainingDrafts = draftsToSave.slice(index + 1);
      }
      closeEntryDialog();
      await load();
    } catch (saveError) {
      setDraft(remainingDrafts[0] || draft);
      setAdditionalDrafts(remainingDrafts.slice(1));
      setError(saveError.message);
    }
    finally { setSaving(false); }
  };
  const removeEntry = (id) => setDeletingEntry(entries.find((candidate) => candidate.id === id) || null);
  const confirmRemoveEntry = async () => {
    if (!deletingEntry || deleteSaving) return;
    setDeleteSaving(true);
    setError("");
    try { await deleteLiveTimesheetEntry(deletingEntry.id); setDeletingEntry(null); await load(); }
    catch (deleteError) { setError(deleteError.message); }
    finally { setDeleteSaving(false); }
  };
  const exportTimesheet = async () => {
    if (exporting || !entries.length) return;
    setExporting(true);
    setExportError("");
    try {
      const XLSX = await import("xlsx");
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
    } catch {
      setExportError("Unable to download the timesheet report. Please refresh the page and try again.");
    } finally {
      setExporting(false);
    }
  };
  const timesheetGroups = useMemo(() => {
    const groups = new Map();
    entries.forEach((entry) => {
      const employeeKey = entry.employeeId || entry.employeeName || entry.userId || "current-user";
      const key = `${entry.date}|${employeeKey}`;
      const group = groups.get(key) || { key, date: entry.date, employeeName: entry.employeeName, employeeId: entry.employeeId, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    });
    return [...groups.values()];
  }, [entries]);
  const canDelete = !admin || profile?.role === "super_admin";
  return <><section className="panel p-0 responsive-table">
    <div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">DAILY WORK LOG</div><h2 className="h5 mb-1">My Timesheet</h2><p className="text-secondary small mb-0">Add work details, track hours, and follow approval status.</p></div><div className="d-flex flex-wrap align-items-center gap-2">{refreshing && <span className="text-secondary small">Refreshing…</span>}{admin && <button className="btn btn-outline-primary btn-sm" type="button" onClick={exportTimesheet} disabled={!entries.length || exporting}><i className="bi bi-file-earmark-excel me-1" />{exporting ? "Preparing…" : "Download XLSX"}</button>}</div></div>
    <div className="timesheet-new-entry"><button className="btn btn-primary" type="button" onClick={() => openEntry()}>+ New entry</button><button className="btn btn-primary timesheet-filter-toggle" type="button" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog"><i className="bi bi-funnel me-1" aria-hidden="true" />Filters</button></div>
    {exportError && <div className="alert alert-danger mx-3" role="alert">{exportError}</div>}
    {error && <div className="alert alert-danger m-3">{error}</div>}
    {draft && <><div className="modal d-block timesheet-entry-modal" ref={entryDialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="timesheet-entry-title">
      <div className="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg"><div className="modal-content"><form onSubmit={saveEntry}>
        <div className="modal-header"><h2 className="modal-title fs-5" id="timesheet-entry-title">{draft.id ? "Edit work entry" : "New work entry"}</h2><button className="btn-close" type="button" aria-label="Close" onClick={closeEntryDialog} disabled={saving} /></div>
        <div className="modal-body"><TimesheetDraftFields entry={draft} onChange={(next) => setDraft(next)} index={0} />{additionalDrafts.map((entry, index) => <TimesheetDraftFields key={index} entry={entry} onChange={(next) => setAdditionalDrafts((current) => current.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate))} index={index + 1} onRemove={() => setAdditionalDrafts((current) => current.filter((_, candidateIndex) => candidateIndex !== index))} />)}</div>
        <div className="modal-footer"><button className="btn btn-outline-secondary" type="button" onClick={closeEntryDialog} disabled={saving}>Cancel</button>{!draft.id && <button className="btn btn-outline-primary" type="button" onClick={() => setAdditionalDrafts((current) => [...current, newEntryDraft(draft.date)])} disabled={saving}>+ Add another entry</button>}<button className="btn btn-primary" type="submit" disabled={saving}>{saving ? "Saving…" : additionalDrafts.length ? `Submit ${additionalDrafts.length + 1} entries` : "Submit entry"}</button></div>
      </form></div></div>
    </div><div className="modal-backdrop show timesheet-entry-backdrop" /></>}
    {filtersOpen && <div className="modal-backdrop show timesheet-filter-backdrop" />}
    <TimesheetFilters
      admin={admin}
      employees={employees}
      filterForm={filterForm}
      setFilterForm={setFilterForm}
      onApply={applyTimesheetFilters}
      onClear={clearTimesheetFilters}
      open={filtersOpen}
      onClose={() => setFiltersOpen(false)}
      dialogRef={filterDialogRef}
    />
    <div className="table-responsive" id="timesheet-results" tabIndex="-1"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th>{admin && <th>Employee</th>}<th>Project & work details</th><th>Time</th><th>Hours</th><th>Work status</th><th>Approval</th><th>Actions</th></tr></thead><tbody>{loading ? <tr><td colSpan={admin ? 8 : 7} className="text-center py-5">Loading timesheet…</td></tr> : <GroupedTimesheetRows groups={timesheetGroups} showEmployee={admin}>{(entry) => <><td><strong>{entry.project || "—"}</strong><div className="small text-secondary">{entry.details || entry.category || "—"}</div>{entry.comments && <div className="small text-secondary">{entry.comments}</div>}</td><td>{entry.startTime || "—"} – {entry.endTime || "—"}</td><td className="fw-semibold">{Number(entry.totalHours || 0).toFixed(2)}h{entry.overtime ? <div className="small text-secondary">{Number(entry.overtime).toFixed(2)} OT</div> : null}</td><td>{entry.workStatus || "—"}</td><td><span className={`badge ${entry.approvalStatus === "Approved" ? "text-bg-success" : entry.approvalStatus === "Rejected" ? "text-bg-danger" : "text-bg-primary"}`}>{entry.approvalStatus || "Submitted"}</span>{entry.approvalComment && <div className="small text-secondary">{entry.approvalComment}</div>}</td><td>{!admin && entry.approvalStatus !== "Approved" && <button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openEntry(entry)}>Edit</button>}{canDelete && <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => removeEntry(entry.id)}>Delete</button>}</td></>}</GroupedTimesheetRows>}{!loading && !entries.length && <tr><td colSpan={admin ? 8 : 7} className="text-center py-5 text-secondary">No entries match this view.</td></tr>}</tbody></table></div>
  </section>
  <ConfirmationDialog
    open={Boolean(deletingEntry)}
    title="Delete timesheet entry?"
    description={deletingEntry?.approvalStatus === "Approved" ? "This approved entry and its audit history will be removed." : "This work entry will be permanently removed from your timesheet."}
    details={deletingEntry && <><strong>{deletingEntry.date} · {deletingEntry.project || "Work entry"}</strong><div className="small text-secondary mt-1">{Number(deletingEntry.totalHours || 0).toFixed(2)} hours · {deletingEntry.approvalStatus || "Submitted"}</div></>}
    actionLabel="Delete entry"
    tone="danger"
    onConfirm={confirmRemoveEntry}
    onCancel={() => { if (!deleteSaving) setDeletingEntry(null); }}
    busy={deleteSaving}
    error={error}
  />
  </>;
}

function TimesheetDraftFields({ entry, onChange, index, onRemove }) {
  const suffix = index ? `-${index + 1}` : "";
  const label = (value) => index ? `${value} ${index + 1}` : value;
  const update = (key, value) => onChange({ ...entry, [key]: value });
  return <fieldset className={index ? "border-top mt-4 pt-4" : "border-0 p-0 m-0"}>
    {index > 0 && <><legend className="visually-hidden">Work entry {index + 1}</legend><div className="d-flex align-items-center justify-content-between mb-3"><strong>Work entry {index + 1}</strong><button className="btn btn-sm btn-outline-danger" type="button" onClick={onRemove}>Remove entry</button></div></>}
    <div className="row g-3">
      <div className="col-md-3"><label className="form-label" htmlFor={`entryDate${suffix}`}>{label("Date")}</label><input id={`entryDate${suffix}`} className="form-control" type="date" required value={entry.date} onChange={(event) => update("date", event.target.value)} /></div>
      <div className="col-md-3"><label className="form-label" htmlFor={`entryProject${suffix}`}>{label("Project")}</label><input id={`entryProject${suffix}`} className="form-control" required value={entry.project} onChange={(event) => update("project", event.target.value)} /></div>
      <div className="col-md-6"><label className="form-label" htmlFor={`entryDetails${suffix}`}>{label("Work details")}</label><input id={`entryDetails${suffix}`} className="form-control" required value={entry.details} onChange={(event) => update("details", event.target.value)} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor={`entryCategory${suffix}`}>{label("Category *")}</label><select id={`entryCategory${suffix}`} className="form-select" required value={entry.category} onChange={(event) => update("category", event.target.value)}><option>Project Work</option><option>Meeting</option><option>Administration</option><option>Training</option><option>Client Support</option><option>Research</option><option>Leave</option></select></div>
      <div className="col-md-2"><label className="form-label" htmlFor={`entryStart${suffix}`}>{label("Start")}</label><input id={`entryStart${suffix}`} className="form-control" type="time" required value={entry.startTime} onChange={(event) => update("startTime", event.target.value)} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor={`entryEnd${suffix}`}>{label("End")}</label><input id={`entryEnd${suffix}`} className="form-control" type="time" required value={entry.endTime} onChange={(event) => update("endTime", event.target.value)} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor={`entryBreak${suffix}`}>{label("Break hours")}</label><input id={`entryBreak${suffix}`} className="form-control" type="number" min="0" max="8" step="0.25" value={entry.breakHours} onChange={(event) => update("breakHours", event.target.value)} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor={`entryStatus${suffix}`}>{label("Work status")}</label><select id={`entryStatus${suffix}`} className="form-select" value={entry.workStatus} onChange={(event) => update("workStatus", event.target.value)}><option>Completed</option><option>In progress</option><option>Blocked</option></select></div>
      <div className="col-md-2 form-check mt-4 ms-2"><input id={`timesheetBillable${suffix}`} className="form-check-input" type="checkbox" checked={Boolean(entry.billable)} onChange={(event) => update("billable", event.target.checked)} /><label className="form-check-label" htmlFor={`timesheetBillable${suffix}`}>{label("Billable")}</label></div>
      <div className="col-md-6"><label className="form-label" htmlFor={`entryComments${suffix}`}>{label("Comments")}</label><input id={`entryComments${suffix}`} className="form-control" value={entry.comments || ""} onChange={(event) => update("comments", event.target.value)} /></div>
    </div>
  </fieldset>;
}

function TimesheetFilters({ admin, employees, filterForm, setFilterForm, onApply, onClear, open, onClose, dialogRef }) {
  return <div className={`timesheet-filters p-3 border-bottom${open ? " is-open" : ""}`} ref={dialogRef} role={open ? "dialog" : undefined} aria-modal={open || undefined} aria-labelledby={open ? "timesheet-filter-title" : undefined}>
    <div className="timesheet-filter-dialog-header"><h2 className="h5 mb-0" id="timesheet-filter-title">Filter timesheets</h2><button className="btn-close" type="button" aria-label="Close filters" onClick={onClose} /></div>
    <div className="row g-2 align-items-end">
      <div className="col-6 col-sm-4 col-md-3"><label className="form-label" htmlFor="timesheetFrom">From</label><input id="timesheetFrom" className="form-control" type="date" value={filterForm.from} onChange={(event) => setFilterForm({ ...filterForm, from: event.target.value })} /></div>
      <div className="col-6 col-sm-4 col-md-3"><label className="form-label" htmlFor="timesheetTo">To</label><input id="timesheetTo" className="form-control" type="date" value={filterForm.to} onChange={(event) => setFilterForm({ ...filterForm, to: event.target.value })} /></div>
      <div className="col-6 col-sm-4 col-md-3"><label className="form-label" htmlFor="timesheetStatus">Approval</label><select id="timesheetStatus" className="form-select" value={filterForm.status} onChange={(event) => setFilterForm({ ...filterForm, status: event.target.value })}><option value="">All statuses</option><option value="Submitted">Submitted</option><option value="Approved">Approved</option><option value="Rejected">Rejected</option></select></div>
      {admin && <div className="col-6 col-sm-4 col-md-3"><label className="form-label" htmlFor="timesheetEmployee">Employee</label><select id="timesheetEmployee" className="form-select" value={filterForm.employeeId} onChange={(event) => setFilterForm({ ...filterForm, employeeId: event.target.value })}><option value="">All employees</option>{employees.map((employee) => <option key={employee.id} value={employee.employeeId}>{employee.name} ({employee.employeeId})</option>)}</select></div>}
      <div className="col-6 col-sm-auto"><button className="btn btn-primary w-100" type="button" onClick={onApply}>Apply</button></div>
      <div className="col-6 col-sm-auto"><button className="btn btn-outline-secondary w-100" type="button" onClick={onClear}>Clear</button></div>
    </div>
  </div>;
}

function TimesheetEntryStack({ entries, children }) {
  return <div>{entries.map((entry, index) => <div className={index ? "border-top mt-2 pt-2" : ""} key={entry.id}>{children(entry)}</div>)}</div>;
}

function GroupedTimesheetRows({ groups, showEmployee, children }) {
  return groups.flatMap((group) => group.entries.map((entry, index) => <tr key={entry.id}>{index === 0 && <><td rowSpan={group.entries.length}>{group.date}</td>{showEmployee && <td rowSpan={group.entries.length}><strong>{group.employeeName || "—"}</strong><div className="small text-secondary">{group.employeeId || "—"}</div></td>}</>}{children(entry)}</tr>));
}

function validateTimesheetEntryTime(entry) {
  const toMinutes = (value) => {
    const [hours, minutes] = String(value || "").split(":").map(Number);
    return Number.isInteger(hours) && Number.isInteger(minutes) ? hours * 60 + minutes : NaN;
  };
  const start = toMinutes(entry.startTime), end = toMinutes(entry.endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "Enter a valid start and end time for every work entry.";
  if (end <= start) return "End time must be later than start time for every work entry.";
  if (Number(entry.breakHours || 0) >= (end - start) / 60) return "Break hours must be shorter than the work period for every work entry.";
  return "";
}

function SavedRangeDate({ value }) {
  const parts = String(value || "—").split("-");
  if (parts.length !== 3) return <span className="saved-range-date">{value}</span>;
  return <span className="saved-range-date"><span>{parts[0]}-</span><span>{parts[1]}</span><span>-{parts[2]}</span></span>;
}

function Metric({ icon, label, value }) { return <div className="summary-card"><span className="metric-icon"><i className={`bi ${icon}`} /></span><div className="text-secondary small">{label}</div><div className="summary-value">{value}</div></div>; }

function LeaveRecords({ employees, leaves, loading, loadError, csrfToken, onChanged }) {
  const [draft, setDraft] = useState(() => ({ userId: "", from: dateInputValue(new Date()), to: dateInputValue(new Date()), reason: "", leaveType: "paid" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const eligibleEmployees = employees.filter((employee) => employee.active && employee.role === "employee");
  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await attendanceApi.createLeave(draft, csrfToken);
      setDraft((current) => ({ ...current, reason: "" }));
      await onChanged();
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (leaveId) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await attendanceApi.removeLeave(leaveId, csrfToken);
      await onChanged();
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setBusy(false);
    }
  };
  return <section className="panel mb-4">
    <div className="table-panel-header"><div className="eyebrow">LEAVE REGISTER</div><h2 className="h5 mb-1">Employees on leave</h2><p className="text-secondary small mb-0">Leave days are included in the attendance download as “On leave”, so they are not marked absent.</p></div>
    {(loadError || error) && <div className="alert alert-danger m-3 mb-0">{error || loadError}</div>}
    <form className="row g-3 p-3 border-bottom align-items-end" onSubmit={save}>
      <div className="col-md-4"><label className="form-label" htmlFor="leave-employee">Employee</label><select id="leave-employee" className="form-select" required value={draft.userId} onChange={(event) => setDraft({ ...draft, userId: event.target.value })}><option value="">Select employee</option>{eligibleEmployees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div>
      <div className="col-md-2"><label className="form-label" htmlFor="leave-from">From</label><input id="leave-from" className="form-control" type="date" required value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor="leave-to">To</label><input id="leave-to" className="form-control" type="date" required value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></div>
      <div className="col-md-2"><label className="form-label" htmlFor="leave-type">Leave type</label><select id="leave-type" className="form-select" value={draft.leaveType} onChange={(event) => setDraft({ ...draft, leaveType: event.target.value })}><option value="paid">Paid</option><option value="unpaid">Unpaid (LOP)</option></select></div>
      <div className="col-md-2"><label className="form-label" htmlFor="leave-reason">Reason</label><input id="leave-reason" className="form-control" maxLength="500" value={draft.reason} onChange={(event) => setDraft({ ...draft, reason: event.target.value })} /></div>
      <div className="col-md-1 d-grid"><button className="btn btn-primary" disabled={busy || !eligibleEmployees.length}>{busy ? "Saving…" : "Add"}</button></div>
    </form>
    <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th><th>Employee</th><th>Type</th><th>Reason</th><th>Action</th></tr></thead><tbody>{loading ? <tr><td colSpan="5" className="text-center py-4">Loading leave records…</td></tr> : leaves.map((leave) => <tr key={leave.id}><td>{leave.date}</td><td><strong>{leave.employeeName}</strong><div className="small text-secondary">{leave.employeeId}</div></td><td><span className={`badge ${leave.leaveType === "unpaid" ? "text-bg-warning" : "text-bg-success"}`}>{leave.leaveType === "unpaid" ? "Unpaid / LOP" : "Paid"}</span></td><td>{leave.reason || "—"}</td><td><button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => remove(leave.id)}>Remove</button></td></tr>)}{!loading && !leaves.length && <tr><td colSpan="5" className="text-center py-4 text-secondary">No leave records for the selected filters.</td></tr>}</tbody></table></div>
  </section>;
}

function AbsentEmployees({ employees, days, leaves, filters, onSelectDate }) {
  const [selectedDate, setSelectedDate] = useState(() => filters.from && filters.from === filters.to ? filters.from : dateInputValue(new Date()));
  useEffect(() => {
    if (filters.from && filters.from === filters.to) setSelectedDate(filters.from);
  }, [filters.from, filters.to]);
  const absent = useMemo(() => {
    if (!filters.from || !filters.to || filters.from > filters.to) return null;
    const dates = [];
    for (let date = new Date(filters.from + "T00:00:00Z"), end = new Date(filters.to + "T00:00:00Z"); date <= end; date = new Date(date.getTime() + 86_400_000)) {
      dates.push(date.toISOString().slice(0, 10));
      if (dates.length > 366) return [];
    }
    const present = new Set(days.map((day) => day.userId + "|" + day.date));
    const onLeave = new Set(leaves.map((leave) => leave.userId + "|" + leave.date));
    const selectedEmployees = employees.filter((employee) => employee.active && employee.role === "employee" && (!filters.userId || employee.id === filters.userId));
    return dates.flatMap((date) => selectedEmployees
      .filter((employee) => !present.has(employee.id + "|" + date) && !onLeave.has(employee.id + "|" + date))
      .map((employee) => ({ ...employee, date })));
  }, [days, employees, filters.from, filters.to, filters.userId, leaves]);

  return <section className="panel mb-4">
    <div className="table-panel-header"><div className="eyebrow">ATTENDANCE EXCEPTIONS</div><h2 className="h5 mb-1">Absent employees</h2><p className="text-secondary small mb-0">Employees with no punch record for the selected dates. Recorded leave days are excluded.</p></div>
    <form className="p-3 border-bottom d-flex flex-wrap align-items-end gap-2" onSubmit={(event) => { event.preventDefault(); onSelectDate(selectedDate); }}>
      <div><label className="form-label mb-1" htmlFor="absent-date">Check absences for a day</label><input id="absent-date" className="form-control" type="date" required value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} /></div>
      <button className="btn btn-outline-danger" type="submit"><i className="bi bi-person-x me-1" />Show absent employees</button>
    </form>
    {absent === null ? <p className="p-3 mb-0 text-secondary">Choose a date above to view the absent employees.</p> : absent.length ? <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th><th>Employee</th><th>Employee ID</th><th>Status</th></tr></thead><tbody>{absent.map((employee) => <tr key={employee.id + "-" + employee.date}><td>{employee.date}</td><td><strong>{employee.name || "—"}</strong></td><td>{employee.employeeId || "—"}</td><td><span className="badge text-bg-danger">Absent</span></td></tr>)}</tbody></table></div> : <p className="p-3 mb-0 text-success">No absences for the selected dates.</p>}
  </section>;
}

function Overview({ days, data, totals, dashboardTotals, loading, admin, profile, now }) {
  const today = dateInputValue(now);
  const todayRecord = days.find((day) => day.date === today);
  const employeeView = !admin;
  const employee = profile || {};
  const todayTotals = todayRecord ? calculateAttendanceDay(todayRecord.punches, now, employee) : null;
  const greeting = new Date().getHours() < 12 ? "Good morning" : new Date().getHours() < 17 ? "Good afternoon" : "Good evening";
  const dateLabel = new Intl.DateTimeFormat("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date());
  const metrics = employeeView
    ? [["Hours this month", dashboardTotals ? dashboardTotals.hours.toFixed(1) : "—", "bi-hourglass-split"], ["Pending approval", dashboardTotals?.pending ?? "—", "bi-hourglass"], ["Billable hours", dashboardTotals ? dashboardTotals.billable.toFixed(1) : "—", "bi-cash-stack"], ["Overtime", dashboardTotals ? dashboardTotals.overtime.toFixed(1) : "—", "bi-clock-history"]]
    : [["Team hours", dashboardTotals ? dashboardTotals.hours.toFixed(1) : "—", "bi-hourglass-split"], ["Pending approvals", dashboardTotals?.pending ?? "—", "bi-hourglass"], ["Billable hours", dashboardTotals ? dashboardTotals.billable.toFixed(1) : "—", "bi-cash-stack"], ["Active employees", dashboardTotals?.employees ?? data.employees.length, "bi-people"]];
  return <>
    <section className="panel p-4 mb-4 d-flex flex-wrap justify-content-between align-items-center gap-4"><div><div className="eyebrow">YOUR WORKSPACE</div><h1 className="h2 mb-2">{greeting}{employee.name ? `, ${employee.name.split(" ")[0]}` : ""}</h1><p className="text-secondary mb-0">Here is a clear view of attendance and what needs attention.</p></div><div className="summary-card today-summary-card text-center"><div className="text-secondary small">Today</div><strong className="h5 mb-0">{dateLabel}</strong></div></section>
    <div className="metric-grid mb-4">{metrics.map(([label, value, icon]) => <Metric key={label} icon={icon} label={label} value={value} />)}</div>
    <section className="panel p-4 mb-4"><div className="eyebrow">THIS WEEK</div><h2 className="h4 mb-2">Keep your record current</h2><p className="text-secondary mb-3">Daily attendance records make approvals faster and give your team an accurate picture.</p><Link className="btn btn-outline-primary" to="/attendance/timesheet">Open my timesheet</Link></section>
    {employeeView && <><section className="panel p-0 mb-4"><div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-2"><div><div className="eyebrow">MY ATTENDANCE</div><h2 className="h5 mb-0">Today’s attendance</h2></div><span className={`badge ${todayTotals ? "text-bg-primary" : "text-bg-secondary"}`}>{todayTotals ? todayTotals.employeeStatus : "No punch today"}</span></div>{todayRecord && <div className="p-3 row g-3"><div className="col-md-2"><div className="text-secondary small">Check in</div><strong>{countedAttendanceTime(todayRecord.punches[0], employee, "start")}</strong></div><div className="col-md-2"><div className="text-secondary small">Check out</div><strong>{todayTotals?.isOpen ? "—" : countedAttendanceTime(todayRecord.punches.at(-1), employee, "end")}</strong></div><div className="col-md-2"><div className="text-secondary small">Break time</div><strong>{formatDuration(todayTotals?.breakHours)}</strong></div><div className="col-md-2"><div className="text-secondary small">Break count</div><strong>{todayTotals?.breakCount || 0}</strong></div><div className="col-md-2"><div className="text-secondary small">Net working</div><strong>{formatDuration(todayTotals?.workingHours)}</strong></div></div>}</section><AttendanceTable days={days.slice(0, 7)} data={data} admin={false} loading={loading} compact now={now} /></>}
  </>;
}

function LiveApprovals({ profile, employees, refreshKey }) {
  const admin = isAttendanceAdmin(profile);
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(null);
  const [comment, setComment] = useState("");
  const [reviewSaving, setReviewSaving] = useState(false);
  const loadedRef = useRef(false);
  const load = useCallback(async () => {
    if (!profile || !admin) { setLoading(false); return; }
    const initial = !loadedRef.current;
    if (initial) setLoading(true); else setRefreshing(true);
    try { setEntries(await fetchLiveTimesheet({ status: "Submitted", profile })); setError(""); }
    catch (requestError) { setError(requestError.message || "Unable to load pending approvals."); }
    finally { loadedRef.current = true; setLoading(false); setRefreshing(false); }
  }, [admin, profile]);
  useEffect(() => { load(); }, [load, refreshKey]);
  const approvalGroups = useMemo(() => {
    const groups = new Map();
    entries.forEach((entry) => {
      const employeeKey = entry.employeeId || entry.employeeName || entry.userId || "current-user";
      const key = `${entry.date}|${employeeKey}`;
      const group = groups.get(key) || { key, date: entry.date, employeeName: entry.employeeName, employeeId: entry.employeeId, entries: [] };
      group.entries.push(entry);
      groups.set(key, group);
    });
    return [...groups.values()];
  }, [entries]);
  const review = async () => {
    if (!reviewing) return;
    setReviewSaving(true);
    setError("");
    try { await reviewLiveTimesheetEntry(reviewing.entry.id, reviewing.action, comment.trim()); setReviewing(null); setComment(""); await load(); }
    catch (requestError) { setError(requestError.message || "Unable to review the timesheet entry."); }
    finally { setReviewSaving(false); }
  };
  const closeReview = () => { if (!reviewSaving) { setReviewing(null); setComment(""); } };
  if (!admin) return <section className="panel"><h2 className="h5">Admin workspace</h2><p className="text-secondary mb-0">Timesheet approvals are available to attendance administrators.</p></section>;
  return <section className="timesheet-approvals-panel responsive-table">
    <div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ADMIN WORKSPACE</div><h2 className="h5 mb-1">Timesheet Approvals</h2><p className="text-secondary small mb-0">Review submitted work from the live attendance system.</p></div>{refreshing && <span className="text-secondary small">Refreshing…</span>}</div>
    {error && <div className="alert alert-danger m-3">{error}</div>}
    <div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Date</th><th>Employee</th><th>Project & work details</th><th>Time</th><th>Hours</th><th>Work status</th><th>Action</th></tr></thead><tbody>{loading ? <tr><td colSpan="7" className="text-center py-5">Loading approvals…</td></tr> : <GroupedTimesheetRows groups={approvalGroups} showEmployee>{(entry) => <><td><strong>{entry.project || "—"}</strong><div className="small text-secondary">{entry.details || entry.category || "—"}</div></td><td>{entry.startTime || "—"} – {entry.endTime || "—"}</td><td className="fw-semibold">{Number(entry.totalHours || 0).toFixed(2)}h</td><td>{entry.workStatus || "—"}</td><td><div className="d-flex gap-1"><button className="btn btn-sm btn-success" type="button" disabled={reviewSaving} onClick={() => { setComment(""); setError(""); setReviewing({ entry, action: "Approved" }); }}>Approve</button><button className="btn btn-sm btn-outline-danger" type="button" disabled={reviewSaving} onClick={() => { setComment(""); setError(""); setReviewing({ entry, action: "Rejected" }); }}>Reject</button></div></td></>}</GroupedTimesheetRows>}{!loading && !entries.length && <tr><td colSpan="7" className="text-center py-5 text-secondary">No submitted timesheets require approval.</td></tr>}</tbody></table></div>
    <ConfirmationDialog
      open={Boolean(reviewing)}
      title={reviewing?.action === "Rejected" ? "Reject timesheet entry?" : "Approve timesheet entry?"}
      description={reviewing?.action === "Rejected" ? "The employee will receive your feedback and can correct the submitted entry." : "The entry will be marked approved and reflected in the employee's timesheet."}
      details={reviewing && <><strong>{reviewing.entry.employeeName || reviewing.entry.employeeId} · {reviewing.entry.date}</strong><div className="small text-secondary mt-1">{reviewing.entry.project || "—"}: {reviewing.entry.details || "—"} · {Number(reviewing.entry.totalHours || 0).toFixed(2)} hours</div></>}
      actionLabel={reviewing?.action === "Rejected" ? "Confirm rejection" : "Confirm approval"}
      tone={reviewing?.action === "Rejected" ? "danger" : "primary"}
      showNote
      reason={comment}
      reasonLabel="Review note (optional)"
      reasonPlaceholder="Add context for the employee, if helpful."
      onReasonChange={(value) => { setComment(value); setError(""); }}
      onConfirm={review}
      onCancel={closeReview}
      busy={reviewSaving}
      error={error}
    />
  </section>;
}



function AdminLiveEmployees({ data, onRefresh }) {
  const [draft, setDraft] = useState(null);
  const [deletingEmployee, setDeletingEmployee] = useState(null);
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
  const remove = (employee) => { if (!busy) { setError(""); setDeletingEmployee(employee); } };
  const confirmRemove = async () => {
    if (!deletingEmployee || busy) return;
    setBusy(true); setError("");
    try { await manageLiveEmployee("delete", { userId: deletingEmployee.id }); setDeletingEmployee(null); await onRefresh(); }
    catch (requestError) { setError(requestError.message || "Unable to delete employee."); }
    finally { setBusy(false); }
  };
  return <>
    <section className="panel p-0 responsive-table"><div className="table-panel-header d-flex flex-wrap justify-content-between align-items-center gap-3"><div><div className="eyebrow">ADMINISTRATION</div><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">Create accounts and manage access for the company.</p></div><button className="btn btn-primary" type="button" onClick={openNew}>+ Add employee</button></div>{error && <div className="alert alert-danger m-3">{error}</div>}{draft && <form className="p-3 border-bottom row g-3" onSubmit={submit}><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-employeeId">Employee ID</label><input id="attendanceEmployee-employeeId" className="form-control" required value={draft.employeeId} onChange={(event) => setDraft({ ...draft, employeeId: event.target.value.toUpperCase() })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-name">Name</label><input id="attendanceEmployee-name" className="form-control" required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-email">Username / login email</label><input id="attendanceEmployee-email" className="form-control" type="email" required value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-department">Department</label><input id="attendanceEmployee-department" className="form-control" value={draft.department} onChange={(event) => setDraft({ ...draft, department: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-manager">Manager</label><input id="attendanceEmployee-manager" className="form-control" value={draft.manager} onChange={(event) => setDraft({ ...draft, manager: event.target.value })} /></div><div className="col-md-2"><label className="form-label" htmlFor="attendanceEmployee-role">Role</label><select id="attendanceEmployee-role" className="form-select" value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}><option value="employee">Employee</option><option value="admin">Admin</option></select></div><div className="col-md-2"><label className="form-label" htmlFor="attendanceEmployee-shiftStartTime">Start</label><input id="attendanceEmployee-shiftStartTime" className="form-control" type="time" value={draft.shiftStartTime} onChange={(event) => setDraft({ ...draft, shiftStartTime: event.target.value })} /></div><div className="col-md-2"><label className="form-label" htmlFor="attendanceEmployee-shiftEndTime">End</label><input id="attendanceEmployee-shiftEndTime" className="form-control" type="time" value={draft.shiftEndTime} onChange={(event) => setDraft({ ...draft, shiftEndTime: event.target.value })} /></div><div className="col-md-3"><label className="form-label" htmlFor="attendanceEmployee-password">{draft.mode === "create" ? "Temporary password" : "New password"}</label><div className="input-group"><input id="attendanceEmployee-password" className="form-control" type={showPassword ? "text" : "password"} minLength="6" required={draft.mode === "create"} placeholder={draft.mode === "edit" ? "Leave blank to keep current" : ""} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><button className="btn btn-outline-secondary" type="button" aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword((visible) => !visible)}><i className={`bi bi-eye${showPassword ? "-slash" : ""}`} aria-hidden="true"></i></button></div></div><div className="col-12 d-flex gap-2"><button className="btn btn-primary" disabled={busy}>{busy ? "Saving…" : draft.mode === "create" ? "Create employee" : "Save changes"}</button><button className="btn btn-outline-secondary" type="button" onClick={() => setDraft(null)}>Cancel</button></div></form>}<div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Employee</th><th>ID</th><th>Department</th><th>Manager</th><th>Shift</th><th>Role</th><th>Access</th><th>Actions</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name || "—"}</strong><div className="small text-secondary">{employee.email || "—"}</div></td><td>{employee.employeeId || "—"}</td><td>{employee.department || "—"}</td><td>{employee.manager || "—"}</td><td>{employee.shiftStartTime || "09:00"}–{employee.shiftEndTime || "17:30"}</td><td><span className="badge text-bg-secondary">{employee.role === "super_admin" ? "Super Admin" : employee.role === "admin" ? "Admin" : "Employee"}</span></td><td><button className={`btn btn-sm ${employee.active ? "btn-outline-danger" : "btn-outline-success"}`} disabled={busy || ["super_admin", "admin"].includes(employee.role)} type="button" onClick={() => toggle(employee)}>{employee.active ? "Deactivate" : "Activate"}</button></td><td><button className="btn btn-sm btn-outline-secondary me-1" type="button" onClick={() => openEdit(employee)}>Edit</button>{!employee.active && !["super_admin", "admin"].includes(employee.role) && <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => remove(employee)}>Delete</button>}</td></tr>)}</tbody></table></div></section>
    <ConfirmationDialog
      open={Boolean(deletingEmployee)}
      title="Delete employee account?"
      description="This removes the inactive employee account from the live attendance directory."
      details={deletingEmployee && <><strong>{deletingEmployee.name || "Employee"}</strong><div className="small text-secondary mt-1">{deletingEmployee.employeeId || "No employee ID"} · {deletingEmployee.email || "No email"}</div></>}
      actionLabel="Delete employee"
      tone="danger"
      onConfirm={confirmRemove}
      onCancel={() => { if (!busy) setDeletingEmployee(null); }}
      busy={busy}
      error={error}
    />
  </>;
}

function LiveEmployees({ data, admin }) {
  const recordCounts = data.records.reduce((counts, record) => { counts[record.userId] = (counts[record.userId] || 0) + 1; return counts; }, {});
  return <section className="panel p-0 responsive-table"><div className="table-panel-header"><div><div className="eyebrow">ADMINISTRATION</div><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">Profiles from the VestaTrack attendance directory.</p></div></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Employee</th><th>ID</th><th>Department</th><th>Manager</th><th>Shift</th><th>Role</th><th>Attendance records</th><th>Access</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name || "—"}</strong><div className="small text-secondary">{employee.email || "—"}</div></td><td>{employee.employeeId || "—"}</td><td>{employee.department || "—"}</td><td>{employee.manager || "—"}</td><td>{employee.shiftStartTime || "09:00"}–{employee.shiftEndTime || "17:30"}</td><td><span className="badge text-bg-secondary">{employee.role || "employee"}</span></td><td>{recordCounts[employee.id] || 0}</td><td><span className={`badge ${employee.active ? "text-bg-success" : "text-bg-danger"}`}>{employee.active ? "Active" : "Inactive"}</span></td></tr>)}</tbody></table></div>{!admin && <div className="p-3 text-secondary small">Employee administration is restricted to attendance administrators.</div>}</section>;
}

function Employees({ data, admin, mapping, setMapping, saveMapping, live = false }) { const recordCounts = data.records.reduce((counts, record) => { counts[record.userId] = (counts[record.userId] || 0) + 1; return counts; }, {}); return <><section className="panel p-0 mb-4 responsive-table"><div className="table-panel-header"><h2 className="h5 mb-1">Employees</h2><p className="text-secondary small mb-0">People available in the {live ? "live VestaTrack" : "CRM attendance"} directory.</p></div><div className="table-responsive"><table className="table table-hover align-middle mb-0"><thead className="table-light"><tr><th>Name</th><th>Employee ID</th><th>Attendance records</th><th>Access</th></tr></thead><tbody>{data.employees.map((employee) => <tr key={employee.id}><td><strong>{employee.name}</strong><div className="small text-secondary">{employee.email || ""}</div></td><td>{employee.employeeId || "—"}</td><td>{recordCounts[employee.id] || employee.recordCount || 0}</td><td><span className={`badge ${live ? "text-bg-success" : employee.id.startsWith("crm:") ? "text-bg-success" : "text-bg-secondary"}`}>{live ? "Live profile" : employee.id.startsWith("crm:") ? "CRM account" : "Imported"}</span></td></tr>)}</tbody></table></div></section>{admin && !live && data.punchCodes?.length > 0 && <section className="panel"><h2 className="h5">Link VestaTrack punch codes</h2><p className="text-secondary small">Connect an imported employee to a CRM account without a second login.</p><form className="row g-3 align-items-end" onSubmit={saveMapping}><div className="col-md-4"><label className="form-label" htmlFor="mappingCode">Punch code</label><select id="mappingCode" className="form-select" required value={mapping.punchCode} onChange={(event) => setMapping({ ...mapping, punchCode: event.target.value })}><option value="">Select punch code</option>{data.punchCodes.map((code) => <option key={code.punchCode} value={code.punchCode}>{code.punchCode} — {code.employeeName}</option>)}</select></div><div className="col-md-5"><label className="form-label" htmlFor="mappingUser">CRM account</label><select id="mappingUser" className="form-select" required value={mapping.userId} onChange={(event) => setMapping({ ...mapping, userId: event.target.value })}><option value="">Select CRM account</option>{data.employees.filter((employee) => employee.id.startsWith("crm:")).map((employee) => <option key={employee.id} value={employee.id}>{employee.name} ({employee.employeeId})</option>)}</select></div><div className="col-auto"><button className="btn btn-primary">Link employee</button></div></form></section>}</>; }

function AttendanceTable({ days, data, admin, loading, compact = false, now = new Date() }) {
  const columnCount = admin ? 9 : 8;
  const [visibleCount, setVisibleCount] = useState(50);
  const employees = useMemo(() => new Map(data.employees.map(employee => [employee.id, employee])), [data.employees]);
  const visibleDays = compact ? days : days.slice(0, visibleCount);
  return <section className="panel p-0 mb-4 responsive-table">
    <div className="table-panel-header"><h2 className="h5 mb-1">{compact ? "Recent attendance" : "Employee attendance"}</h2><p className="text-secondary small mb-0">Times shown in Asia/Kolkata. Attendance updates automatically.</p></div>
    <div className="table-responsive"><table className="table table-hover align-middle mb-0">
      <thead className="table-light"><tr><th>Date</th>{admin && <th>Employee</th>}<th>Check in</th><th>Check out</th><th>Break time</th><th>Break count</th><th>Net working hours</th><th>Employee status</th><th>Punch count</th></tr></thead>
      <tbody>{loading ? <tr><td colSpan={columnCount} className="text-center py-5">Loading attendance…</td></tr> : visibleDays.map(day => {
        if (day.noPunchState) {
          const status = day.noPunchState === "leave" ? "Leave" : day.noPunchState === "pending" ? "Absent" : "Scheduled";
          const tone = day.noPunchState === "leave" ? "text-bg-secondary" : day.noPunchState === "pending" ? "text-bg-warning" : "text-bg-light";
          return <tr key={`${day.userId}-${day.date}`}><td>{day.date}</td>{admin && <td><strong>{day.employeeName}</strong><div className="small text-secondary">{day.employeeId}</div></td>}<td>—</td><td>—</td><td>—</td><td>—</td><td className="fw-semibold">—</td><td><span className={`badge ${tone}`}>{status}</span></td><td><strong>0</strong></td></tr>;
        }
        const shift = employees.get(day.userId) || {};
        const result = calculateAttendanceDay(day.punches, now, shift);
        return <tr key={`${day.userId}-${day.date}`}><td>{day.date}</td>{admin && <td><strong>{day.employeeName}</strong><div className="small text-secondary">{day.employeeId}</div></td>}<td>{countedAttendanceTime(day.punches[0], shift, "start")}</td><td>{result.isOpen ? <span className="badge text-bg-primary">Open</span> : countedAttendanceTime(day.punches.at(-1), shift, "end")}</td><td>{formatDuration(result.breakHours)}</td><td>{result.breakCount}</td><td className="fw-semibold">{formatDuration(result.workingHours)}</td><td><span className={`badge ${result.employeeStatusClass === "rejected" ? "text-bg-danger" : result.employeeStatusClass === "submitted" ? "text-bg-primary" : "text-bg-success"}`}>{result.employeeStatus}</span></td><td><strong>{day.punches.length}</strong><div className="small text-secondary">{day.punches.map(timeFromTimestamp).join(", ")}</div></td></tr>;
      })}{!loading && !days.length && <tr><td colSpan={columnCount} className="text-center py-5 text-secondary">{data.historyLoading ? "Loading earlier attendance…" : "No records for these filters. Clear the date range to view all saved attendance."}</td></tr>}</tbody>
    </table></div>
    {!compact && days.length > 0 && <div className="p-3 d-flex flex-wrap align-items-center justify-content-between gap-2"><span className="text-secondary small">Showing {visibleDays.length} of {days.length} daily records</span>{visibleCount < days.length && <button type="button" className="btn btn-outline-secondary" onClick={() => setVisibleCount(count => count + 50)}>Show more records</button>}</div>}
  </section>;
}




