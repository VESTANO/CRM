import { createReadCache } from "./readCache.js";
import { crmSupabase, CRM_SUPABASE_URL, CRM_SUPABASE_PUBLISHABLE_KEY } from "./crmSupabase.js";
import { readCrmProfile } from "./crmProfile.js";
import { createAttendanceFeed } from "./attendanceFeed.js";
import { activeStoreId } from "./storeContext.js";

export const ATTENDANCE_SUPABASE_URL = CRM_SUPABASE_URL;
export const ATTENDANCE_SUPABASE_PUBLISHABLE_KEY = CRM_SUPABASE_PUBLISHABLE_KEY;

// Attendance and CRM share the same identity, token refresh, and logout.
export const attendanceSupabase = crmSupabase;

const readError = (error, fallback) => error?.message || fallback;
const attendanceReads = createReadCache();
const attendanceSnapshots = new Map();
let attendanceGeneration = 0;
let channelSequence = 0;
export function clearAttendanceReadCache() { attendanceReads.clear(); attendanceSnapshots.clear(); attendanceGeneration += 1; }
const attendanceReadKey = (type, profile, filters = {}) => JSON.stringify([
  type, profile?.id, profile?.role, profile?.employeeId, profile?.storeId,
  isAttendanceSuperAdmin(profile) ? activeStoreId() : "",
  filters.from || "", filters.to || "", filters.userId || "", filters.employeeId || "", filters.status || "",
]);
attendanceSupabase.auth.onAuthStateChange((event) => {
  if (["SIGNED_OUT", "SIGNED_IN", "USER_UPDATED"].includes(event)) clearAttendanceReadCache();
});

export function fetchAttendanceEmployees(profile) {
  if (!profile?.id) return Promise.reject(new Error("Sign in to the attendance system first."));
  if (!isAttendanceAdmin(profile)) return Promise.resolve([profile]);
  const storeId = isAttendanceSuperAdmin(profile) ? activeStoreId() : profile.storeId;
  if (!storeId) return Promise.reject(new Error("Open a store before viewing or managing its employees."));
  return attendanceReads.read(attendanceReadKey("employees", profile), async () => {
    const { data, error } = await attendanceSupabase.from("profiles").select("id,employee_id,name,email,department,manager,active,role,created_at,shift_start_time,shift_end_time,store_id").eq("store_id", storeId).order("name");
    if (error) throw new Error(readError(error, "Unable to load attendance employees."));
    return (data || []).map(mapProfile);
  }, 60_000);
}

export async function resolveAttendanceProfile(session) {
  if (!session?.user?.id) return null;
  const data = await readCrmProfile(session.user.id);
  if (!data?.active) {
    throw new Error("This attendance account is inactive.");
  }
  return mapProfile(data);
}

