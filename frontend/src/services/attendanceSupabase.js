import { createClient } from "@supabase/supabase-js";

export const ATTENDANCE_SUPABASE_URL = "https://lorrfeyiqgdfxdjqnpmn.supabase.co";
export const ATTENDANCE_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_Mh4xVEoQFpooPU0uRblTow_AQmf0YiG";

export const attendanceSupabase = createClient(
  ATTENDANCE_SUPABASE_URL,
  ATTENDANCE_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false } },
);

const readError = (error, fallback) => error?.message || fallback;

export async function resolveAttendanceProfile(session) {
  if (!session?.user?.id) return null;
  const { data, error } = await attendanceSupabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();
  if (error) throw new Error(readError(error, "Unable to load the attendance profile."));
  if (!data?.active) {
    await attendanceSupabase.auth.signOut();
    throw new Error("This attendance account is inactive.");
  }
  return mapProfile(data);
}

// Session changes are serialized to prevent a late request from undoing logout.
let authQueue = Promise.resolve();
export function runAttendanceAuthTask(task) {
  const result = authQueue.then(task, task);
  authQueue = result.catch(() => {});
  return result;
}

export async function getAttendanceSession() {
  const { data, error } = await attendanceSupabase.auth.getSession();
  if (error) throw new Error(readError(error, "Unable to restore the attendance session."));
  if (!data.session) return { session: null, profile: null, permission: null };
  const profile = await resolveAttendanceProfile(data.session);
  const permission = await verifyAttendanceRead(profile);
  return { session: data.session, profile, permission };
}

export async function verifyAttendanceRead(profile) {
  if (!profile?.id) return { allowed: false, message: "No authenticated attendance profile was found." };
  let query = attendanceSupabase.from("attendance_records").select("id").order("punched_at", { ascending: false }).limit(1);
  if (!isAttendanceAdmin(profile)) query = query.eq("user_id", profile.id);
  const { error } = await query;
  if (error) return { allowed: false, message: readError(error, "The attendance account cannot read attendance records.") };
  return { allowed: true, message: "Attendance records are available under the existing Supabase policies." };
}

export async function fetchLiveAttendance({ from = "", to = "", userId = "", profile }) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  let query = attendanceSupabase.from("attendance_records").select("*").order("punched_at", { ascending: false });
  if (isAttendanceAdmin(profile) && userId) query = query.eq("user_id", userId);
  if (!isAttendanceAdmin(profile)) query = query.eq("user_id", profile.id);
  if (from) query = query.gte("punched_at", `${from}T00:00:00+05:30`);
  if (to) query = query.lte("punched_at", `${to}T23:59:59+05:30`);
  const { data: records, error } = await query;
  if (error) throw new Error(readError(error, "Unable to load live attendance records."));

  let employees = [profile];
  let devices = [];
  let punchCodes = [];
  if (isAttendanceAdmin(profile)) {
    const [{ data: profiles, error: profileError }, { data: deviceRows, error: deviceError }, { data: mappings, error: mappingError }] = await Promise.all([
      attendanceSupabase.from("profiles").select("*").order("name"),
      attendanceSupabase.from("attendance_devices").select("*").order("last_seen", { ascending: false }),
      attendanceSupabase.from("attendance_mappings").select("*"),
    ]);
    if (profileError || deviceError || mappingError) throw new Error(readError(profileError || deviceError || mappingError, "Unable to load live attendance permissions and mappings."));
    employees = profiles.map(mapProfile);
    devices = deviceRows || [];
    const names = new Map(employees.map((item) => [item.id, item.name]));
    const mappingByCode = new Map((mappings || []).map((item) => [String(item.punch_code), item.user_id]));
    punchCodes = [...new Set((records || []).map((record) => String(record.punch_code)))].map((punchCode) => ({
      punchCode,
      userId: mappingByCode.get(punchCode) || "",
      employeeName: names.get(mappingByCode.get(punchCode)) || "",
    }));
  }
  const normalized = (records || []).map(mapAttendance);
  const dates = normalized.map((record) => record.timestamp.slice(0, 10)).filter(Boolean).sort();
  return {
    records: normalized,
    employees,
    punchCodes,
    devices,
    availableFrom: dates[0] || "",
    availableTo: dates.at(-1) || "",
    lastSync: new Date().toISOString(),
    source: "Live Vestano Supabase attendance",
    deviceConfig: {},
  };
}

export async function fetchLiveTimesheet({ from = "", to = "", status = "", employeeId = "", profile }) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  let query = attendanceSupabase.from("timesheet_entries").select("*").order("work_date", { ascending: false }).order("created_at", { ascending: false });
  if (status) query = query.eq("approval_status", status);
  if (from) query = query.gte("work_date", from);
  if (to) query = query.lte("work_date", to);
  if (isAttendanceAdmin(profile) && employeeId) query = query.eq("employee_id", employeeId);
  const { data, error } = await query;
  if (error) throw new Error(readError(error, "Unable to load live timesheet entries."));
  return (data || []).map(mapTimesheetEntry);
}

function entryRpcValues(entry) {
  return {
    p_work_date: entry.date,
    p_project: entry.project,
    p_details: entry.details,
    p_category: entry.category,
    p_start_time: entry.startTime,
    p_end_time: entry.endTime,
    p_break_hours: Number(entry.breakHours || 0),
    p_billable: entry.billable === true,
    p_work_status: entry.workStatus || "Completed",
    p_comments: entry.comments || "",
  };
}