export async function getAttendanceSession() {
  const { data, error } = await attendanceSupabase.auth.getSession();
  if (error) throw new Error(readError(error, "Unable to restore the attendance session."));
  if (!data.session) return { session: null, profile: null, permission: null };
  const profile = await resolveAttendanceProfile(data.session);
  // Actual attendance reads remain subject to RLS. Repeating an extra record
  // query here delayed every page without adding an authorization boundary.
  const permission = { allowed: true, message: "Attendance is available for the active CRM account." };
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

const attendanceColumns = "id,user_id,employee_id,employee_name,punch_code,punched_at,serial_number,status,verify_mode,created_at,updated_at";
const noMember = "00000000-0000-0000-0000-000000000000";
const nextDate = value => new Date(Date.parse(`${value}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

function attendanceSource({ from = "", to = "", userId = "", profile }) {
  const admin = isAttendanceAdmin(profile);
  const scopedUser = admin ? userId : profile.id;
  const storeId = activeStoreId();
  let memberIds = new Set(admin ? [] : [profile.id]);
  const ensureMembers = async () => {
    if (storeId !== activeStoreId()) throw new Error("The selected store has changed. Reopen Attendance.");
    const employees = await fetchAttendanceEmployees(profile);
    memberIds = new Set(employees.map(employee => employee.id));
    return employees;
  };
  const scope = (query, dates = true) => {
    query = query.in("user_id", memberIds.size ? [...memberIds] : [noMember]);
    if (scopedUser) query = query.eq("user_id", scopedUser);
    if (dates && from) query = query.gte("punched_at", `${from}T00:00:00+05:30`);
    if (dates && to) query = query.lt("punched_at", `${nextDate(to)}T00:00:00+05:30`);
    return query;
  };
  const read = async query => {
    const { data, error } = await query;
    if (error) throw new Error(readError(error, "Unable to load attendance."));
    return data || [];
  };
  return {
    accepts: row => memberIds.has(row.user_id) && (!scopedUser || row.user_id === scopedUser)
      && (!from || Date.parse(row.punched_at) >= Date.parse(`${from}T00:00:00+05:30`))
      && (!to || Date.parse(row.punched_at) < Date.parse(`${nextDate(to)}T00:00:00+05:30`)),
    async version(signal) {
      await ensureMembers();
      const rows = await read(scope(attendanceSupabase.from("attendance_records").select("updated_at"), false)
        .order("updated_at", { ascending: false }).limit(1).abortSignal(signal));
      return rows[0]?.updated_at;
    },
    async page({ cursor, limit, signal }) {
      await ensureMembers();
      let query = scope(attendanceSupabase.from("attendance_records").select(attendanceColumns))
        .order("punched_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
      if (cursor) query = query.or(`punched_at.lt.${cursor.punched_at},and(punched_at.eq.${cursor.punched_at},id.lt.${cursor.id})`);
      return read(query.abortSignal(signal));
    },
    async changes({ since, cursor, limit, signal }) {
      await ensureMembers();
      // Date filtering happens in the store, so corrections moved outside the
      // selected date range remove their old visible copy as well.
      let query = scope(attendanceSupabase.from("attendance_records").select(attendanceColumns), false)
        .gte("updated_at", since).order("updated_at").order("id").limit(limit);
      if (cursor) query = query.or(`updated_at.gt.${cursor.updated_at},and(updated_at.eq.${cursor.updated_at},id.gt.${cursor.id})`);
      return read(query.abortSignal(signal));
    },
    async ids({ cursor, limit, signal }) {
      await ensureMembers();
      let query = scope(attendanceSupabase.from("attendance_records").select("id")).order("id").limit(limit);
      if (cursor) query = query.gt("id", cursor);
      return read(query.abortSignal(signal));
    },
    metadata(signal, force = false) {
      if (force) attendanceReads.clear();
      return attendanceReads.read(attendanceReadKey("attendance-metadata", profile), async () => {
        const employees = await ensureMembers();
        const mappings = admin && employees.length
          ? await read(attendanceSupabase.from("attendance_mappings").select("punch_code,user_id").in("user_id", [...memberIds])) : [];
        return { employees, devices: [], mappings };
      }, 60_000);
    },
    subscribe({ onRecord, onMetadata, onConnected }) {
      const channel = attendanceSupabase.channel(`attendance:${profile.id}:${++channelSequence}`, { config: { postgres_changes_options: { wait: true } } })
        .on("postgres_changes", { event: "*", schema: "public", table: "attendance_records", ...(scopedUser ? { filter: `user_id=eq.${scopedUser}` } : {}) }, onRecord);
      for (const table of ["profiles", ...(admin ? ["attendance_mappings"] : [])]) {
        channel.on("postgres_changes", { event: "*", schema: "public", table, ...(!admin ? { filter: `id=eq.${profile.id}` } : {}) }, event => onMetadata({ ...event, table }));
      }
      channel.subscribe(status => { if (status === "SUBSCRIBED") onConnected(); });
      return () => { void attendanceSupabase.removeChannel(channel); };
    },
  };
}

export function watchLiveAttendance({ profile, onSnapshot, onError, isVisible, ...filters }) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  const key = attendanceReadKey("feed", profile, filters);
  const saved = attendanceSnapshots.get(key);
  const cached = saved && Date.now() - saved.savedAt < 60_000 ? saved : undefined;
  const generation = attendanceGeneration;
  const source = attendanceSource({ profile, ...filters });
  const feed = createAttendanceFeed({ source, mapRecord: mapAttendance, accepts: source.accepts, onSnapshot, onError, isVisible, cached });
  return {
    ready: feed.ready, wake: feed.wake,
    stop() {
      const snapshot = feed.stop();
      if (snapshot.metadata && snapshot.complete && attendanceGeneration === generation) {
        attendanceSnapshots.set(key, { ...snapshot, savedAt: Date.now() });
        while (attendanceSnapshots.size > 8) attendanceSnapshots.delete(attendanceSnapshots.keys().next().value);
      }
    },
  };
}

export async function fetchLiveAttendance(filters) {
  let feed;
  try {
    feed = watchLiveAttendance({ ...filters, onSnapshot: () => {}, onError: () => {} });
    const data = await feed.ready;
    if (!data) throw new Error("Unable to load attendance.");
    return data;
  } finally { feed?.stop(); }
}

export function fetchLiveTimesheet(filters) {
  if (!filters.profile?.id) return Promise.reject(new Error("Sign in to the attendance system first."));
  return attendanceReads.read(attendanceReadKey("timesheets", filters.profile, filters), () => loadLiveTimesheet(filters));
}

async function loadLiveTimesheet({ from = "", to = "", status = "", employeeId = "", profile }) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  const employees = await fetchAttendanceEmployees(profile);
  let query = attendanceSupabase.from("timesheet_entries").select("*").in("user_id", employees.length ? employees.map(employee => employee.id) : [noMember]).order("work_date", { ascending: false }).order("created_at", { ascending: false });
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
  attendanceReads.clear();
  return data;
}

export async function deleteLiveTimesheetEntry(id) {
  const { error } = await attendanceSupabase.rpc("delete_timesheet_entry", { p_id: id });
  if (!error) { attendanceReads.clear(); return true; }
  const { error: directError } = await attendanceSupabase
    .from("timesheet_entries")
    .delete()
    .eq("id", id);
  if (directError) throw new Error(readError(directError, "Unable to delete the timesheet entry."));
  attendanceReads.clear();
  return true;
}

export async function reviewLiveTimesheetEntry(id, approvalStatus, approvalComment = "") {
  const { data, error } = await attendanceSupabase.rpc("review_timesheet_entry", {
    p_id: id,
    p_approval_status: approvalStatus,
    p_approval_comment: approvalComment,
  });
  if (error) throw new Error(readError(error, "Unable to review the timesheet entry."));
  attendanceReads.clear();
  return mapTimesheetEntry(Array.isArray(data) ? data[0] : data);
}

export async function manageLiveEmployee(action, body = {}) {
  const storeId = activeStoreId();
  const { data, error } = await attendanceSupabase.functions.invoke("admin-users", {
    body: { action, ...body },
    headers: storeId ? { "x-crm-store-id": storeId } : {},
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
  attendanceReads.clear();
  return data;
}

export async function saveLiveAttendanceMapping(punchCode, userId) {
  const { data: matched, error } = await attendanceSupabase.rpc("map_attendance_employee", {
    p_punch_code: punchCode,
    p_user_id: userId,
  });
  if (error) throw new Error(readError(error, "Unable to link the attendance punch code."));
  attendanceReads.clear();
  return matched;
}

export function fetchAttendanceDashboardTotals(profile) {
  if (!profile?.id) return Promise.reject(new Error("Sign in to the attendance system first."));
  return attendanceReads.read(attendanceReadKey("totals", profile), () => loadAttendanceDashboardTotals(profile));
}

async function loadAttendanceDashboardTotals(profile) {
  if (!profile?.id) throw new Error("Sign in to the attendance system first.");
  const { data, error } = await attendanceSupabase.rpc("get_store_dashboard_totals", { p_store_id: isAttendanceSuperAdmin(profile) ? activeStoreId() || null : profile.storeId || null });
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
  attendanceReads.clear();
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
  return {
    id: profile.id,
    storeId: profile.store_id || "",
    employeeId: profile.employee_id,
    name: profile.name,
    email: profile.email,
    department: profile.department,
    manager: profile.manager,
    active: profile.active,
    role: profile.role,
    profileImage: profile.profile_image || "",
    createdAt: profile.created_at,
    shiftStartTime: String(profile.shift_start_time || "09:30").slice(0, 5),
    shiftEndTime: String(profile.shift_end_time || "17:30").slice(0, 5),
  };
}

const punchTimestampFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
function mapAttendance(record) {
  return {
    id: record.id,
    userId: record.user_id,
    employeeId: record.employee_id,
    employeeName: record.employee_name,
    punchCode: record.punch_code,
    timestamp: punchTimestampFormatter.format(new Date(record.punched_at)).replace(", ", " "),
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