export async function saveLiveTimesheetEntry(entry) {
  const rpc = entry.id ? "update_timesheet_entry" : "create_timesheet_entry";
  const params = entry.id ? { p_id: entry.id, ...entryRpcValues(entry) } : entryRpcValues(entry);
  const { data, error } = await attendanceSupabase.rpc(rpc, params);
  if (error) throw new Error(readError(error, "Unable to save the timesheet entry."));
  return data;
}

export async function deleteLiveTimesheetEntry(id) {
  const { error } = await attendanceSupabase.rpc("delete_timesheet_entry", { p_id: id });
  if (!error) return true;
  const { error: directError } = await attendanceSupabase
    .from("timesheet_entries")
    .delete()
    .eq("id", id);
  if (directError) throw new Error(readError(directError, "Unable to delete the timesheet entry."));
  return true;
}

export async function reviewLiveTimesheetEntry(id, approvalStatus, approvalComment = "") {
  const { data, error } = await attendanceSupabase.rpc("review_timesheet_entry", {
    p_id: id,
    p_approval_status: approvalStatus,
    p_approval_comment: approvalComment,
  });
  if (error) throw new Error(readError(error, "Unable to review the timesheet entry."));
  return mapTimesheetEntry(Array.isArray(data) ? data[0] : data);
}

export async function manageLiveEmployee(action, body = {}) {
  const { data, error } = await attendanceSupabase.functions.invoke("admin-users", {
    body: { action, ...body },
  });
  if (error) {
    let message = error.message || "Employee request failed.";
    const response = error.context;
    if (response && typeof response.clone === "function") {
      try { message = (await response.clone().json())?.error || message; } catch { /* preserve message */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function saveLiveAttendanceMapping(punchCode, userId) {
  const { data: matched, error } = await attendanceSupabase.rpc("map_attendance_employee", {
    p_punch_code: punchCode,
    p_user_id: userId,
  });
  if (error) throw new Error(readError(error, "Unable to link the attendance punch code."));
  return matched;
}

export async function fetchAttendanceDashboardTotals(profile) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  const { data, error } = await attendanceSupabase.rpc("get_dashboard_totals");
  if (error) throw new Error(readError(error, "Unable to load attendance dashboard totals."));
  return {
    hours: Number(data?.hours || 0),
    overtime: Number(data?.overtime || 0),
    billable: Number(data?.billable || 0),
    pending: Number(data?.pending || 0),
    employees: Number(data?.employees || 0),
  };
}

export async function updateAttendanceProfileImage(profileImage) {
  const { data, error } = await attendanceSupabase.rpc("update_profile_image", { p_profile_image: profileImage || null });
  if (error) throw new Error(readError(error, "Unable to save the profile image."));
  return Array.isArray(data) ? data[0] : data;
}

export async function requestAttendancePasswordOtp(email) {
  const { error } = await attendanceSupabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
  if (error) throw new Error(readError(error, "Unable to send the password reset email."));
}

function normalizedAttendanceRole(profile) {
  return String(profile?.role || "").trim().toLowerCase().replace(/\s+/g, "_");
}

export function isAttendanceAdmin(profile) { return ["super_admin", "admin"].includes(normalizedAttendanceRole(profile)); }
export function isAttendanceSuperAdmin(profile) { return normalizedAttendanceRole(profile) === "super_admin"; }

function mapProfile(profile) {
  const employeeRole = profile.role === "employee";
  const employeeId = String(profile.employee_id || "").trim().toUpperCase();
  const requestedShift = employeeRole
    ? employeeId === "EMP13"
      ? { start: "09:00", end: "17:00" }
      : { start: "09:30", end: "17:30" }
    : null;
  return {
    id: profile.id,
    employeeId: profile.employee_id,
    name: profile.name,
    email: profile.email,
    department: profile.department,
    manager: profile.manager,
    active: profile.active,
    role: profile.role,
    profileImage: profile.profile_image || "",
    createdAt: profile.created_at,
    shiftStartTime: requestedShift?.start || String(profile.shift_start_time || "09:00").slice(0, 5),
    shiftEndTime: requestedShift?.end || String(profile.shift_end_time || "17:30").slice(0, 5),
  };
}

function mapAttendance(record) {
  return {
    id: record.id,
    userId: record.user_id,
    employeeId: record.employee_id,
    employeeName: record.employee_name,
    punchCode: record.punch_code,
    timestamp: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(record.punched_at)).replace(", ", " "),
    serialNumber: record.serial_number,
    status: record.status,
    verifyMode: record.verify_mode,
  };
}

function mapTimesheetEntry(entry) {
  return {
    id: entry.id,
    userId: entry.user_id,
    employeeId: entry.employee_id,
    employeeName: entry.employee_name,
    date: entry.work_date,
    project: entry.project,
    details: entry.details,
    category: entry.category,
    startTime: String(entry.start_time || "").slice(0, 5),
    endTime: String(entry.end_time || "").slice(0, 5),
    breakHours: Number(entry.break_hours || 0),
    totalHours: Number(entry.total_hours || 0),
    overtime: Number(entry.overtime || 0),
    workStatus: entry.work_status,
    approvalStatus: entry.approval_status,
    approvalComment: entry.approval_comment,
    billable: entry.billable === true,
    comments: entry.comments,
  };
}
