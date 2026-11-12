import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { matchAttendanceProfile } from "../_shared/attendance-identity.ts";
import { ensureAttendanceAdmin } from "../_shared/attendance-admin.ts";
import { reviewTaskSubmission, saveTaskPhotos, signedTaskImages, uploadPhotoObjects, validateTaskImages, TaskImageError } from "../_shared/task-images.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const vapidPublicKey = Deno.env.get("WEBPUSH_VAPID_PUBLIC_KEY") || "";
const adminClient = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const pageSize = 1000;

type Context = { user: any; profile: any; activeStoreId?: string };

const defaultStoreFeatures = {
  dashboard: true,
  customers: true, sales: true, attendance: true, manual_attendance: true, callbacks: true,
  reminders: true, reports: true, tasks: true, task_images: true,
};
type StoreFeature = keyof typeof defaultStoreFeatures;

function validateStoreFeatures(value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Choose store features.", { errors: { features: ["Choose store features."] } });
  const features = { ...defaultStoreFeatures };
  for (const [key, enabled] of Object.entries(value)) {
    if (!(key in features) || typeof enabled !== "boolean") fail(400, "Choose valid store features.", { errors: { features: ["Use the available feature switches."] } });
    (features as any)[key] = enabled;
  }
  return features;
}

class ApiError extends Error {
  status: number;
  payload: any;
  constructor(status: number, message: string, payload: any = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function json(status: number, payload: any = null) {
  const headers: Record<string, string> = { ...corsHeaders };
  if (status !== 204) headers["Content-Type"] = "application/json";
  return new Response(status === 204 ? null : JSON.stringify(payload), { status, headers });
}

function fail(status: number, message: string, payload: any = null): never {
  throw new ApiError(status, message, payload);
}

function checkDb(error: any) {
  if (!error) return;
  const code = String(error.code || "");
  if (code === "23505") fail(409, "This record already exists or the request conflicts with a newer change.");
  if (code === "23503") fail(400, "This record is still linked to another record. Reload and check its related records.");
  if (code === "42501") fail(403, "You do not have permission to perform this action.");
  if (code.startsWith("08") || code.startsWith("XX") || code.startsWith("PGRST") || ["57014","55P03","40001","40P01"].includes(code)) {
    const reason = code === "57014" ? "the database request timed out"
      : code === "55P03" ? "the database is busy"
        : ["40001", "40P01"].includes(code) ? "another change was being saved at the same time"
          : code.startsWith("PGRST") ? "the CRM database API could not process the request"
            : "the CRM database service is temporarily unavailable";
    console.error("CRM database request failed:", code || "unknown", error.message || "No message");
    fail(503, `The user was not saved because ${reason}. Reload once and retry. If this keeps happening, contact the system administrator.`);
  }
  if (code.startsWith("22")) fail(400, "One or more values are invalid. Check the entered dates, amounts and identifiers.");
  // P0001 is reserved for our explicit business validation messages. Other
  // provider/SQL diagnostics can contain internal schema or supplied values.
  if (code === "P0001") fail(400, error.message || "The request was rejected.");
  fail(503, "The database request failed. Reload to check the current record before retrying.");
}

function bytesToBase64(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyDjangoPassword(password: string, encoded: string) {
  const parts = encoded.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10_000_000) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const digest = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(parts[2]), iterations },
      key,
      256,
    ));
    const actual = bytesToBase64(digest);
    if (actual.length !== parts[3].length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ parts[3].charCodeAt(index);
    return difference === 0;
  } catch {
    return false;
  }
}

function legacyRole(user: any) {
  return user.is_staff || user.is_superuser ? "admin" : "employee";
}

function legacyDisplayName(user: any) {
  return [user.first_name, user.last_name].map((part) => String(part || "").trim()).filter(Boolean).join(" ") || String(user.username || "");
}

function legacyAuthClient(request: Request) {
  const key = request.headers.get("apikey") || anonKey;
  if (!key) fail(503, "Supabase sign-in is not configured.");
  return createClient(supabaseUrl, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function legacySessionResponse(session: any) {
  const response = json(200, { access_token: session.access_token, refresh_token: session.refresh_token });
  response.headers.set("Cache-Control", "no-store, max-age=0");
  return response;
}

async function handleLegacyLogin(request: Request, body: any) {
  const identity = String(body?.identity || "").trim().toLocaleLowerCase();
  const password = typeof body?.password === "string" ? body.password : "";
  if (!identity || identity.length > 256 || !password || password.length > 1024) fail(400, "Enter your username and password.");

  const { data: accounts, error } = await adminClient.rpc("crm_legacy_login_account", { p_identity: identity });
  checkDb(error);
  if (!accounts || accounts.length !== 1) fail(401, "Invalid username or password.");

  const account = accounts[0];
  if (!account.password_hash) {
    const authClient = legacyAuthClient(request);
    const { data, error: signInError } = await authClient.auth.signInWithPassword({ email: account.auth_email, password });
    if (signInError || !data.session || data.user?.id !== account.auth_user_id) fail(401, "Invalid username or password.");
    return legacySessionResponse(data.session);
  }
  if (account.password_hash.startsWith("!") || !await verifyDjangoPassword(password, account.password_hash)) {
    fail(401, "Invalid username or password.");
  }

  const { error: updateError } = await adminClient.auth.admin.updateUserById(account.auth_user_id, {
    password, app_metadata: { crm_legacy_password_upgrade: true },
  });
  if (updateError) {
    console.error("Legacy CRM password upgrade failed:", updateError.message);
    fail(400, "The old password was verified, but Supabase could not accept it. Ask an administrator to reset the password.");
  }
  const { error: clearError } = await adminClient.from("crm_legacy_auth")
    .update({ password_hash: null, password_upgraded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("local_user_id", account.local_user_id);
  checkDb(clearError);
  const authClient = legacyAuthClient(request);
  const { data, error: signInError } = await authClient.auth.signInWithPassword({ email: account.auth_email, password });
  if (signInError || !data.session || data.user?.id !== account.auth_user_id) fail(401, "Your password was upgraded. Sign in again with the same username and password.");
  return legacySessionResponse(data.session);
}

async function allAuthUsers() {
  const users: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await adminClient.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    users.push(...(data.users || []));
    if (!data.users || data.users.length < 1000) return users;
  }
  throw new Error("Auth user list exceeded the migration limit.");
}

async function upsertMigrationRows(table: string, rows: any[]) {
  for (let start = 0; start < rows.length; start += 250) {
    const { error } = await adminClient.from(table).upsert(rows.slice(start, start + 250), { onConflict: "id" });
    checkDb(error);
  }
}

function remapUserId(id: any, users: Map<string, string>, label: string, nullable = false) {
  if (id === null || id === undefined || id === "") {
    if (nullable) return null;
    fail(400, `The local migration is missing an account for ${label}.`);
  }
  const mapped = users.get(String(id));
  if (!mapped) fail(400, `The local migration references an unknown account for ${label}.`);
  return mapped;
}

async function migrateLegacyData(request: Request, body: any) {
  const token = request.headers.get("x-crm-migration-token") || "";
  if (!token) fail(401, "Migration authorization is required.");
  if (body?.version !== 1 || !Array.isArray(body.users) || body.users.length === 0) fail(400, "The local CRM migration payload is invalid.");
  const tokenHash = await sha256Hex(token);
  const { data: claimed, error: authorizationError } = await adminClient.rpc("crm_claim_legacy_migration", { p_token_hash: tokenHash });
  checkDb(authorizationError);
  if (!claimed) {
    fail(401, "Migration authorization is invalid, expired, or already used.");
  }

  const [profilesResult, legacyResult, authUsers] = await Promise.all([
    adminClient.from("profiles").select("id,employee_id,email"),
    adminClient.from("crm_legacy_auth").select("*"),
    allAuthUsers(),
  ]);
  checkDb(profilesResult.error); checkDb(legacyResult.error);
  const profiles = profilesResult.data || [];
  const existingLegacy = new Map((legacyResult.data || []).map((item: any) => [String(item.local_user_id), item]));
  const authById = new Map(authUsers.map((item: any) => [String(item.id), item]));
  const authByEmail = new Map(authUsers.map((item: any) => [String(item.email || "").toLocaleLowerCase(), item]));
  const profileByUsername = new Map(profiles.map((item: any) => [String(item.employee_id || "").toLocaleLowerCase(), item]));
  const usedEmails = new Set([
    ...profiles.map((item: any) => String(item.email || "").toLocaleLowerCase()),
    ...authUsers.map((item: any) => String(item.email || "").toLocaleLowerCase()),
  ]);
  const usernames = new Set(body.users.map((user: any) => String(user.username || "").toLocaleLowerCase()));
  const emailCounts = new Map<string, number>();
  for (const user of body.users) {
    const email = String(user.email || "").trim().toLocaleLowerCase();
    if (email) emailCounts.set(email, (emailCounts.get(email) || 0) + 1);
  }

  const userIds = new Map<string, string>();
  const legacyRows: any[] = [];
  for (const local of body.users) {
    const localId = String(local.local_user_id);
    const username = String(local.username || "").trim();
    if (!username) fail(400, "A local CRM account has no username.");
    const old = existingLegacy.get(localId) as any;
    const existingProfile = profileByUsername.get(username.toLocaleLowerCase()) as any;
    const matchingAuth = existingProfile ? authById.get(String(existingProfile.id)) : null;
    if (existingProfile && !old && !matchingAuth) fail(409, "A CRM username conflicts with an existing shared account.");

    const desiredEmail = String(local.email || "").trim().toLocaleLowerCase();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(desiredEmail);
    let authEmail = old?.auth_email || existingProfile?.email || matchingAuth?.email || "";
    let authUserId = old?.auth_user_id || existingProfile?.id || matchingAuth?.id || "";
    if (!authEmail) {
      const useOriginal = validEmail && emailCounts.get(desiredEmail) === 1 && !usedEmails.has(desiredEmail);
      authEmail = useOriginal ? desiredEmail : `crm-local-${localId}@legacy.invalid`;
      let suffix = 1;
      while (usedEmails.has(authEmail)) authEmail = `crm-local-${localId}-${suffix++}@legacy.invalid`;
      usedEmails.add(authEmail);
    }
    let authUser = authUserId ? authById.get(String(authUserId)) : authByEmail.get(String(authEmail).toLocaleLowerCase());
    if (!authUser) {
      const generated = new Uint8Array(36);
      crypto.getRandomValues(generated);
      const temporaryPassword = bytesToBase64(generated).replace(/[+/=]/g, "x") + "A9!";
      const { data, error } = await adminClient.auth.admin.createUser({
        email: authEmail,
        password: temporaryPassword,
        email_confirm: true,
        user_metadata: { employee_id: username, name: legacyDisplayName(local), crm_legacy_user_id: localId },
      });
      if (error || !data.user) {
        console.error("Unable to create a migrated CRM account:", error?.message || "No user was returned.");
        fail(409, "Supabase could not create one of the migrated accounts. No passwords were disclosed.");
      }
      authUser = data.user;
      authById.set(String(authUser.id), authUser);
      authByEmail.set(String(authUser.email || "").toLocaleLowerCase(), authUser);
    }
    authUserId = authUser.id;
    userIds.set(localId, authUserId);

    const profile = {
      id: authUserId,
      employee_id: username,
      name: legacyDisplayName(local),
      email: authEmail,
      department: "Other",
      manager: "",
      role: legacyRole(local),
      active: Boolean(local.active),
      profile_image: "",
      ...(old?.created_at ? { created_at: old.created_at } : local.date_joined ? { created_at: new Date(local.date_joined).toISOString() } : {}),
    };
    const { error: profileError } = await adminClient.from("profiles").upsert(profile, { onConflict: "id" });
    checkDb(profileError);
    profileByUsername.set(username.toLocaleLowerCase(), profile);
    usedEmails.add(authEmail.toLocaleLowerCase());

    const legacyRow = {
      local_user_id: local.local_user_id,
      username,
      original_email: String(local.email || "").trim(),
      auth_email: authEmail,
      password_hash: old ? old.password_hash : String(local.password_hash || ""),
      is_active: Boolean(local.active),
      role: legacyRole(local),
      name: legacyDisplayName(local),
      first_name: String(local.first_name || ""),
      last_name: String(local.last_name || ""),
      date_joined: local.date_joined ? new Date(local.date_joined).toISOString() : new Date().toISOString(),
      auth_user_id: authUserId,
      ...(old?.password_upgraded_at ? { password_upgraded_at: old.password_upgraded_at } : {}),
    };
    const { error: legacyError } = await adminClient.from("crm_legacy_auth").upsert(legacyRow, { onConflict: "local_user_id" });
    checkDb(legacyError);
    legacyRows.push(legacyRow);
  }

  const remap = (rows: any[], field: string, nullable = false) => rows.map((row) => ({
    ...row,
    [field]: remapUserId(row[field], userIds, field, nullable),
  }));
  await upsertMigrationRows("crm_datasets", remap(body.datasets || [], "owner_id"));
  await upsertMigrationRows("crm_dataset_columns", body.dataset_columns || []);
  const records = (body.customer_records || []).map((row: any) => {
    const { callback_completed_by_id, ...rest } = row;
    return { ...rest, callback_completed_by: remapUserId(callback_completed_by_id, userIds, "callback_completed_by", true) };
  });
  await upsertMigrationRows("crm_customer_records", records);
  const changes = (body.customer_record_changes || []).map((row: any) => {
    const { changed_by_id, ...rest } = row;
    return { ...rest, changed_by: remapUserId(changed_by_id, userIds, "changed_by", true) };
  });
  await upsertMigrationRows("crm_customer_record_changes", changes);
  await upsertMigrationRows("crm_manual_clients", remap(body.manual_clients || [], "owner_id"));
  await upsertMigrationRows("crm_visits", remap(body.visits || [], "owner_id"));

  for (const image of body.visit_images || []) {
    const safeName = String(image.file_name || "image").replace(/[^A-Za-z0-9._-]/g, "_").slice(-120) || "image";
    const storagePath = `legacy/${image.visit_id}/${image.id}-${safeName}`;
    const binary = atob(String(image.content_base64 || ""));
    const content = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const { error: uploadError } = await adminClient.storage.from("crm-visit-images").upload(storagePath, content, {
      contentType: String(image.content_type || "application/octet-stream"), upsert: true,
    });
    checkDb(uploadError);
    const { error: imageError } = await adminClient.from("crm_visit_images").upsert({
      id: image.id, visit_id: image.visit_id, storage_path: storagePath,
      original_name: String(image.original_name || safeName), uploaded_at: image.uploaded_at,
    }, { onConflict: "id" });
    checkDb(imageError);
  }

  await upsertMigrationRows("crm_reminders", remap(body.reminders || [], "owner_id"));
  const tasks = (body.assigned_tasks || []).map((row: any) => {
    const { assigned_by_id, ...rest } = row;
    return {
      ...rest,
      assignee_id: remapUserId(row.assignee_id, userIds, "task assignee"),
      assigned_by_id: remapUserId(assigned_by_id, userIds, "task creator", true),
    };
  });
  await upsertMigrationRows("crm_assigned_tasks", tasks);
  await upsertMigrationRows("crm_sales_targets", remap(body.sales_targets || [], "user_id"));
  const overtime = (body.overtime_requests || []).map((row: any) => {
    const { reviewed_by_id, ...rest } = row;
    return {
      ...rest,
      employee_id: remapUserId(row.employee_id, userIds, "overtime employee"),
      reviewed_by: remapUserId(reviewed_by_id, userIds, "overtime reviewer", true),
    };
  });
  await upsertMigrationRows("crm_overtime_requests", overtime);
  await upsertMigrationRows("crm_push_subscriptions", remap(body.push_subscriptions || [], "owner_id"));
  await upsertMigrationRows("crm_reminder_deliveries", body.reminder_deliveries || []);
  const { error: sequenceError } = await adminClient.rpc("crm_reset_identity_sequences");
  checkDb(sequenceError);

  return json(200, { status: "complete", users: legacyRows.length, imported: {
    datasets: (body.datasets || []).length,
    dataset_columns: (body.dataset_columns || []).length,
    customer_records: (body.customer_records || []).length,
    customer_record_changes: (body.customer_record_changes || []).length,
    manual_clients: (body.manual_clients || []).length,
    visits: (body.visits || []).length,
    visit_images: (body.visit_images || []).length,
    reminders: (body.reminders || []).length,
    assigned_tasks: (body.assigned_tasks || []).length,
    sales_targets: (body.sales_targets || []).length,
    overtime_requests: (body.overtime_requests || []).length,
    push_subscriptions: (body.push_subscriptions || []).length,
    reminder_deliveries: (body.reminder_deliveries || []).length,
  } });
}

function isAdminRole(role: string) {
  return role === "admin" || role === "super_admin";
}

function requireAdmin(ctx: Context) {
  if (!isAdminRole(ctx.profile.role)) fail(403, "Administrator access required.");
}

function isSuperAdmin(ctx: Context) {
  return ctx.profile.role === "super_admin";
}

function hasGlobalStoreAccess(ctx: Context) {
  return isSuperAdmin(ctx) && !ctx.activeStoreId;
}

function requireSuperAdmin(ctx: Context) {
  if (!isSuperAdmin(ctx)) fail(403, "Super Admin access required.");
}

function profileScope(ctx: Context) {
  if (isSuperAdmin(ctx)) return ctx.activeStoreId || null;
  const storeId = String(ctx.profile.store_id || "");
  if (!storeId) fail(403, "This account is not assigned to a store.");
  return storeId;
}

function requireStoreContext(ctx: Context) {
  const storeId = profileScope(ctx);
  if (!storeId) fail(400, "Open a store before accessing its business data.");
  return storeId;
}

function applyBusinessScope(query: any, ctx: Context) {
  query = query.eq("store_id", requireStoreContext(ctx));
  return isAdminRole(ctx.profile.role) ? query : query.eq("owner_id", ctx.user.id);
}

async function storeFeaturesFor(ctx: Context) {
  const storeId = profileScope(ctx);
  if (!storeId) return { ...defaultStoreFeatures };
  const { data, error } = await adminClient.from("crm_stores").select("features").eq("id", storeId).maybeSingle();
  checkDb(error);
  if (!data) fail(404, "Store not found.");
  return { ...defaultStoreFeatures, ...(data.features || {}) };
}

async function requireStoreFeature(ctx: Context, feature: StoreFeature) {
  if (!(await storeFeaturesFor(ctx))[feature]) fail(403, "This feature is not enabled for your store.");
}

async function requireTaskImageUploads(ctx: Context, files: File[], thumbnails: File[] = []) {
  if ((files.length || thumbnails.length) && !(await storeFeaturesFor(ctx)).task_images) {
    fail(403, "Task image uploads are disabled for this store.");
  }
}

async function enforceStoreAccountLimit(storeId: string | null, role: string, active: boolean, excludedUserId = "") {
  if (!storeId || !active || !["admin", "employee"].includes(role)) return;
  const column = role === "admin" ? "admin_limit" : "user_limit";
  const label = role === "admin" ? "Admin" : "User";
  const { data: store, error: storeError } = await adminClient.from("crm_stores").select("id,admin_limit,user_limit").eq("id", storeId).maybeSingle();
  checkDb(storeError);
  if (!store) fail(400, "Choose an existing store.", { errors: { store_id: ["Choose an existing store."] } });
  const limit = store[column];
  if (limit === null || limit === undefined) return;
  let query = adminClient.from("profiles").select("id", { count: "exact", head: true })
    .eq("store_id", storeId).eq("role", role).eq("active", true);
  if (excludedUserId) query = query.neq("id", excludedUserId);
  const { count, error } = await query;
  checkDb(error);
  if (Number(count || 0) >= Number(limit)) {
    const message = `This store has reached its ${label} limit of ${limit}.`;
    fail(400, message, {
      errors: {
        non_field_errors: [message],
        role: [`This store allows up to ${limit} active ${label} account${Number(limit) === 1 ? "" : "s"}.`],
      },
    });
  }
}

function applyProfileScope(query: any, ctx: Context) {
  const storeId = profileScope(ctx);
  return storeId ? query.eq("store_id", storeId) : query;
}

async function accessibleStoreUserIds(ctx: Context) {
  if (hasGlobalStoreAccess(ctx)) return null;
  const profiles = await fetchAll(() => adminClient.from("profiles").select("id").eq("store_id", profileScope(ctx)).order("id"));
  return profiles.map((profile: any) => profile.id);
}

async function authenticate(request: Request): Promise<Context> {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) fail(401, "Authentication required.");
  const { data: authData, error: authError } = await adminClient.auth.getUser(token);
  if (authError || !authData.user) fail(401, "Your session has expired. Sign in again.");
  const { data: profile, error } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", authData.user.id)
    .maybeSingle();
  checkDb(error);
  if (!profile || !profile.active) fail(403, "This account is inactive or has no profile.");
  const requestedStoreId = request.headers.get("x-crm-store-id") || "";
  if (!requestedStoreId || profile.role !== "super_admin") return { user: authData.user, profile };
  const { data: store, error: storeError } = await adminClient.from("crm_stores").select("id").eq("id", requestedStoreId).maybeSingle();
  checkDb(storeError);
  if (!store) fail(400, "The selected store no longer exists.");
  return { user: authData.user, profile, activeStoreId: store.id };
}

function attendanceAdminClient() {
  // Compatibility for older clients: Attendance now uses CRM's own identities.
  // Keep token verification on a separate client so it cannot replace the
  // service-role session used by the rest of this Edge Function.
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function syncAttendanceAdmin(profile: any, exactRole = false) {
  if (!isAdminRole(profile.role) && !exactRole) return;
  try {
    await ensureAttendanceAdmin(attendanceAdminClient(), profile, exactRole);
  } catch (error) {
    fail(503, `Unable to set up Attendance admin access: ${error instanceof Error ? error.message : (error as any)?.message || "Attendance is unavailable."}`);
  }
}

async function startAttendanceSession(ctx: Context) {
  const attendance = attendanceAdminClient();
  const username = String(ctx.profile.employee_id || "").trim();
  if (!username) fail(403, "Your CRM account has no username to match with attendance.");
  // Escape LIKE metacharacters: a username must never match other employees.
  const pattern = username.replace(/[\\%_]/g, "\\$&");
  const [{ data: crmProfiles, error: crmError }, { data: profiles, error: profileError }] = await Promise.all([
    adminClient.from("profiles").select("id,employee_id,active").ilike("employee_id", pattern).limit(2),
    attendance.from("profiles").select("id,employee_id,email,active").ilike("employee_id", pattern).limit(2),
  ]);
  checkDb(crmError); checkDb(profileError);
  const crmMatch = matchAttendanceProfile(username, crmProfiles || []);
  if (!crmMatch || crmMatch.id !== ctx.user.id) fail(403, "Your CRM username is ambiguous. Ask an administrator to make it unique.");
  let profile = matchAttendanceProfile(username, profiles || []);
  if (isAdminRole(ctx.profile.role)) {
    // Existing CRM admins receive the same access on their next Attendance login.
    await syncAttendanceAdmin(ctx.profile);
    const { data: synced, error: syncedError } = await attendance.from("profiles").select("id,employee_id,email,active").ilike("employee_id", pattern).limit(2);
    checkDb(syncedError);
    profile = matchAttendanceProfile(username, synced || []);
  }
  if (!profile) fail(403, "No unique active attendance account matches your CRM username. Ask an administrator to make the CRM username and attendance employee ID match.");
  const { data: account, error: accountError } = await attendance.auth.admin.getUserById(profile.id);
  if (accountError || !account.user?.email) fail(403, "The matching attendance account needs an administrator to correct its login details.");
  const { data: generated, error: generateError } = await attendance.auth.admin.generateLink({ type: "magiclink", email: account.user.email });
  if (generateError || generated.user?.id !== profile.id || !generated.properties?.hashed_token) fail(503, "Unable to open attendance. Try again shortly.");
  const { data: verified, error: verifyError } = await attendance.auth.verifyOtp({ token_hash: generated.properties.hashed_token, type: "email" });
  if (verifyError || !verified.session || verified.user?.id !== profile.id) fail(503, "Unable to open attendance. Try again shortly.");
  const response = json(200, { access_token: verified.session.access_token, refresh_token: verified.session.refresh_token });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function userPayload(profile: any, extras: any = {}) {
  const role = String(profile.role || "employee");
  const admin = isAdminRole(role);
  return {
    id: profile.id,
    username: profile.employee_id || profile.email || "user",
    name: profile.name || profile.employee_id || profile.email || "Employee",
    email: profile.email || "",
    role,
    is_staff: admin,
    is_superuser: role === "super_admin",
    is_admin: admin,
    is_active: Boolean(profile.active),
    date_joined: profile.created_at,
    designation: profile.designation || "",
    store_id: profile.store_id || null,
    store_name: profile.store?.name || extras.store_name || "",
    ...extras,
  };
}

function parseId(value: string | number | null | undefined) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(404, "The requested record was not found.");
  return parsed;
}

function indiaDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((item) => item.type === type)?.value || "00";
  return get("year") + "-" + get("month") + "-" + get("day");
}

function monthStart(date = new Date()) { return indiaDate(date).slice(0, 7) + "-01"; }
function reportMonth(value: string | null) {
  if (!value) return monthStart();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) fail(400, "Choose a valid report month.");
  return value + "-01";
}
function nextMonth(start: string) {
  const [year, month] = start.slice(0, 7).split("-").map(Number);
  return year + (month === 12 ? 1 : 0) + "-" + String(month === 12 ? 1 : month + 1).padStart(2, "0") + "-01";
}

async function fetchAll(build: () => any) {
  const rows: any[] = [];
  for (let from = 0; ; from += pageSize) {
    let query = build();
    query = query.range(from, from + pageSize - 1);
    const { data, error } = await query;
    checkDb(error);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function profileName(id: string | null | undefined) {
  if (!id) return null;
  const { data, error } = await adminClient.from("profiles").select("employee_id,name").eq("id", id).maybeSingle();
  checkDb(error);
  return data?.employee_id || data?.name || null;
}

async function accessibleDatasets(ctx: Context) {
  const build = () => applyBusinessScope(adminClient.from("crm_datasets").select("*").order("uploaded_at", { ascending: false }), ctx);
  return await fetchAll(build);
}

async function accessibleDataset(ctx: Context, id: string | number) {
  const query = applyBusinessScope(adminClient.from("crm_datasets").select("*").eq("id", parseId(id)), ctx);
  const { data, error } = await query.maybeSingle();
  checkDb(error);
  if (!data) fail(404, "Dataset not found.");
  return data;
}

async function accessibleRecord(ctx: Context, recordId: string | number, datasetId?: string | number) {
  let query = adminClient.from("crm_customer_records").select("*").eq("id", parseId(recordId));
  if (datasetId !== undefined) query = query.eq("dataset_id", parseId(datasetId));
  const { data: record, error } = await query.maybeSingle();
  checkDb(error);
  if (!record) fail(404, "Customer not found.");
  const dataset = await accessibleDataset(ctx, record.dataset_id);
  return { record, dataset };
}

async function countRecords(datasetId: number) {
  const { count, error } = await adminClient.from("crm_customer_records").select("id", { count: "exact", head: true }).eq("dataset_id", datasetId);
  checkDb(error);
  return count || 0;
}

async function datasetRecordCounts(ids: number[]) {
  if (!ids.length) return [];
  const { data, error } = await adminClient.rpc("crm_dataset_counts", { p_ids: ids });
  checkDb(error);
  return data || [];
}

async function targetAndConversions(ownerId: string, month: string) {
  const { data: target, error: targetError } = await adminClient
    .from("crm_sales_targets").select("id,target,metric").eq("user_id", ownerId).eq("month", month).maybeSingle();
  checkDb(targetError);
  const { data: visits, error } = await adminClient.from("crm_visits").select("id,total_amount")
    .eq("owner_id", ownerId).eq("status", "converted").gte("visit_date", month).lt("visit_date", nextMonth(month));
  checkDb(error);
  const metric = target?.metric === "amount" ? "amount" : "count";
  const converted = metric === "amount"
    ? (visits || []).reduce((sum: number, visit: any) => sum + Number(visit.total_amount || 0), 0)
    : (visits || []).length;
  const goal = target ? Number(target.target) : null;
  return { target: goal, target_metric: metric, converted_count: converted, remaining_target: goal === null ? null : Math.max(goal - converted, 0) };
}

async function serializeDataset(dataset: any) {
  const [owner, customerCount, target] = await Promise.all([
    profileName(dataset.owner_id),
    countRecords(Number(dataset.id)),
    targetAndConversions(dataset.owner_id, monthStart()),
  ]);
  return {
    id: dataset.id,
    name: dataset.name,
    original_filename: dataset.original_filename,
    owner_username: owner,
    customer_count: customerCount,
    target: target.target,
    converted_count: target.converted_count || 0,
    remaining_target: target.remaining_target,
    uploaded_at: dataset.uploaded_at,
    updated_at: dataset.updated_at,
  };
}

async function serializeDatasets(datasets: any[]) {
  if (!datasets.length) return [];
  const ownerIds = [...new Set(datasets.map((dataset: any) => dataset.owner_id).filter(Boolean))];
  const currentMonth = monthStart();
  const followingMonth = nextMonth(currentMonth);
  const [profiles, targets, convertedVisits, customerCounts] = await Promise.all([
    fetchAll(() => adminClient.from("profiles").select("id,employee_id,name").in("id", ownerIds)),
    fetchAll(() => adminClient.from("crm_sales_targets").select("user_id,target,metric").in("user_id", ownerIds).eq("month", currentMonth)),
    fetchAll(() => adminClient.from("crm_visits").select("owner_id,total_amount").in("owner_id", ownerIds).eq("status", "converted").gte("visit_date", currentMonth).lt("visit_date", followingMonth)),
    datasetRecordCounts(datasets.map((dataset: any) => dataset.id)),
  ]);
  const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
  const targetByOwner = new Map(targets.map((target: any) => [target.user_id, { target: Number(target.target || 0), metric: target.metric === "amount" ? "amount" : "count" }]));
  const conversionsByOwner = new Map<string, { count: number; amount: number }>();
  for (const visit of convertedVisits) {
    const current = conversionsByOwner.get(visit.owner_id) || { count: 0, amount: 0 };
    current.count += 1; current.amount += Number(visit.total_amount || 0);
    conversionsByOwner.set(visit.owner_id, current);
  }
  const countByDataset = new Map(customerCounts.map((row: any) => [Number(row.dataset_id),Number(row.customer_count)]));
  return datasets.map((dataset: any) => {
    const profile = profileById.get(dataset.owner_id);
    const target = targetByOwner.get(dataset.owner_id);
    const converted = target?.metric === "amount" ? (conversionsByOwner.get(dataset.owner_id)?.amount || 0) : (conversionsByOwner.get(dataset.owner_id)?.count || 0);
    return {
      id: dataset.id,
      name: dataset.name,
      original_filename: dataset.original_filename,
      owner_username: profile?.employee_id || profile?.name || null,
      customer_count: countByDataset.get(Number(dataset.id)) || 0,
      target: target?.target ?? null,
      target_metric: target?.metric || "count",
      converted_count: converted,
      remaining_target: target === undefined ? null : Math.max(target.target - converted, 0),
      uploaded_at: dataset.uploaded_at,
      updated_at: dataset.updated_at,
    };
  });
}

async function datasetColumns(datasetId: number) {
  const { data, error } = await adminClient.from("crm_dataset_columns").select("*")
    .eq("dataset_id", datasetId).order("sheet_name").order("column_order");
  checkDb(error);
  return data || [];
}

const responseLabels: Record<string, string> = {
  no_response: "No Response", interested: "Interested", not_interested: "Not Interested",
  callback: "Callback", converted: "Converted",
};
const responseChoices = Object.entries(responseLabels).map(([value, label]) => ({ value, label }));

function displayName(record: any, columns: any[] = []) {
  const values = record.original_data || {};
  const keys = ["customer_name", "customer", "client_name", "client", "full_name", "name", "contact_name", "company_name", "company"];
  for (const key of keys) if (values[key] !== "" && values[key] != null) return String(values[key]);
  for (const column of columns) if (values[column.field_key] !== "" && values[column.field_key] != null) return String(values[column.field_key]);
  for (const value of Object.values(values)) if (value !== "" && value != null) return String(value);
  return "Customer row " + record.row_number;
}

function maskSensitive(value: any) {
  if (value == null || value === "") return "";
  let text = String(value).replace(/([A-Z0-9._%+-]+)@([A-Z0-9.-]+\.[A-Z]{2,})/gi, (_match, local, domain) => {
    const masked = local.length <= 2 ? "*".repeat(local.length) : local[0] + "***" + local[local.length - 1];
    return masked + "@" + domain;
  });
  const digits = (text.match(/\d/g) || []).length;
  if (digits >= 7) {
    let seen = 0;
    text = text.split("").reverse().map((character) => {
      if (!/\d/.test(character)) return character;
      seen += 1;
      return seen <= 2 ? character : "X";
    }).reverse().join("");
  }
  return text;
}

async function serializeRecord(record: any, columns: any[] = []) {
  const completedBy = await profileName(record.callback_completed_by);
  return {
    id: record.id,
    display_name: displayName(record, columns),
    sheet_name: record.sheet_name,
    row_number: record.row_number,
    original_data: record.original_data || {},
    revision: record.revision ?? 0,
    response: record.response,
    response_label: responseLabels[record.response] || record.response,
    callback_date: record.callback_date,
    callback_completed_at: record.callback_completed_at,
    callback_completed_by: record.callback_completed_by,
    callback_completed_by_username: completedBy,
    note: record.note || "",
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function fieldRows(record: any, columns: any[]) {
  return columns.map((column) => ({ label: column.original_name, value: maskSensitive(record.original_data?.[column.field_key] ?? "") }));
}

function recordChangeList(change: any, changedBy: string | null) {
  const fields = [
    ["response", "Response"], ["callback_date", "Callback Date"], ["note", "Note"],
  ];
  const changes = [];
  for (const [field, label] of fields) {
    const previous = change.previous_values?.[field] ?? "";
    const updated = change.updated_values?.[field] ?? "";
    if (previous === updated) continue;
    changes.push({ field, label, previous: field === "response" ? responseLabels[previous] || previous : previous, updated: field === "response" ? responseLabels[updated] || updated : updated });
  }
  return { id: change.id, changed_by_username: changedBy, changed_at: change.changed_at, changes };
}

function positiveQueryId(value: string) {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) fail(400, "Invalid query identifier.");
  return id;
}

async function customerChangeHistoryPage(recordId: number, beforeTime: string | null = null, beforeId: number | null = null) {
  const { data, error } = await adminClient.rpc("crm_customer_history_page", { p_record: recordId, p_before_time: beforeTime, p_before_id: beforeId });
  checkDb(error);
  const records = data?.records || [];
  const ids = [...new Set(records.map((item: any) => item.changed_by).filter(Boolean))];
  const names = new Map<string,string>();
  if (ids.length) {
    const { data: profiles, error: profileError } = await adminClient.from("profiles").select("id,employee_id,name").in("id", ids);
    checkDb(profileError);
    for (const profile of profiles || []) names.set(profile.id, profile.employee_id || profile.name);
  }
  return { entries: records.map((item: any) => recordChangeList(item, names.get(item.changed_by) || null)), nextCursor: data?.nextCursor || null };
}

async function customerChangeHistory(recordId: number) {
  return (await customerChangeHistoryPage(recordId)).entries;
}

async function recordDetail(ctx: Context, record: any, dataset: any, choices = false) {
  const columns = (await datasetColumns(Number(dataset.id))).filter((column) => column.sheet_name === record.sheet_name);
  const [datasetPayload, recordPayload, history] = await Promise.all([
    serializeDataset(dataset), serializeRecord(record, columns), customerChangeHistoryPage(Number(record.id)),
  ]);
  const result: any = {
    dataset: datasetPayload,
    record: recordPayload,
    fieldRows: fieldRows(record, columns),
    changeHistory: history.entries,
    changeHistoryNextCursor: history.nextCursor,
  };
  if (choices) result.responseChoices = responseChoices;
  return result;
}

async function callbackPayload(record: any, dataset: any, loadedColumns?: any[], reviewerNames?: Map<string,string>) {
  const columns = (loadedColumns || await datasetColumns(Number(dataset.id))).filter((column) => column.sheet_name === record.sheet_name);
  const values = record.original_data || {};
  const phoneKeys = ["phone_number", "phone", "mobile_number", "mobile", "contact_number", "telephone"];
  let phone = "";
  for (const key of phoneKeys) if (values[key] != null && values[key] !== "") { phone = maskSensitive(values[key]); break; }
  return {
    id: record.id, datasetId: record.dataset_id, datasetName: dataset.name,
    customerName: displayName(record, columns), phone,
    callbackDate: record.callback_date, callbackCompletedAt: record.callback_completed_at,
    callbackCompletedBy: reviewerNames ? reviewerNames.get(record.callback_completed_by) || null : await profileName(record.callback_completed_by),
    status: record.response, statusLabel: responseLabels[record.response] || record.response,
    note: record.note, updatedAt: record.updated_at, revision: record.revision ?? 0,
  };
}

async function updateCustomerWithHistory(ctx: Context, recordId: number, changes: any, complete = false) {
  const values: any = {};
  for (const key of ["response", "callback_date", "note", "expected_revision"]) if (changes[key] !== undefined) values[key] = changes[key];
  const { data, error } = await adminClient.rpc("crm_update_customer", {
    p_actor: ctx.user.id, p_store: requireStoreContext(ctx), p_record: recordId, p_changes: values, p_complete: complete,
  });
  if (error?.code === "42501" || error?.code === "P0002") fail(404, "Customer not found.");
  if (error?.code === "40001") fail(409, "This callback is no longer pending.");
  if (error?.code === "PT409") fail(409, "This customer changed since you opened it. Your draft has been kept; reload the latest record before saving.");
  if (error?.code === "PT428") fail(428, "Reload this customer before saving.");
  checkDb(error);
  return data;
}

function queryParams(url: URL) { return url.searchParams; }

function valueString(value: any) { return String(value ?? "").trim(); }

async function requestBody(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase()) || request.body === null) {
    return { values: {}, files: [] as File[], thumbnails: [] as File[] };
  }
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    // Photo forms contain only compressed variants. Retain at most 3 MiB;
    // discard oversized input without parsing or buffering the original.
    const photoForm = /\/(?:admin\/)?tasks(?:\/\d+)?\/?$|\/sales\/visits(?:\/\d+)?\/?$/.test(new URL(request.url).pathname);
    let form: FormData;
    if (photoForm) {
      const maximum = 3 * 1024 * 1024;
      let tooLarge = Number(request.headers.get("content-length") || 0) > maximum;
      const reader = request.body!.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maximum) tooLarge = true;
          if (tooLarge) chunks.length = 0;
          else chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      // The hosted Edge relay can hang responses when a request is left
      // unread or cancelled. Drain rejected input with constant memory first.
      if (tooLarge) fail(413, "The photo upload is too large. Select the photos again to compress them.");
      form = await new Response(new Blob(chunks), { headers: { "content-type": contentType } }).formData();
    } else form = await request.formData();
    const values: Record<string, any> = {};
    const files: File[] = [];
    const thumbnails: File[] = [];
    for (const [key, value] of form.entries()) {
      if (value instanceof File) {
        if (value.size) (key === "image_thumbnails" ? thumbnails : files).push(value);
      } else if (key === "images") {
        continue;
      } else values[key] = value;
    }
    return { values, files, thumbnails };
  }
  if (!contentType.includes("application/json")) return { values: {}, files: [] as File[], thumbnails: [] as File[] };
  return { values: await request.json(), files: [] as File[], thumbnails: [] as File[] };
}

async function visibleRecords(ctx: Context, datasetIds: number[]) {
  if (!datasetIds.length) return [];
  return await fetchAll(() => adminClient.from("crm_customer_records").select("*")
    .in("dataset_id", datasetIds).order("dataset_id").order("sheet_name").order("row_number"));
}

async function accessibleVisits(ctx: Context, options: any = {}) {
  return await fetchAll(() => {
    let query = applyBusinessScope(adminClient.from("crm_visits").select("*").order("visit_date", { ascending: false })
      .order("meeting_time", { ascending: false }).order("created_at", { ascending: false }), ctx);
    if (options.status) query = query.eq("status", options.status);
    if (options.dateFrom) query = query.gte("visit_date", options.dateFrom);
    if (options.dateTo) query = query.lte("visit_date", options.dateTo);
    return query;
  });
}

async function serializeTasks(tasks: any[]) {
  if (!tasks.length) return [];
  // Bound IN filters to keep large admin task lists below URL/header limits.
  if (tasks.length > 200) {
    const results: any[] = [];
    for (let offset = 0; offset < tasks.length; offset += 200) {
      results.push(...await serializeTasks(tasks.slice(offset, offset + 200)));
    }
    return results;
  }
  const taskIds = tasks.map((task) => task.id);
  const [submissions, images] = await Promise.all([
    fetchAll(() => adminClient.from("crm_task_submissions").select("*").in("task_id", taskIds).order("id")),
    fetchAll(() => adminClient.from("crm_task_images").select("*").in("task_id", tasks.map((task) => task.id)).order("id")),
  ]);
  const profileIds = [...new Set([
    ...tasks.flatMap((task) => [task.assignee_id, task.assigned_by_id]),
    ...submissions.map((submission: any) => submission.reviewed_by),
  ].filter(Boolean))];
  const profiles = await fetchAll(() => adminClient.from("profiles").select("id,employee_id,name").in("id", profileIds).order("id"));
  const names = new Map(profiles.map((profile: any) => [profile.id, profile.employee_id || profile.name]));
  const photos = new Map<number, any[]>();
  for (const image of await signedTaskImages(adminClient, images)) {
    if (!photos.has(image.task_id)) photos.set(image.task_id, []);
    photos.get(image.task_id)!.push(image);
  }
  const attempts = new Map<number, any[]>();
  for (const submission of submissions) {
    if (!attempts.has(submission.task_id)) attempts.set(submission.task_id, []);
    attempts.get(submission.task_id)!.push({
      id: submission.id, note: submission.note, status: submission.status, submitted_at: submission.submitted_at,
      review_note: submission.review_note, reviewed_at: submission.reviewed_at,
      reviewed_by_username: names.get(submission.reviewed_by) || null,
      images: (photos.get(submission.task_id) || []).filter((image) => image.submission_id === submission.id),
    });
  }
  return tasks.map((task) => {
    const history = attempts.get(task.id) || [];
    const current = history[history.length - 1] || null;
    return {
    id: task.id, assignee: task.assignee_id, assignee_username: names.get(task.assignee_id) || null,
    assigned_by_username: names.get(task.assigned_by_id) || null, title: task.title, note: task.note,
    due_at: task.due_at, status: task.status,
    status_label: task.status === "submitted" ? "Awaiting approval" : task.status === "rejected" ? "Rejected" : task.status === "done" ? current?.status === "approved" ? "Approved" : "Completed" : "Pending",
    completed_at: task.completed_at, created_at: task.created_at, updated_at: task.updated_at,
    assignment_images: (photos.get(task.id) || []).filter((image) => image.stage === "assignment"),
    completion_images: current?.images || [], submissions: history, current_submission: current,
    };
  });
}

async function serializeTask(task: any) { return (await serializeTasks([task]))[0]; }

async function targetPayload(target: any) {
  const userName = await profileName(target.user_id);
  const allTargets = await fetchAll(() => adminClient.from("crm_sales_targets").select("target,month,metric")
    .eq("user_id", target.user_id).order("month", { ascending: false }));
  const months = [...allTargets.map((item: any) => String(item.month)),String(target.month)].sort();
  const visits = await fetchAll(() => adminClient.from("crm_visits").select("id,visit_date,total_amount").order("id")
    .eq("owner_id", target.user_id).eq("status", "converted").gte("visit_date",months[0]).lt("visit_date",nextMonth(months[months.length-1])));
  const conversions = new Map<string,{ count: number; amount: number }>();
  for (const visit of visits) {
    const month = String(visit.visit_date).slice(0,7);
    const current = conversions.get(month) || { count: 0, amount: 0 };
    current.count += 1; current.amount += Number(visit.total_amount || 0);
    conversions.set(month,current);
  }
  const metric = target.metric === "amount" ? "amount" : "count";
  const converted = conversions.get(String(target.month).slice(0,7))?.[metric] || 0;
  let lowTargetCount = 0;
  for (const item of allTargets) {
    if (String(item.month) >= monthStart()) continue;
    const progress = conversions.get(String(item.month).slice(0,7))?.[item.metric === "amount" ? "amount" : "count"] || 0;
    const percent = item.target ? Math.round((progress / Number(item.target)) * 100) : 0;
    if (percent <= 30) lowTargetCount += 1;
  }
  const goal = Number(target.target);
  const percentage = goal ? Math.round((converted / goal) * 100) : 0;
  return {
    id: target.id, userId: target.user_id, username: userName,
    month: String(target.month).slice(0, 7),
    monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(String(target.month) + "T00:00:00Z")),
    datasetId: null, datasetName: "", target: goal, metric, converted, percentage,
    statusColor: percentage <= 30 ? "danger" : percentage <= 70 ? "primary" : "success",
    lowTargetCount, needsWarning: lowTargetCount >= 3,
    warningMessage: lowTargetCount >= 3 ? userName + " has already failed to achieve at least 30% of the assigned target " + lowTargetCount + " times. Schedule a meeting and review this user's continuation." : "",
  };
}

async function serializeManualClient(client: any) {
  return {
    id: client.id, owner_username: await profileName(client.owner_id),
    client_name: client.client_name, phone: client.phone, email: client.email,
    company: client.company, location: client.location,
    created_at: client.created_at, updated_at: client.updated_at,
  };
}

async function serializeVisit(visit: any, includeFields = false) {
  const [manualClient, customer, images, employee] = await Promise.all([
    visit.manual_client_id
      ? adminClient.from("crm_manual_clients").select("*").eq("id", visit.manual_client_id).maybeSingle().then((r: any) => { checkDb(r.error); return r.data; })
      : Promise.resolve(null),
    visit.customer_id
      ? adminClient.from("crm_customer_records").select("*").eq("id", visit.customer_id).maybeSingle().then((r: any) => { checkDb(r.error); return r.data; })
      : Promise.resolve(null),
    adminClient.from("crm_visit_images").select("*").eq("visit_id", visit.id).order("uploaded_at").then(async (r: any) => {
      checkDb(r.error);
      return await signedTaskImages(adminClient, r.data || [], "crm-visit-images");
    }),
    adminClient.from("profiles").select("name,employee_id").eq("id", visit.owner_id).maybeSingle().then((r: any) => {
      checkDb(r.error);
      return r.data;
    }),
  ]);
  let dataset: any = null;
  let columns: any[] = [];
  if (customer) {
    const { data, error } = await adminClient.from("crm_datasets").select("*").eq("id", customer.dataset_id).maybeSingle();
    checkDb(error);
    dataset = data;
    columns = (await datasetColumns(Number(customer.dataset_id))).filter((column) => column.sheet_name === customer.sheet_name);
  }
  const payload: any = {
    id: visit.id,
    revision: visit.revision ?? 0,
    client_name: customer ? displayName(customer, columns) : manualClient?.client_name || "",
    client_source: customer ? "Excel Customer" : "Manual Client",
    dataset_id: dataset?.id || null, dataset_name: dataset?.name || null,
    manual_client: manualClient ? await serializeManualClient(manualClient) : null,
    client_record_id: customer?.id || null,
    customer_note: customer?.note || null,
    images,
    visit_date: visit.visit_date, meeting_time: visit.meeting_time ? String(visit.meeting_time).slice(0, 8) : null,
    location: visit.location, expense: visit.expense, status: visit.status,
    status_label: ({ healthy: "Healthy", follow_up_required: "Follow-up Required", interested: "Interested", not_interested: "Not Interested", converted: "Converted" } as any)[visit.status] || visit.status,
    payment_status: visit.payment_status,
    payment_status_label: ({ not_paid: "Not Paid", partially_paid: "Partially Paid", completed: "Completed", one_time: "One-time Payment" } as any)[visit.payment_status] || visit.payment_status,
    total_amount: visit.total_amount, paid_amount: visit.paid_amount,
    pending_amount: Math.max(Math.round((Number(visit.total_amount || 0) - Number(visit.paid_amount || 0)) * 100) / 100, 0),
    payment_description: visit.payment_description || "", note: visit.note || "",
    employee_name: employee?.name || employee?.employee_id || "Unknown employee",
    employee_id: employee?.employee_id || "",
    created_at: visit.created_at, updated_at: visit.updated_at,
  };
  if (includeFields) {
    payload.customer_fields = customer
      ? fieldRows(customer, columns)
      : [
        { label: "Client Name", value: manualClient?.client_name || "" },
        { label: "Phone", value: manualClient?.phone || "" },
        { label: "Email", value: manualClient?.email || "" },
        { label: "Company", value: manualClient?.company || "" },
        { label: "Location", value: manualClient?.location || "" },
        { label: "Created", value: manualClient?.created_at || "" },
        { label: "Updated", value: manualClient?.updated_at || "" },
      ];
  }
  return payload;
}

async function serializeVisitList(visits: any[]) {
  if (!visits.length) return [];
  const manualIds = [...new Set(visits.map((visit: any) => visit.manual_client_id).filter(Boolean))];
  const customerIds = [...new Set(visits.map((visit: any) => visit.customer_id).filter(Boolean))];
  const ownerIds = [...new Set(visits.map((visit: any) => visit.owner_id).filter(Boolean))];
  const [manualClients, customers, employees] = await Promise.all([
    manualIds.length ? fetchAll(() => adminClient.from("crm_manual_clients").select("*").in("id", manualIds)) : [],
    customerIds.length ? fetchAll(() => adminClient.from("crm_customer_records").select("*").in("id", customerIds)) : [],
    ownerIds.length ? fetchAll(() => adminClient.from("profiles").select("id,name,employee_id").in("id", ownerIds)) : [],
  ]);
  const datasetIds = [...new Set(customers.map((customer: any) => Number(customer.dataset_id)))];
  const [datasets, columns] = await Promise.all([
    datasetIds.length ? fetchAll(() => adminClient.from("crm_datasets").select("id,name").in("id", datasetIds)) : [],
    datasetIds.length ? fetchAll(() => adminClient.from("crm_dataset_columns").select("*").in("dataset_id", datasetIds).order("sheet_name").order("column_order")) : [],
  ]);
  const manualById = new Map(manualClients.map((item: any) => [Number(item.id), item]));
  const customerById = new Map(customers.map((item: any) => [Number(item.id), item]));
  const employeeById = new Map(employees.map((item: any) => [item.id, item]));
  const datasetById = new Map(datasets.map((item: any) => [Number(item.id), item]));
  const columnsByDataset = new Map<number, any[]>();
  for (const column of columns) columnsByDataset.set(Number(column.dataset_id), [...(columnsByDataset.get(Number(column.dataset_id)) || []), column]);
  return visits.map((visit: any) => {
    const manualClient = manualById.get(Number(visit.manual_client_id));
    const customer = customerById.get(Number(visit.customer_id));
    const dataset = customer ? datasetById.get(Number(customer.dataset_id)) : null;
    const employee = employeeById.get(visit.owner_id);
    const sheetColumns = customer ? (columnsByDataset.get(Number(customer.dataset_id)) || []).filter((column) => column.sheet_name === customer.sheet_name) : [];
    return {
      id: visit.id,
      revision: visit.revision,
      client_name: customer ? displayName(customer, sheetColumns) : manualClient?.client_name || "",
      client_source: customer ? "Excel Customer" : "Manual Client",
      dataset_id: dataset?.id || null,
      dataset_name: dataset?.name || null,
      manual_client: manualClient ? {
        id: manualClient.id,
        client_name: manualClient.client_name,
        phone: manualClient.phone,
        email: manualClient.email,
        company: manualClient.company,
        location: manualClient.location,
      } : null,
      client_record_id: customer?.id || null,
      customer_note: customer?.note || null,
      images: [],
      visit_date: visit.visit_date,
      meeting_time: visit.meeting_time ? String(visit.meeting_time).slice(0, 8) : null,
      location: visit.location,
      expense: visit.expense,
      status: visit.status,
      status_label: ({ healthy: "Healthy", follow_up_required: "Follow-up Required", interested: "Interested", not_interested: "Not Interested", converted: "Converted" } as any)[visit.status] || visit.status,
      payment_status: visit.payment_status,
      payment_status_label: ({ not_paid: "Not Paid", partially_paid: "Partially Paid", completed: "Completed", one_time: "One-time Payment" } as any)[visit.payment_status] || visit.payment_status,
      total_amount: visit.total_amount,
      paid_amount: visit.paid_amount,
      pending_amount: Math.max(Math.round((Number(visit.total_amount || 0) - Number(visit.paid_amount || 0)) * 100) / 100, 0),
      payment_description: visit.payment_description || "",
      note: visit.note || "",
      employee_name: employee?.name || employee?.employee_id || "Unknown employee",
      employee_id: employee?.employee_id || "",
      created_at: visit.created_at,
      updated_at: visit.updated_at,
    };
  });
}

async function uploadVisitImages(visitId: number, files: File[], thumbnails: File[] = []) {
  if (!files.length && !thumbnails.length) return;
  const uploaded = await uploadPhotoObjects(adminClient, "crm-visit-images", String(visitId), files, thumbnails);
  const { error } = await adminClient.from("crm_visit_images").insert(uploaded.images.map((image) => ({ visit_id: visitId, ...image })));
  if (error) { await adminClient.storage.from("crm-visit-images").remove(uploaded.paths); checkDb(error); }
}

async function datasetList(ctx: Context) {
  const datasets = await accessibleDatasets(ctx);
  return await serializeDatasets(datasets);
}

async function dashboardSummary(ctx: Context) {
  const datasets = await accessibleDatasets(ctx);
  const datasetIds = datasets.map((dataset: any) => Number(dataset.id));
  const recordCountRequests = responseChoices.map(async (choice) => {
    if (!datasetIds.length) return [choice.value, 0] as const;
    const { count, error } = await adminClient.from("crm_customer_records")
      .select("id", { count: "exact", head: true }).in("dataset_id", datasetIds).eq("response", choice.value);
    checkDb(error);
    return [choice.value, count || 0] as const;
  });
  const visitRequest = (async () => {
    const { data, error } = await adminClient.rpc("crm_visit_summary", { p_store: requireStoreContext(ctx), p_owner: isAdminRole(ctx.profile.role) ? null : ctx.user.id, p_today: indiaDate() });
    checkDb(error); return data;
  })();
  const [recordCountRows, visitSummary, recentDatasets] = await Promise.all([
    Promise.all(recordCountRequests),
    visitRequest,
    serializeDatasets(datasets.slice(0, 3)),
  ]);
  const counts = Object.fromEntries(recordCountRows);
  const totalCustomers = recordCountRows.reduce((sum, [, count]) => sum + count, 0);
  return {
    totalDatasets: datasets.length,
    totalCustomers,
    responseStats: responseChoices.map((item) => ({ ...item, count: counts[item.value] || 0 })),
    recentDatasets,
    payments: visitSummary.payments,
    sales: visitSummary.sales,
  };
}

async function datasetDetail(ctx: Context, id: string, params: URLSearchParams) {
  const dataset = await accessibleDataset(ctx, id);
  const columns = await datasetColumns(Number(dataset.id));
  const query = valueString(params.get("q")).toLocaleLowerCase();
  const responseFilter = valueString(params.get("response"));
  const requestedPage = Math.max(1, Number(params.get("page")) || 1);
  let stats: Record<string, number> = {};
  let filteredCount = 0;
  let pageRecords: any[] = [];
  let page = 1;
  let numPages = 1;

  if (!query) {
    const countRows = await Promise.all(responseChoices.map(async (choice) => {
      const { count, error } = await adminClient.from("crm_customer_records")
        .select("id", { count: "exact", head: true }).eq("dataset_id", dataset.id).eq("response", choice.value);
      checkDb(error);
      return [choice.value, count || 0] as const;
    }));
    stats = Object.fromEntries(countRows);
    filteredCount = responseFilter ? stats[responseFilter] || 0 : countRows.reduce((sum, [, count]) => sum + count, 0);
    numPages = Math.max(1, Math.ceil(filteredCount / 20));
    page = Math.min(requestedPage, numPages);
    let recordQuery = adminClient.from("crm_customer_records").select("*").eq("dataset_id", dataset.id)
      .order("sheet_name").order("row_number");
    if (responseFilter) recordQuery = recordQuery.eq("response", responseFilter);
    const { data, error } = await recordQuery.range((page - 1) * 20, page * 20 - 1);
    checkDb(error);
    pageRecords = data || [];
  } else {
    const result = await customerSearchPage([Number(dataset.id)], query, responseFilter, requestedPage, 20, "dataset");
    stats = result.stats; filteredCount = result.count;
    numPages = result.numPages; page = result.page; pageRecords = result.records;
  }
  const groupedColumns = new Map<string, any[]>();
  for (const column of columns) groupedColumns.set(column.sheet_name, [...(groupedColumns.get(column.sheet_name) || []), column]);
  const grouped: any[] = [];
  for (const [sheetName, sheetColumns] of groupedColumns.entries()) {
    const sheetRecords = pageRecords.filter((record: any) => record.sheet_name === sheetName);
    grouped.push({
      sheetName,
      columns: sheetColumns.map((column) => ({ id: column.id, originalName: column.original_name, fieldKey: column.field_key })),
      records: await Promise.all(sheetRecords.map(async (record: any) => ({
        record: await serializeRecord(record, sheetColumns),
        values: sheetColumns.map((column) => maskSensitive(record.original_data?.[column.field_key] ?? "")),
      }))),
    });
  }
  return {
    dataset: await serializeDataset(dataset),
    responseChoices,
    responseStats: responseChoices.map((choice) => ({ ...choice, count: stats[choice.value] || 0 })),
    recordsBySheet: grouped,
    filters: { search: valueString(params.get("q")), response: responseFilter, active: Boolean(query || responseFilter), filteredCount },
    pagination: {
      page: Math.min(page, numPages), numPages, count: filteredCount,
      hasNext: page < numPages, hasPrevious: page > 1,
      nextPage: page < numPages ? page + 1 : null,
      previousPage: page > 1 ? page - 1 : null,
      pageRange: Array.from({ length: numPages }, (_value, index) => index + 1),
    },
  };
}

async function datasetExport(ctx: Context, id: string, params: URLSearchParams) {
  const dataset = await accessibleDataset(ctx, id);
  const columns = await datasetColumns(Number(dataset.id));
  const records = await visibleRecords(ctx, [Number(dataset.id)]);
  const query = valueString(params.get("q")).toLocaleLowerCase();
  const responseFilter = valueString(params.get("response"));
  const filtered = records.filter((record: any) => {
    if (responseFilter && record.response !== responseFilter) return false;
    if (!query) return true;
    const values = Object.values(record.original_data || {}).map(String).concat([responseLabels[record.response] || record.response, record.note || ""]);
    return values.some((value) => value.toLocaleLowerCase().includes(query));
  });
  const sheets = new Map<string, any[]>();
  for (const record of filtered) {
    const sheetColumns = columns.filter((column) => column.sheet_name === record.sheet_name);
    const row = sheetColumns.map((column) => record.original_data?.[column.field_key] ?? "");
    row.push(responseLabels[record.response] || record.response, record.note || "");
    sheets.set(record.sheet_name, [...(sheets.get(record.sheet_name) || []), row]);
  }
  return {
    filename: dataset.name,
    sheets: [...new Set([...columns.map((column: any) => column.sheet_name), ...sheets.keys()])].map((name) => ({
      name,
      headers: [...columns.filter((column: any) => column.sheet_name === name).map((column: any) => column.original_name), "Response", "Note"],
      rows: sheets.get(name) || [],
    })),
  };
}

async function customerVisitImagePaths(customerIds: number[]) {
  const paths = new Set<string>();
  if (customerIds.length) {
    for (let offset = 0; offset < customerIds.length; offset += 500) {
      const visitRows = await fetchAll(() => adminClient.from("crm_visits").select("id").in("customer_id", customerIds.slice(offset, offset + 500)));
      const visitIds = visitRows.map((item: any) => item.id);
      if (!visitIds.length) continue;
      const images = await fetchAll(() => adminClient.from("crm_visit_images").select("storage_path,thumbnail_path").in("visit_id", visitIds));
      for (const image of images) for (const path of [image.storage_path,image.thumbnail_path]) if (path) paths.add(path);
    }
  }
  return [...paths];
}

async function cleanupDeletedCustomerImages(paths: string[]) {
  for (let offset = 0; offset < paths.length; offset += 100) {
    try {
      const { error } = await adminClient.storage.from("crm-visit-images").remove(paths.slice(offset,offset+100));
      if (error) console.error("Deleted customer photo cleanup failed:", error.message);
    } catch (error) { console.error("Deleted customer photo cleanup failed:", error instanceof Error ? error.message : "Storage unavailable"); }
  }
}

async function deleteDataset(ctx: Context, dataset: any) {
  const recordRows = await fetchAll(() => adminClient.from("crm_customer_records").select("id").eq("dataset_id", dataset.id));
  const paths = await customerVisitImagePaths(recordRows.map((item: any) => item.id));
  const { error } = await adminClient.from("crm_datasets").delete().eq("id", dataset.id);
  checkDb(error);
  await cleanupDeletedCustomerImages(paths);
}

async function customerSearchPage(ids: number[], query: string, status: string, page: number, size: number, mode: string) {
  const { data, error } = await adminClient.rpc("crm_customer_page", {
    p_ids: ids, p_query: query, p_status: status, p_page: Math.min(2147483647, Math.floor(page)), p_size: size, p_mode: mode,
  });
  checkDb(error);
  return data;
}

async function customerList(ctx: Context, params: URLSearchParams) {
  const datasets = await accessibleDatasets(ctx);
  const datasetIds = datasets.map((item: any) => Number(item.id));
  const datasetById = new Map(datasets.map((item: any) => [Number(item.id), item]));
  const query = valueString(params.get("q")).toLocaleLowerCase();
  const statusFilter = responseLabels[params.get("status") || ""] ? params.get("status") || "" : "";
  const requestedPage = Math.max(1, Number(params.get("page")) || 1);
  let counts: Record<string, number> = {};
  let filteredCount = 0;
  let pageRecords: any[] = [];
  let page = 1;
  let numPages = 1;
  const columnsByDataset = new Map<number, any[]>();

  if (!datasetIds.length) {
    counts = Object.fromEntries(responseChoices.map((choice) => [choice.value, 0]));
  } else if (!query) {
    // Normal directory browsing is fully paginated in Postgres. Previously the
    // endpoint downloaded every accessible customer and every dataset column
    // before returning only 50 rows.
    const countRequests = responseChoices.map(async (choice) => {
      const { count, error } = await adminClient.from("crm_customer_records")
        .select("id", { count: "exact", head: true }).in("dataset_id", datasetIds).eq("response", choice.value);
      checkDb(error);
      return [choice.value, count || 0] as const;
    });
    const filteredCountRequest = (async () => {
      let countQuery = adminClient.from("crm_customer_records").select("id", { count: "exact", head: true }).in("dataset_id", datasetIds);
      if (statusFilter) countQuery = countQuery.eq("response", statusFilter);
      const { count, error } = await countQuery;
      checkDb(error);
      return count || 0;
    })();
    const [countRows, total] = await Promise.all([Promise.all(countRequests), filteredCountRequest]);
    counts = Object.fromEntries(countRows);
    filteredCount = total;
    numPages = Math.max(1, Math.ceil(filteredCount / 50));
    page = Math.min(requestedPage, numPages);
    let recordQuery = adminClient.from("crm_customer_records").select("*").in("dataset_id", datasetIds)
      .order("dataset_id").order("sheet_name").order("row_number");
    if (statusFilter) recordQuery = recordQuery.eq("response", statusFilter);
    const { data, error } = await recordQuery.range((page - 1) * 50, page * 50 - 1);
    checkDb(error);
    pageRecords = data || [];
    const pageDatasetIds = [...new Set(pageRecords.map((record: any) => Number(record.dataset_id)))];
    await Promise.all(pageDatasetIds.map(async (datasetId) => columnsByDataset.set(datasetId, await datasetColumns(datasetId))));
  } else {
    const result = await customerSearchPage(datasetIds, query, statusFilter, requestedPage, 50, "customers");
    counts = result.stats; filteredCount = result.count;
    numPages = result.numPages; page = result.page; pageRecords = result.records;
    const pageIds = [...new Set(pageRecords.map((record: any) => Number(record.dataset_id)))];
    await Promise.all(pageIds.map(async (datasetId) => columnsByDataset.set(datasetId, await datasetColumns(datasetId))));
  }
  const results = await Promise.all(pageRecords.map(async (record: any) => {
    const dataset = datasetById.get(Number(record.dataset_id));
    const columns = (columnsByDataset.get(Number(record.dataset_id)) || []).filter((item: any) => item.sheet_name === record.sheet_name);
    return {
      record: await serializeRecord(record, columns), datasetId: record.dataset_id,
      datasetName: dataset?.name || "", fieldRows: fieldRows(record, columns),
    };
  }));
  return {
    results, searchQuery: valueString(params.get("q")), selectedStatus: statusFilter,
    statusOptions: responseChoices.map((item) => ({ ...item, count: counts[item.value] || 0 })),
    totalCount: Object.values(counts).reduce((sum, value) => sum + value, 0),
    pagination: { page: Math.min(page, numPages), pageSize: 50, numPages, count: filteredCount, hasNext: page < numPages, hasPrevious: page > 1, nextPage: page < numPages ? page + 1 : null, previousPage: page > 1 ? page - 1 : null },
  };
}

async function listCallbacks(ctx: Context, params: URLSearchParams) {
  const datasets = await accessibleDatasets(ctx);
  const byId = new Map(datasets.map((item: any) => [Number(item.id), item]));
  const today = indiaDate();
  const tomorrowDate = new Date(today + "T12:00:00+05:30");
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrowDate);
  let preset = valueString(params.get("preset") || "today").toLowerCase();
  const dateValue = valueString(params.get("date"));
  let selectedDate: string | null = null;
  if (preset === "called_back" && !dateValue) { /* completed queue */ }
  else if (dateValue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) fail(400, "Enter a valid callback date.");
    selectedDate = dateValue;
    preset = "custom";
  } else if (preset === "today") selectedDate = today;
  else if (preset === "tomorrow") selectedDate = tomorrow;
  else if (preset !== "all") { preset = "today"; selectedDate = today; }
  const sort = valueString(params.get("sort") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  const { data: queue, error } = await adminClient.rpc("crm_callback_page", {
    p_ids: datasets.map((item: any) => item.id), p_today: today, p_tomorrow: tomorrow,
    p_date: selectedDate, p_completed: preset === "called_back", p_desc: sort === "desc",
    p_page: Math.min(2147483647,Math.max(1,Math.floor(Number(params.get("page")) || 1))),
  });
  checkDb(error);
  const list = queue.records;
  const ids = [...new Set(list.map((r: any) => r.dataset_id))];
  const reviewers = [...new Set(list.map((r: any) => r.callback_completed_by).filter(Boolean))];
  const [columns, profiles] = await Promise.all([
    ids.length ? fetchAll(() => adminClient.from("crm_dataset_columns").select("*").in("dataset_id",ids).order("column_order")) : [],
    reviewers.length ? fetchAll(() => adminClient.from("profiles").select("id,employee_id,name").in("id",reviewers)) : [],
  ]);
  const names = new Map<string,string>(profiles.map((p: any) => [p.id,p.employee_id || p.name]));
  return {
    results: await Promise.all(list.map((record: any) => callbackPayload(record, byId.get(Number(record.dataset_id)),columns.filter((c: any) => c.dataset_id===record.dataset_id),names))),
    counts: queue.counts,
    pagination: queue.pagination,
    filters: { preset, date: selectedDate, sort, today, tomorrow },
    outcomeChoices: responseChoices.filter((item) => item.value !== "callback"),
  };
}

async function listReminders(ctx: Context) {
  const { data, error } = await adminClient.from("crm_reminders").select("*")
    .eq("owner_id", ctx.user.id).eq("store_id", requireStoreContext(ctx)).order("reminder_at").order("id");
  checkDb(error);
  const ids = (data || []).map((r: any) => r.id);
  const { data: receipts, error: receiptError } = ids.length
    ? await adminClient.from("crm_reminder_deliveries").select("reminder_id,delivery_revision,received_at,displayed_at,clicked_at").in("reminder_id", ids)
    : { data: [], error: null };
  checkDb(receiptError);
  const notificationStatus = (item: any) => {
    const rows = (receipts || []).filter((r: any) => r.reminder_id === item.id && r.delivery_revision === item.delivery_revision);
    if (rows.some((r: any) => r.clicked_at)) return "Notification opened";
    if (rows.some((r: any) => r.displayed_at)) return "Browser created notification";
    if (rows.some((r: any) => r.received_at)) return "Browser received notification";
    if (item.delivery_status === "sent") return "Push service accepted; awaiting browser receipt";
    if (item.delivery_status === "no_subscriptions") return "Waiting for a registered device";
    if (item.delivery_status === "retrying") return "Delivery retry scheduled";
    if (item.delivery_status === "failed") return "Delivery needs attention";
    return new Date(item.reminder_at).getTime() > Date.now() ? "Scheduled" : "Waiting for delivery";
  };
  return (data || []).map((item: any) => ({
    id: item.id, text: item.text, reminder_at: item.reminder_at,
    is_due: new Date(item.reminder_at).getTime() <= Date.now(),
    notification_status: notificationStatus(item),
    created_at: item.created_at, sent_at: item.sent_at,
    delivery_status: item.delivery_status, delivery_attempt_count: item.delivery_attempt_count,
    last_delivery_attempt_at: item.last_delivery_attempt_at,
    next_delivery_attempt_at: item.next_delivery_attempt_at,
    last_delivery_error: item.last_delivery_error,
  }));
}

async function salesPerformance(ctx: Context, month = monthStart()) {
  const profiles = await fetchAll(() => applyProfileScope(
    adminClient.from("profiles").select("id,employee_id,name,designation,active,role").eq("active", true).order("employee_id"), ctx,
  ));
  const salesUsers = profiles.filter((profile: any) => !isAdminRole(profile.role) && String(profile.designation || "").trim().toLowerCase() === "sales");
  if (!salesUsers.length) return [];
  const userIds = salesUsers.map((profile: any) => profile.id);
  const [visits, targets] = await Promise.all([
    fetchAll(() => adminClient.from("crm_visits").select("owner_id,total_amount").in("owner_id", userIds).eq("status", "converted").gte("visit_date", month).lt("visit_date", nextMonth(month))),
    fetchAll(() => adminClient.from("crm_sales_targets").select("user_id,target,metric").in("user_id", userIds).eq("month", month)),
  ]);
  const totals = new Map<string, { count: number; amount: number }>();
  for (const visit of visits) {
    const current = totals.get(visit.owner_id) || { count: 0, amount: 0 };
    current.count += 1; current.amount += Number(visit.total_amount || 0);
    totals.set(visit.owner_id, current);
  }
  const targetByUser = new Map(targets.map((target: any) => [target.user_id, target]));
  return salesUsers.map((profile: any) => {
    const totalsForUser = totals.get(profile.id) || { count: 0, amount: 0 };
    const target = targetByUser.get(profile.id);
    const metric = target?.metric === "amount" ? "amount" : "count";
    const goal = target ? Number(target.target) : null;
    const completed = totalsForUser[metric];
    return {
      userId: profile.id,
      username: profile.employee_id || profile.name || "Sales user",
      month: month.slice(0, 7),
      convertedCount: totalsForUser.count,
      convertedAmount: totalsForUser.amount,
      target: goal,
      metric: target ? metric : null,
      completed,
      remaining: goal === null ? null : Math.max(goal - completed, 0),
      percentage: goal ? Math.round((completed / goal) * 100) : null,
    };
  });
}

async function userPerformance(ctx: Context, month = monthStart()) {
  const profiles = await fetchAll(() => applyProfileScope(
    adminClient.from("profiles").select("id,employee_id,name,designation,active,role").eq("active", true).order("employee_id"), ctx,
  ));
  const employees = profiles.filter((profile: any) => !isAdminRole(profile.role));
  if (!employees.length) return [];
  const employeeIds = employees.map((profile: any) => profile.id);
  const [tasks, timesheetEntries, settings] = await Promise.all([
    fetchAll(() => adminClient.from("crm_assigned_tasks").select("assignee_id,status")
      .in("assignee_id", employeeIds).gte("created_at", month)),
    fetchAll(() => adminClient.from("timesheet_entries").select("user_id,work_date,total_hours")
      .in("user_id", employeeIds).gte("work_date", month).neq("approval_status", "Rejected")),
    (async () => {
      const { data, error } = await adminClient.from("app_settings").select("standard_hours").eq("id", true).maybeSingle();
      checkDb(error);
      return data;
    })(),
  ]);
  const totals = new Map<string, { assigned: number; completed: number }>();
  for (const task of tasks) {
    const current = totals.get(task.assignee_id) || { assigned: 0, completed: 0 };
    current.assigned += 1;
    if (task.status === "done") current.completed += 1;
    totals.set(task.assignee_id, current);
  }
  const dailyHours = new Map<string, number>();
  for (const entry of timesheetEntries) {
    const key = entry.user_id + "|" + entry.work_date;
    dailyHours.set(key, (dailyHours.get(key) || 0) + Number(entry.total_hours || 0));
  }
  const standardHours = Number(settings?.standard_hours || 8);
  const shortHours = new Map<string, { hours: number; days: number }>();
  for (const [key, hours] of dailyHours) {
    if (hours >= standardHours) continue;
    const userId = key.split("|", 1)[0];
    const current = shortHours.get(userId) || { hours: 0, days: 0 };
    current.hours += standardHours - hours;
    current.days += 1;
    shortHours.set(userId, current);
  }
  return employees.map((profile: any) => {
    const total = totals.get(profile.id) || { assigned: 0, completed: 0 };
    const short = shortHours.get(profile.id) || { hours: 0, days: 0 };
    return {
      userId: profile.id,
      username: profile.employee_id || profile.name || "Employee",
      designation: profile.designation || null,
      month: month.slice(0, 7),
      assignedTasks: total.assigned,
      completedTasks: total.completed,
      pendingTasks: Math.max(total.assigned - total.completed, 0),
      percentage: total.assigned ? Math.round((total.completed / total.assigned) * 100) : null,
      shortHours: Math.round(short.hours * 100) / 100,
      shortDays: short.days,
    };
  });
}

async function listTargets(ctx: Context, userId: string | null = null) {
  const storeUserIds = hasGlobalStoreAccess(ctx) ? null : await accessibleStoreUserIds(ctx);
  const targets = await fetchAll(() => {
    let query = adminClient.from("crm_sales_targets").select("*").order("month", { ascending: false }).order("id");
    if (userId) query = query.eq("user_id", userId);
    if (storeUserIds) query = storeUserIds.length ? query.in("user_id", storeUserIds) : query.eq("user_id", "00000000-0000-0000-0000-000000000000");
    return query;
  });
  if (!targets.length) return [];
  const userIds = [...new Set(targets.map((target: any) => target.user_id))];
  const firstMonth = [...targets].sort((a: any, b: any) => String(a.month).localeCompare(String(b.month)))[0].month;
  const lastMonth = [...targets].sort((a: any, b: any) => String(b.month).localeCompare(String(a.month)))[0].month;
  const [profiles, visits] = await Promise.all([
    fetchAll(() => adminClient.from("profiles").select("id,employee_id,name").in("id", userIds)),
    fetchAll(() => adminClient.from("crm_visits").select("id,owner_id,visit_date,total_amount").in("owner_id", userIds).eq("status", "converted").gte("visit_date", firstMonth).lt("visit_date", nextMonth(lastMonth)).order("id")),
  ]);
  const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
  const convertedByUserMonth = new Map<string, { count: number; amount: number }>();
  for (const visit of visits) {
    const key = `${visit.owner_id}|${String(visit.visit_date).slice(0, 7)}`;
    const current = convertedByUserMonth.get(key) || { count: 0, amount: 0 };
    current.count += 1; current.amount += Number(visit.total_amount || 0);
    convertedByUserMonth.set(key, current);
  }
  const lowCountsByUser = new Map<string, number>();
  for (const target of targets) {
    if (String(target.month) >= monthStart()) continue;
    const converted = convertedByUserMonth.get(`${target.user_id}|${String(target.month).slice(0, 7)}`)?.[target.metric === "amount" ? "amount" : "count"] || 0;
    const percentage = target.target ? Math.round((converted / Number(target.target)) * 100) : 0;
    if (percentage <= 30) lowCountsByUser.set(target.user_id, (lowCountsByUser.get(target.user_id) || 0) + 1);
  }
  return targets.map((target: any) => {
    const profile = profileById.get(target.user_id);
    const username = profile?.employee_id || profile?.name || null;
    const metric = target.metric === "amount" ? "amount" : "count";
    const converted = convertedByUserMonth.get(`${target.user_id}|${String(target.month).slice(0, 7)}`)?.[metric] || 0;
    const goal = Number(target.target);
    const percentage = goal ? Math.round((converted / goal) * 100) : 0;
    const lowTargetCount = lowCountsByUser.get(target.user_id) || 0;
    return {
      id: target.id,
      userId: target.user_id,
      username,
      month: String(target.month).slice(0, 7),
      monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(String(target.month) + "T00:00:00Z")),
      datasetId: null,
      datasetName: "",
      target: goal,
      metric,
      converted,
      percentage,
      statusColor: percentage <= 30 ? "danger" : percentage <= 70 ? "primary" : "success",
      lowTargetCount,
      needsWarning: lowTargetCount >= 3,
      warningMessage: lowTargetCount >= 3 ? username + " has already failed to achieve at least 30% of the assigned target " + lowTargetCount + " times. Schedule a meeting and review this user's continuation." : "",
    };
  });
}

async function createOrUpdateVisit(ctx: Context, visitId: number | null, body: any, files: File[], thumbnails: File[] = []) {
  const storeId = requireStoreContext(ctx);
  if (files.length || thumbnails.length) await validateTaskImages(files, thumbnails);
  const errors: Record<string, string[]> = {};
  const addError = (field: string, message: string) => { errors[field] = [...(errors[field] || []), message]; };
  const mode = valueString(body.visit_mode || "existing");
  const date = valueString(body.visit_date);
  const meeting = valueString(body.meeting_time);
  const location = valueString(body.location);
  const status = valueString(body.status || "healthy");
  const validStatuses = ["healthy", "follow_up_required", "interested", "not_interested", "converted"];
  const parsedDate = new Date(date + "T00:00:00Z");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) addError("visit_date", "Enter a valid date.");
  if (!["existing", "manual"].includes(mode)) addError("visit_mode", "Choose an existing or manual client.");
  if (meeting && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(meeting)) addError("meeting_time", "Enter a valid meeting time.");
  if (location.length > 255) addError("location", "Enter a meeting location up to 255 characters.");
  if (!validStatuses.includes(status)) addError("status", "Choose a valid visit status.");
  const numberFields = ["expense", "total_amount", "paid_amount"];
  const numbers: Record<string, number> = {};
  for (const name of numberFields) {
    const parsed = Number(body[name] || 0);
    const maximum = name === "expense" ? 99999999.99 : 9999999999.99;
    if (!["string", "number", "undefined"].includes(typeof body[name]) || !Number.isFinite(parsed) || parsed < 0 || parsed > maximum || Math.abs(parsed - Math.round(parsed * 100) / 100) > 0.0000001) addError(name, "Enter a non-negative amount with at most two decimal places within the supported range.");
    numbers[name] = parsed;
  }
  const paymentStatuses = ["not_paid", "partially_paid", "completed", "one_time"];
  const paymentStatus = valueString(body.payment_status || "not_paid");
  const requestKey = visitId ? "" : valueString(body.request_key);
  if (requestKey && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestKey)) addError("request_key", "Reload the visit form before retrying.");
  if (!paymentStatuses.includes(paymentStatus)) addError("payment_status", "Choose a valid payment status.");
  if (numbers.paid_amount > numbers.total_amount) addError("paid_amount", "Paid amount cannot exceed the total amount.");
  if (valueString(body.note).length > 2000) addError("note", "Enter a note up to 2000 characters.");
  if (valueString(body.payment_description).length > 2000) addError("payment_description", "Enter a payment description up to 2000 characters.");
  if (Object.keys(errors).length) {
    fail(400, "Please correct the highlighted fields.", { errors });
  }

  const previous = visitId ? await visibleVisit(ctx, visitId) : null;
  let customerId: number | null = null;
  let manualClientId: number | null = null;
  let clientValues: any = null;
  let visitOwnerId = previous?.owner_id || ctx.user.id;
  if (mode === "manual") {
    const clientName = valueString(body.client_name);
    if (!clientName || clientName.length > 255) addError("client_name", "Enter a client name up to 255 characters.");
    if (valueString(body.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valueString(body.email))) addError("email", "Enter a valid email address.");
    if (errors.client_name || errors.email) fail(400, "Please correct the highlighted fields.", { errors });
    clientValues = {
      store_id: previous?.store_id || storeId,
      owner_id: previous?.owner_id || ctx.user.id,
      client_name: clientName,
      phone: valueString(body.phone).slice(0, 50),
      email: valueString(body.email).slice(0, 254),
      company: valueString(body.company).slice(0, 255),
      location: valueString(body.client_location).slice(0, 255),
    };
    manualClientId = previous?.manual_client_id || null;
  } else {
    const dataset = await accessibleDataset(ctx, body.dataset);
    const requestedCustomer = parseId(body.customer);
    const { data: record, error } = await adminClient.from("crm_customer_records").select("id")
      .eq("id", requestedCustomer).eq("dataset_id", dataset.id).maybeSingle();
    checkDb(error);
    if (!record) addError("customer", "Select a valid customer from this dataset.");
    else customerId = record.id;
    if (errors.customer) fail(400, "Please correct the highlighted fields.", { errors });
  }
  const values = {
    store_id: previous?.store_id || storeId,
    owner_id: visitOwnerId,
    customer_id: customerId,
    manual_client_id: manualClientId,
    visit_date: date,
    meeting_time: meeting ? (meeting.length === 5 ? meeting + ":00" : meeting) : null,
    location,
    expense: numbers.expense,
    status,
    payment_status: paymentStatus,
    total_amount: numbers.total_amount,
    paid_amount: numbers.paid_amount,
    payment_description: valueString(body.payment_description),
    note: valueString(body.note),
    request_key: requestKey || null,
    ...(visitId && body.expected_revision !== undefined ? { expected_revision: body.expected_revision } : {}),
    request_images: requestKey ? await Promise.all(files.map(async (file) => ({
      name: file.name, type: file.type, digest: [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))].map((byte) => byte.toString(16).padStart(2,"0")).join(""),
    }))) : [],
  };
  // Upload first; metadata, manual-client edits and the visit commit together.
  // A failed database save removes only this request's newly uploaded objects.
  const uploaded = files.length || thumbnails.length
    ? await uploadPhotoObjects(adminClient, "crm-visit-images", ctx.user.id, files, thumbnails)
    : { images: [], paths: [] };
  let saved: any;
  try {
    const { data, error } = await adminClient.rpc("crm_save_sales_visit", {
      p_actor: ctx.user.id, p_store: storeId, p_visit: visitId, p_values: values, p_client: clientValues, p_images: uploaded.images,
    });
    if (error?.code === "PT409") fail(409, "This visit changed since you opened it. Your draft has been kept; reload the latest visit before saving.");
    if (error?.code === "PT428") fail(428, "Reload this visit before saving.");
    checkDb(error); saved = data;
    if (saved._replayed && uploaded.paths.length) {
      const { error: cleanupError } = await adminClient.storage.from("crm-visit-images").remove(uploaded.paths);
      if (cleanupError) console.error("Replayed visit photo cleanup failed:", cleanupError.message);
    }
    delete saved._replayed;
  } catch (error) {
    if (uploaded.paths.length) {
      const { error: cleanupError } = await adminClient.storage.from("crm-visit-images").remove(uploaded.paths);
      if (cleanupError) console.error("Visit photo cleanup failed:", cleanupError.message);
    }
    throw error;
  }
  return await serializeVisit(saved, true);
}

async function visibleVisit(ctx: Context, id: number) {
  const query = applyBusinessScope(adminClient.from("crm_visits").select("*").eq("id", id), ctx);
  const { data, error } = await query.maybeSingle();
  checkDb(error);
  if (!data) fail(404, "Visit not found.");
  return data;
}

async function createImportedDataset(ctx: Context, body: any) {
  return await stagedImport(ctx, "start", null, body);
}

async function stagedImport(ctx: Context, action: string, jobId: string | null, body: any) {
  const { data, error } = await adminClient.rpc("crm_import", {
    p_actor: ctx.user.id, p_store: requireStoreContext(ctx), p_action: action, p_job: jobId, p_payload: body,
  });
  if (error) {
    if (error.code === "42501") fail(403, "This import is not accessible in your account and store.");
    if (["P0001", "22P02", "23514", "22003"].includes(error.code)) fail(400, error.message);
    checkDb(error);
  }
  return data;
}

async function routeApi(ctx: Context, request: Request, apiPath: string, params: URLSearchParams, body: any, files: File[], thumbnails: File[] = []) {
  const method = request.method.toUpperCase();
  const path = apiPath.replace(/^\/+|\/+$/g, "");
  const parts = path ? path.split("/").map(decodeURIComponent) : [];

  if (path === "store/features" && method === "GET") return json(200, { features: await storeFeaturesFor(ctx) });
  const requiredFeature: StoreFeature | null =
    parts[0] === "dashboard" ? "dashboard" :
    parts[0] === "reports" ? "reports" :
    ["datasets", "customers", "import"].includes(parts[0]) || (parts[0] === "admin" && parts[1] === "users" && parts[3] === "datasets") ? "customers" :
    ["sales", "targets"].includes(parts[0]) || (parts[0] === "admin" && ["targets", "sales-performance"].includes(parts[1])) ? "sales" :
    parts[0] === "attendance" && parts[1] === "manual" ? "manual_attendance" :
    ["attendance", "overtime"].includes(parts[0]) ? "attendance" :
    parts[0] === "callbacks" ? "callbacks" :
    ["reminders", "push"].includes(parts[0]) ? "reminders" :
    ["tasks", "task-notifications"].includes(parts[0]) || (parts[0] === "admin" && parts[1] === "tasks") ? "tasks" : null;
  if (requiredFeature) await requireStoreFeature(ctx, requiredFeature);

  if (hasGlobalStoreAccess(ctx) && !["auth", "push"].includes(parts[0])
      // These administration routes receive the target store through their
      // own request parameter, so a global Super Admin does not need to have
      // a workspace store selected first.
      && !(parts[0] === "admin" && ["stores", "users", "designations"].includes(parts[1]))) requireStoreContext(ctx);

  if (parts[0] === "payroll") return await handlePayroll(ctx, method, parts, params, body);

  if (parts[0] === "payroll" && parts[1] === "employees" && parts.length === 2 && method === "GET") {
    requireAdmin(ctx);
    const storeId = requireStoreContext(ctx);
    const { data: profiles, error: profileError } = await adminClient.from("profiles")
      .select("id,name,employee_id,designation").eq("store_id", storeId).eq("active", true).eq("role", "employee").order("name");
    checkDb(profileError);
    const ids = (profiles || []).map((profile: any) => profile.id);
    const attendanceNames = new Map<string, string>();
    if (ids.length) {
      const rows = await fetchAll(() => adminClient.from("attendance_records").select("user_id,employee_name,punched_at")
        .in("user_id", ids).not("employee_name", "is", null).order("punched_at", { ascending: false }));
      for (const row of rows) {
        const name = valueString(row.employee_name);
        if (name && !attendanceNames.has(row.user_id)) attendanceNames.set(row.user_id, name);
      }
    }
    return json(200, { results: (profiles || []).map((profile: any) => ({
      id: profile.id, name: attendanceNames.get(profile.id) || profile.name || profile.employee_id || "Employee",
      employee_id: profile.employee_id || "", designation: profile.designation || "",
    })) });
  }

  if (parts[0] === "payroll" && parts[1] === "payments") {
    const storeId = requireStoreContext(ctx);
    const admin = isAdminRole(ctx.profile.role);
    const paymentMethods = ["bank_transfer", "cash", "upi", "cheque", "other"];
    const serializePayments = async (payments: any[]) => {
      const employeeIds = [...new Set(payments.map((payment) => payment.employee_id).filter(Boolean))];
      const employeeById = new Map<string, any>();
      if (employeeIds.length) {
        const { data, error } = await adminClient.from("profiles").select("id,name,employee_id,designation")
          .in("id", employeeIds);
        checkDb(error);
        for (const employee of data || []) employeeById.set(employee.id, employee);
      }
      return payments.map((payment) => ({
        ...payment,
        employee_name: employeeById.get(payment.employee_id)?.name || "Employee",
        employee_code: employeeById.get(payment.employee_id)?.employee_id || "",
        employee_designation: employeeById.get(payment.employee_id)?.designation || "",
      }));
    };
    if (parts.length === 2 && method === "GET") {
      let query = adminClient.from("crm_payroll_payments").select("*").eq("store_id", storeId).order("payroll_month", { ascending: false }).order("created_at", { ascending: false });
      if (!admin) query = query.eq("employee_id", ctx.user.id).in("status", ["approved", "paid"]);
      const { data, error } = await query;
      checkDb(error);
      return json(200, { results: await serializePayments(data || []), can_manage: admin, can_approve: isSuperAdmin(ctx) });
    }
    if (parts.length === 2 && method === "POST") {
      requireAdmin(ctx);
      const employeeId = valueString(body.employee_id);
      const month = valueString(body.payroll_month);
      const paymentDate = valueString(body.payment_date);
      const paymentMethod = valueString(body.payment_method || "bank_transfer");
      const requestedStatus = valueString(body.status || "draft");
      const errors: Record<string, string[]> = {};
      const amount = (field: string, label: string) => {
        const text = valueString(body[field] ?? 0);
        const value = Number(text);
        if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(value) || value > 100000000000) {
          errors[field] = [`Enter a valid ${label} amount.`];
          return 0;
        }
        return value;
      };
      const basicSalary = amount("basic_salary", "basic salary");
      const bonusAmount = amount("bonus_amount", "bonus");
      const overtimeHours = amount("overtime_hours", "overtime hours");
      const overtimeRate = amount("overtime_rate", "overtime rate");
      const overtimeAmount = Math.round(overtimeHours * overtimeRate * 100) / 100;
      const deductionAmount = amount("deduction_amount", "deduction");
      const advanceRecovery = amount("advance_recovery", "advance recovery");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(employeeId)) errors.employee_id = ["Choose an employee."];
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) errors.payroll_month = ["Choose a payroll month."];
      if (paymentDate && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) errors.payment_date = ["Choose a valid payment date."];
      if (!paymentMethods.includes(paymentMethod)) errors.payment_method = ["Choose a valid payment method."];
      if (!["draft", "submitted"].includes(requestedStatus)) errors.status = ["Choose Draft or Submitted."];
      if (valueString(body.reference_number).length > 120) errors.reference_number = ["Reference number can contain up to 120 characters."];
      if (valueString(body.notes).length > 2000) errors.notes = ["Notes can contain up to 2,000 characters."];
      const netAmount = basicSalary + bonusAmount + overtimeAmount - deductionAmount - advanceRecovery;
      if (netAmount < 0) errors.deduction_amount = ["Deductions and advance recovery cannot exceed the gross amount."];
      if (Object.keys(errors).length) fail(400, "Correct the payment details.", { errors });
      const { data: employee, error: employeeError } = await adminClient.from("profiles").select("id,role,active")
        .eq("id", employeeId).eq("store_id", storeId).maybeSingle();
      checkDb(employeeError);
      if (!employee || !employee.active || isAdminRole(employee.role)) fail(400, "Choose an active employee in this store.", { errors: { employee_id: ["Choose an active employee in this store."] } });
      const { data, error } = await adminClient.from("crm_payroll_payments").insert({
        store_id: storeId, employee_id: employeeId, payroll_month: `${month}-01`,
        basic_salary: basicSalary, bonus_amount: bonusAmount, overtime_hours: overtimeHours,
        overtime_rate: overtimeRate, overtime_amount: overtimeAmount,
        deduction_amount: deductionAmount, advance_recovery: advanceRecovery, net_amount: netAmount,
        payment_date: paymentDate || null, payment_method: paymentMethod,
        reference_number: valueString(body.reference_number), notes: valueString(body.notes),
        status: requestedStatus, created_by: ctx.user.id,
      }).select("*").single();
      checkDb(error);
      return json(201, { payment: (await serializePayments([data]))[0] });
    }
    if (parts.length === 4 && parts[3] === "approve" && method === "POST") {
      requireSuperAdmin(ctx);
      const { data: existing, error: existingError } = await adminClient.from("crm_payroll_payments").select("*")
        .eq("id", parts[2]).eq("store_id", storeId).maybeSingle();
      checkDb(existingError);
      if (!existing) fail(404, "Payroll payment not found.");
      if (existing.status !== "submitted") fail(400, "Only submitted payroll payments can be approved.");
      const { data, error } = await adminClient.from("crm_payroll_payments").update({
        status: "approved", approved_by: ctx.user.id, approved_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq("id", existing.id).select("*").single();
      checkDb(error);
      return json(200, { payment: (await serializePayments([data]))[0] });
    }
  }

  if (path === "dashboard/" || path === "dashboard" || path === "reports/summary") {
    if (method === "GET") {
      const summary = await dashboardSummary(ctx);
      const features = await storeFeaturesFor(ctx);
      if (!features.sales) {
        summary.sales = { totalVisits: 0, todaysVisits: 0, monthVisits: 0, totalVisitExpenses: 0 };
        summary.payments = { totalAmount: 0, paidAmount: 0, pendingAmount: 0, paidCount: 0, pendingCount: 0, oneTimeCount: 0, completedCount: 0 };
      }
      if (!features.customers) {
        summary.totalDatasets = 0; summary.totalCustomers = 0;
        summary.recentDatasets = [];
        summary.responseStats = summary.responseStats.map((item: any) => ({ ...item, count: 0 }));
      }
      return json(200, summary);
    }
  }

  if (parts[0] === "datasets") {
    if (parts.length === 1 && method === "GET") {
      return json(200, { results: await datasetList(ctx) });
    }
    if (parts.length === 2) {
      const dataset = await accessibleDataset(ctx, parts[1]);
      if (parts[2] === "manage") return json(404, { detail: "Dataset not found." });
      if (method === "GET") return json(200, await datasetDetail(ctx, parts[1], params));
    }
    if (parts.length === 3 && parts[2] === "manage") {
      const dataset = await accessibleDataset(ctx, parts[1]);
      if (method === "PATCH") {
        const name = valueString(body.name);
        if (!name || name.length > 255) fail(400, "Enter a valid dataset name.", { errors: { name: ["Enter a valid dataset name."] } });
        const { data, error } = await adminClient.from("crm_datasets").update({ name }).eq("id", dataset.id).select("*").single();
        checkDb(error);
        return json(200, await serializeDataset(data));
      }
      if (method === "DELETE") {
        await deleteDataset(ctx, dataset);
        return json(204);
      }
    }
    if (parts.length === 5 && parts[2] === "customers" && parts[4] === "history" && method === "GET") {
      const { record } = await accessibleRecord(ctx, parts[3], parts[1]);
      const time = params.get("before_time"), id = params.get("before_id");
      if (Boolean(time) !== Boolean(id) || (time && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(Date.parse(time))))) fail(400, "Invalid history cursor.");
      return json(200, await customerChangeHistoryPage(Number(record.id), time, id ? positiveQueryId(id) : null));
    }
    if (parts.length === 4 && parts[2] === "customers") {
      const { record, dataset } = await accessibleRecord(ctx, parts[3], parts[1]);
      if (method === "GET") return json(200, await recordDetail(ctx, record, dataset, true));
      if (method === "PATCH") {
        const response = body.response === undefined ? record.response : valueString(body.response);
        if (!responseLabels[response]) fail(400, "Choose a valid response status.", { errors: { response: ["Choose a valid response status."] } });
        const callbackDate = body.callback_date === undefined ? record.callback_date : (valueString(body.callback_date) || null);
        if (callbackDate && !/^\d{4}-\d{2}-\d{2}$/.test(callbackDate)) fail(400, "Enter a valid callback date.", { errors: { callback_date: ["Enter a valid date."] } });
        const changes: any = {};
        if (body.response !== undefined) changes.response = response;
        if (body.callback_date !== undefined) changes.callback_date = callbackDate;
        if (body.note !== undefined) changes.note = String(body.note || "");
        if (body.expected_revision !== undefined) changes.expected_revision = body.expected_revision;
        const data = await updateCustomerWithHistory(ctx, Number(record.id), changes);
        return json(200, await recordDetail(ctx, data, dataset, false));
      }
      if (method === "DELETE") {
        const paths = await customerVisitImagePaths([Number(record.id)]);
        const { error } = await adminClient.from("crm_customer_records").delete().eq("id", record.id);
        checkDb(error);
        await cleanupDeletedCustomerImages(paths);
        return json(204);
      }
    }
    if (parts.length === 3 && parts[2] === "export" && method === "GET") {
      return json(200, await datasetExport(ctx, parts[1], params));
    }
  }

  if (parts[0] === "customers") {
    if (parts.length === 1 && method === "GET") return json(200, await customerList(ctx, params));
    if (parts.length === 2 && method === "GET") {
      const { record, dataset } = await accessibleRecord(ctx, parts[1]);
      return json(200, await recordDetail(ctx, record, dataset, true));
    }
  }

  if (parts[0] === "callbacks") {
    if (parts.length === 1 && method === "GET") return json(200, await listCallbacks(ctx, params));
    if (parts.length === 3 && parts[2] === "complete" && method === "POST") {
      const { record, dataset } = await accessibleRecord(ctx, parts[1]);
      if (record.response !== "callback" || record.callback_completed_at) fail(400, "This callback is no longer pending.");
      const outcome = valueString(body.response);
      if (!responseLabels[outcome] || outcome === "callback") fail(400, "Choose a valid callback outcome.", { errors: { response: ["Choose a valid callback outcome."] } });
      const data = await updateCustomerWithHistory(ctx, Number(record.id), { response: outcome, expected_revision: body.expected_revision }, true);
      return json(200, {
        record: await serializeRecord(data, (await datasetColumns(Number(dataset.id))).filter((item: any) => item.sheet_name === data.sheet_name)),
        callback: await callbackPayload(data, dataset),
        changeHistory: await customerChangeHistory(Number(data.id)),
      });
    }
  }

  if (parts[0] === "import" && parts[1] === "start" && parts.length === 2 && method === "POST") {
    return json(201, await createImportedDataset(ctx, body));
  }
  if (parts[0] === "import" && parts[1] === "jobs" && parts.length === 4 && method === "POST" && ["batch", "commit"].includes(parts[3])) {
    return json(200, await stagedImport(ctx, parts[3], parts[2], body));
  }
  if (parts[0] === "import" && parts[1] === "datasets") {
    if (method === "POST") fail(409, "Reload CRM and inspect the workbook again to use the safe import workflow.");
    if (parts.length === 3 && method === "DELETE") {
      const dataset = await accessibleDataset(ctx, parts[2]);
      await deleteDataset(ctx, dataset);
      return json(204);
    }
  }

  if (parts[0] === "reminders") {
    if (parts.length === 1 && method === "GET") return json(200, { results: await listReminders(ctx) });
    if (parts.length === 1 && method === "POST") {
      const text = valueString(body.text);
      const at = new Date(String(body.reminder_at || ""));
      if (!text) fail(400, "Enter a reminder.", { errors: { text: ["Enter a reminder."] } });
      if (text.length > 500) fail(400, "Reminder text must be 500 characters or fewer.", { errors: { text: ["Ensure this field has no more than 500 characters."] } });
      if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) fail(400, "Choose a future date and time.", { errors: { reminder_at: ["Choose a future date and time."] } });
      const { data, error } = await adminClient.from("crm_reminders").insert({ owner_id: ctx.user.id, store_id: requireStoreContext(ctx), text, reminder_at: at.toISOString() }).select("*").single();
      checkDb(error);
      return json(201, { id: data.id, text: data.text, reminder_at: data.reminder_at, is_due: false, created_at: data.created_at, sent_at: data.sent_at, delivery_status: data.delivery_status, delivery_attempt_count: data.delivery_attempt_count, last_delivery_attempt_at: data.last_delivery_attempt_at, next_delivery_attempt_at: data.next_delivery_attempt_at, last_delivery_error: data.last_delivery_error });
    }
    if (parts.length === 2) {
      const id = parseId(parts[1]);
      let query = adminClient.from("crm_reminders").select("*").eq("id", id).eq("owner_id", ctx.user.id).eq("store_id", requireStoreContext(ctx));
      const { data: reminder, error: readError } = await query.maybeSingle();
      checkDb(readError);
      if (!reminder) fail(404, "Reminder not found.");
      if (method === "DELETE") {
        const { error } = await adminClient.from("crm_reminders").delete().eq("id", id).eq("owner_id", ctx.user.id);
        checkDb(error); return json(204);
      }
      if (method === "PATCH" || method === "PUT") {
        const text = body.text === undefined ? reminder.text : valueString(body.text);
        const at = body.reminder_at === undefined ? new Date(reminder.reminder_at) : new Date(String(body.reminder_at));
        if (!text || text.length > 500) fail(400, "Enter a reminder of 1 to 500 characters.", { errors: { text: ["Enter a reminder of 1 to 500 characters."] } });
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) fail(400, "Choose a future date and time.", { errors: { reminder_at: ["Choose a future date and time."] } });
        const changedTime = at.toISOString() !== new Date(reminder.reminder_at).toISOString();
        const changes: any = { text, reminder_at: at.toISOString() };
        if (changedTime) Object.assign(changes, { sent_at: null, delivery_status: "pending", delivery_attempt_count: 0, last_delivery_attempt_at: null, next_delivery_attempt_at: null, delivery_locked_at: null, last_delivery_error: "" });
        const { data, error } = await adminClient.from("crm_reminders").update(changes).eq("id", id).select("*").single();
        checkDb(error);
        return json(200, { ...data, is_due: false });
      }
    }
  }

  if (parts[0] === "push") {
    if (parts[1] === "config" && method === "GET") {
      if (!vapidPublicKey) fail(503, "Browser notifications are not configured on the server.");
      return json(200, { publicKey: vapidPublicKey });
    }
    if (parts[1] === "subscriptions") {
      if (method === "GET") {
        const { count, error } = await adminClient.from("crm_push_subscriptions").select("id", { count: "exact", head: true }).eq("owner_id", ctx.user.id);
        checkDb(error); return json(200, { enabled: (count || 0) > 0 });
      }
      if (method === "POST") {
        const endpoint = valueString(body.endpoint);
        const keys = body.keys || {};
        if (!endpoint || !valueString(keys.p256dh) || !valueString(keys.auth)) fail(400, "A valid browser push subscription is required.");
        const { error } = await adminClient.from("crm_push_subscriptions").upsert({ owner_id: ctx.user.id, endpoint, p256dh: keys.p256dh, auth: keys.auth }, { onConflict: "endpoint" });
        checkDb(error); return json(201, { enabled: true });
      }
      if (method === "DELETE") {
        const endpoint = valueString(body.endpoint);
        if (endpoint) {
          const { error } = await adminClient.from("crm_push_subscriptions").delete().eq("owner_id", ctx.user.id).eq("endpoint", endpoint);
          checkDb(error);
        }
        return json(204);
      }
    }
  }

  if (parts[0] === "task-notifications") {
    const columns = "id,task_id,submission_id,kind,title,message,created_at,read_at";
    const storeUsers = await accessibleStoreUserIds(ctx);
    const storeTasks = await fetchAll(() => adminClient.from("crm_assigned_tasks").select("id")
      .in("assignee_id", storeUsers?.length ? storeUsers : ["00000000-0000-0000-0000-000000000000"]));
    const taskIds = storeTasks.length ? storeTasks.map((task: any) => task.id) : [-1];
    if (parts.length === 1 && method === "GET") {
      const [notifications, unread] = await Promise.all([
        adminClient.from("crm_task_notifications").select(columns).eq("recipient_id", ctx.user.id).in("task_id", taskIds).order("id", { ascending: false }).limit(50),
        adminClient.from("crm_task_notifications").select("id", { count: "exact", head: true }).eq("recipient_id", ctx.user.id).in("task_id", taskIds).is("read_at", null),
      ]);
      checkDb(notifications.error); checkDb(unread.error);
      return json(200, { results: notifications.data || [], unread_count: unread.count || 0 });
    }
    if (parts.length === 2 && parts[1] === "read" && method === "POST") {
      const throughId = parseId(body.through_id);
      const { error } = await adminClient.from("crm_task_notifications").update({ read_at: new Date().toISOString() })
        .eq("recipient_id", ctx.user.id).in("task_id", taskIds).lte("id", throughId).is("read_at", null);
      checkDb(error); return json(204);
    }
    if (parts.length === 2 && method === "PATCH") {
      const id = parseId(parts[1]);
      const { data, error } = await adminClient.from("crm_task_notifications").update({ read_at: new Date().toISOString() })
        .eq("recipient_id", ctx.user.id).in("task_id", taskIds).eq("id", id).is("read_at", null).select(columns).maybeSingle();
      checkDb(error);
      if (data) return json(200, data);
      const existing = await adminClient.from("crm_task_notifications").select(columns).eq("recipient_id", ctx.user.id).in("task_id", taskIds).eq("id", id).maybeSingle();
      checkDb(existing.error); if (!existing.data) fail(404, "Notification not found.");
      return json(200, existing.data);
    }
    fail(404, "Notification endpoint not found.");
  }

  if (parts[0] === "tasks") {
    if (parts.length === 1 && method === "GET") {
      const tasks = await fetchAll(() => adminClient.from("crm_assigned_tasks").select("*").eq("assignee_id", ctx.user.id)
        .order("status").order("due_at").order("created_at", { ascending: false }).order("id", { ascending: false }));
      return json(200, { results: await serializeTasks(tasks) });
    }
    if (parts.length === 2 && method === "PATCH") {
      const id = parseId(parts[1]);
      const { data: current, error } = await adminClient.from("crm_assigned_tasks").select("id")
        .eq("id", id).eq("assignee_id", ctx.user.id).maybeSingle();
      checkDb(error); if (!current) fail(404, "Task not found.");
      const values: any = {};
      if (body.status !== undefined) values.status = valueString(body.status);
      if (body.submission_note !== undefined) values.submission_note = valueString(body.submission_note);
      if (body.previous_submission_id !== undefined) values.previous_submission_id = body.previous_submission_id;
      await requireTaskImageUploads(ctx, files, thumbnails);
      const data = await saveTaskPhotos(adminClient, ctx.user.id, id, "completion", values, files, thumbnails);
      return json(200, await serializeTask(data));
    }
  }

  if (parts[0] === "targets" && parts.length === 1 && method === "GET") {
    return json(200, { results: await listTargets(ctx, ctx.user.id) });
  }

  if (parts[0] === "sales") {
    if (parts[1] === "report" && parts.length === 2 && method === "GET") {
      const { data, error } = await adminClient.rpc("crm_sales_report", { p_store: requireStoreContext(ctx), p_owner: isAdminRole(ctx.profile.role) ? null : ctx.user.id, p_today: indiaDate() });
      checkDb(error); return json(200,data);
    }
    if (parts[1] === "summary" && method === "GET") {
      const { data, error } = await adminClient.rpc("crm_visit_summary", { p_store: requireStoreContext(ctx), p_owner: isAdminRole(ctx.profile.role) ? null : ctx.user.id, p_today: indiaDate() });
      checkDb(error); return json(200,data.sales);
    }
    if (parts[1] === "clients" && method === "GET") {
      const dataset = await accessibleDataset(ctx, params.get("dataset") || "");
      const query = valueString(params.get("q"));
      const page = positiveQueryId(params.get("page") || "1");
      if (query.length > 500 || page > 1000000) fail(400, "Invalid client query.");
      const selected = params.get("selected");
      const { data, error } = await adminClient.rpc("crm_sales_client_page", { p_dataset: Number(dataset.id), p_query: query, p_page: page, p_selected: selected ? positiveQueryId(selected) : null });
      checkDb(error);
      const records = [...(data?.records || [])];
      if (data?.selected && !records.some((record: any) => record.id === data.selected.id)) records.unshift(data.selected);
      return json(200, { results: records.map((record: any) => ({ id: record.id, label: record.search_name || `Customer row ${record.row_number}`, sheetName: record.sheet_name, rowNumber: record.row_number })), pagination: data?.pagination });
    }
    if (parts[1] === "visits" && parts.length === 2) {
      if (method === "GET") {
        const status = valueString(params.get("status"));
        const validStatus = ["healthy", "follow_up_required", "interested", "not_interested", "converted"].includes(status) ? status : "";
        const filters: any = { status: validStatus, q: valueString(params.get("q")), dataset_name: valueString(params.get("dataset_name")), payment_status: valueString(params.get("payment_status")), date_from: valueString(params.get("date_from")), date_to: valueString(params.get("date_to")) };
        const page = positiveQueryId(params.get("page") || "1");
        if (filters.q.length > 500 || filters.dataset_name.length > 500 || page > 1000000 || (filters.payment_status && !["not_paid", "partially_paid", "completed", "one_time"].includes(filters.payment_status))) fail(400, "Invalid sales query.");
        for (const field of ["date_from", "date_to"]) if (filters[field] && (!/^\d{4}-\d{2}-\d{2}$/.test(filters[field]) || !Number.isFinite(Date.parse(filters[field])) || new Date(filters[field]).toISOString().slice(0, 10) !== filters[field])) fail(400, "Invalid visit date.");
        const { data, error } = await adminClient.rpc("crm_sales_visit_page", { p_store: requireStoreContext(ctx), p_owner: isAdminRole(ctx.profile.role) ? null : ctx.user.id, p_filters: filters, p_page: page });
        checkDb(error);
        return json(200, { results: await serializeVisitList(data?.records || []), pagination: data?.pagination });
      }
      if (method === "POST") return json(201, await createOrUpdateVisit(ctx, null, body, files, thumbnails));
    }
    if (parts[1] === "visits" && parts.length === 3) {
      const visit = await visibleVisit(ctx, parseId(parts[2]));
      if (method === "GET") return json(200, await serializeVisit(visit, true));
      if (method === "PATCH") return json(200, await createOrUpdateVisit(ctx, Number(visit.id), body, files, thumbnails));
      if (method === "DELETE") {
        const { data: images, error: imageError } = await adminClient.from("crm_visit_images").select("storage_path,thumbnail_path").eq("visit_id", visit.id);
        checkDb(imageError);
        const { error } = await adminClient.from("crm_visits").delete().eq("id", visit.id);
        checkDb(error);
        if (images?.length) {
          const { error: cleanupError } = await adminClient.storage.from("crm-visit-images").remove(images.flatMap((item: any) => [item.storage_path, item.thumbnail_path].filter(Boolean)));
          if (cleanupError) console.error("Deleted visit photo cleanup failed:", cleanupError.message);
        }
        return json(204);
      }
    }
  }

  if (parts[0] === "overtime") return await handleOvertime(ctx, method, parts, body);
  if (parts[0] === "admin") return await handleAdmin(ctx, method, parts, params, body, files, thumbnails);
  if (parts[0] === "attendance") return await handleAttendance(ctx, method, parts, params, body);
  fail(404, "CRM API endpoint not found.");
}

function payrollMonthBounds(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) fail(400, "Choose a valid payroll month.");
  const start = value + "-01";
  const date = new Date(start + "T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.toISOString().slice(0, 10) };
}

function payrollAmount(value: any, label: string, optional = true) {
  const text = valueString(value);
  if (!text && optional) return 0;
  const amount = Number(text);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isFinite(amount) || amount > 100000000000) fail(400, `Enter a valid ${label} amount.`);
  return amount;
}

async function payrollAudit(ctx: Context, storeId: string, entityType: string, entityId: string | null, action: string, details: any = {}, paymentId: string | null = null) {
  const { error } = await adminClient.from("crm_payroll_audit").insert({ store_id: storeId, entity_type: entityType, entity_id: entityId, payment_id: paymentId, action, details, actor_id: ctx.user.id });
  checkDb(error);
}

async function payrollEmployees(storeId: string) {
  const { data, error } = await adminClient.from("profiles").select("id,name,employee_id,designation,active").eq("store_id", storeId).eq("role", "employee").eq("active", true).order("name");
  checkDb(error);
  return data || [];
}

async function payrollPaymentPayload(payment: any) {
  const { data: employee, error } = await adminClient.from("profiles").select("id,name,employee_id,designation").eq("id", payment.employee_id).maybeSingle();
  checkDb(error);
  const netAmount = Math.max(0, Number(payment.net_amount || 0));
  const paidAmount = Math.min(netAmount, Math.max(0, Number(payment.paid_amount || 0)));
  return {
    ...payment,
    paid_amount: paidAmount,
    remaining_amount: Math.max(0, netAmount - paidAmount),
    employee_name: employee?.name || "Employee",
    employee_code: employee?.employee_id || "",
    employee_designation: employee?.designation || "",
  };
}

async function payrollEmployeePayload(item: any) {
  const { data: employee, error } = await adminClient.from("profiles").select("name,employee_id").eq("id", item.employee_id).maybeSingle();
  checkDb(error);
  return { ...item, employee_name: employee?.name || "Employee", employee_code: employee?.employee_id || "" };
}

async function inheritedPayrollBankDetails(storeId: string, employeeId: string) {
  const { data, error } = await adminClient.from("crm_salary_structures")
    .select("bank_account_holder,bank_name,bank_account_number,bank_ifsc")
    .eq("store_id", storeId).eq("employee_id", employeeId)
    .order("effective_from", { ascending: false }).limit(1).maybeSingle();
  checkDb(error);
  return data || {};
}

async function createAutomaticPayrollPayment(ctx: Context, storeId: string, body: any) {
  requireAdmin(ctx);
  const computed = await calculatePayroll(ctx, storeId, valueString(body.employee_id), valueString(body.payroll_month));
  const bonus = payrollAmount(body.bonus_amount, "bonus");
  const deduction = payrollAmount(body.deduction_amount, "deduction");
  const advanceRecovery = Math.min(payrollAmount(body.advance_recovery, "advance recovery"), computed.advances.reduce((sum: number, item: any) => sum + Number(item.remaining_amount), 0));
  const enteredSalesExpense = valueString(body.sales_expense_amount);
  const salesExpenseAmount = enteredSalesExpense ? payrollAmount(enteredSalesExpense, "sales expense") : Number(computed.sales_expense_amount || 0);
  const reimbursementAmount = Number(computed.expense_claim_amount || 0) + salesExpenseAmount;
  const enteredAllowance = valueString(body.allowance_amount);
  const allowanceAmount = enteredAllowance ? payrollAmount(enteredAllowance, "allowance") : Number(computed.salary.allowance_amount || computed.settings?.default_allowance_amount || 0);
  const enteredOvertimeHours = valueString(body.overtime_hours);
  const overtimeHours = enteredOvertimeHours ? payrollAmount(enteredOvertimeHours, "overtime hours") : Number(computed.overtime_hours || 0);
  if (overtimeHours > 744) fail(400, "Overtime hours cannot exceed 744 for one month.");
  // The store-wide Payroll Settings rate is authoritative. Payroll processing
  // may correct approved hours, but cannot silently replace the configured rate.
  const overtimeRate = Number(computed.overtime_rate || 0);
  const overtimeAmount = Math.round(overtimeHours * overtimeRate * 100) / 100;
  const gross = Number(computed.salary.basic_salary) + allowanceAmount + overtimeAmount + reimbursementAmount + bonus;
  const net = gross - computed.lop_deduction - deduction - advanceRecovery;
  if (net < 0) fail(400, "Deductions cannot exceed calculated earnings.");
  const requestedStatus = valueString(body.status || "draft");
  if (!["draft", "submitted", "approved"].includes(requestedStatus)) fail(400, "Choose Draft, Submitted, or Approved.");
  // Direct Admin finalization is stored as submitted inside the atomic creation
  // transaction, then immediately finalized and audited before responding.
  const status = requestedStatus === "approved" ? "submitted" : requestedStatus;
  const calculation = {
    ...computed, salary: undefined, employee: undefined, advances: undefined,
    sales_expense_auto_amount: computed.sales_expense_amount,
    sales_expense_amount: salesExpenseAmount,
    allowance_amount: allowanceAmount,
    overtime_hours: overtimeHours,
    overtime_rate: overtimeRate,
    overtime_amount: overtimeAmount,
    reimbursement_amount: reimbursementAmount,
    reimbursement_claims: (computed.reimbursement_claims || []).map((item: any) => item.id),
    sales_visit_expenses: (computed.sales_visit_expenses || []).map((item: any) => item.id),
  };
  const paymentInput = {
    store_id: storeId, employee_id: computed.employee.id, payroll_month: computed.start,
    salary_structure_id: computed.salary.id, basic_salary: computed.salary.basic_salary,
    allowance_amount: allowanceAmount, gross_amount: gross, bonus_amount: bonus,
    overtime_hours: overtimeHours, overtime_rate: overtimeRate,
    overtime_amount: overtimeAmount, reimbursement_amount: reimbursementAmount,
    expense_claim_amount: computed.expense_claim_amount, sales_expense_amount: salesExpenseAmount,
    lop_deduction: computed.lop_deduction, deduction_amount: deduction,
    advance_recovery: advanceRecovery, net_amount: net, paid_amount: 0, remaining_amount: net,
    present_days: computed.present_days, absent_days: computed.absent_days,
    paid_leave_days: computed.paid_leave_days, unpaid_leave_days: computed.unpaid_leave_days,
    calculation, payment_date: valueString(body.payment_date) || null,
    payment_method: valueString(body.payment_method || "bank_transfer"),
    reference_number: valueString(body.reference_number), notes: valueString(body.notes),
    status, created_by: ctx.user.id,
  };
  // New installations use the atomic database function. The narrowly scoped
  // fallback keeps already-running installations compatible until this
  // migration is explicitly applied; every other database failure is surfaced.
  const advanceRepayments: { advance_id: string; amount: number }[] = [];
  let recoveryForPayload = advanceRecovery;
  for (const advance of computed.advances || []) {
    if (recoveryForPayload <= 0) break;
    const amount = Math.min(recoveryForPayload, Number(advance.remaining_amount));
    advanceRepayments.push({ advance_id: advance.id, amount });
    recoveryForPayload -= amount;
  }
  const { data: atomicPayment, error: atomicError } = await adminClient.rpc("crm_create_payroll_payment", {
    p_store_id: storeId, p_actor_id: ctx.user.id,
    p_payment: { ...paymentInput, audit_details: { month: computed.month, net, allowance_amount: allowanceAmount, overtime_hours_auto: computed.overtime_hours, overtime_hours: overtimeHours, overtime_rate: overtimeRate, sales_expense_auto_amount: computed.sales_expense_amount, sales_expense_amount: salesExpenseAmount } },
    p_expense_claim_ids: (computed.reimbursement_claims || []).map((claim: any) => claim.id),
    p_visit_ids: (computed.sales_visit_expenses || []).map((visit: any) => visit.id),
    p_advance_repayments: advanceRepayments,
  });
  if (!atomicError) {
    if (requestedStatus !== "approved") return json(201, { payment: await payrollPaymentPayload(atomicPayment) });
    const finalizedAt = new Date().toISOString();
    const { data: finalized, error: finalizeError } = await adminClient.from("crm_payroll_payments").update({ status: "approved", approved_by: ctx.user.id, approved_at: finalizedAt, finalized_by: ctx.user.id, finalized_at: finalizedAt, updated_at: finalizedAt }).eq("id", atomicPayment.id).select("*").single();
    checkDb(finalizeError);
    await payrollAudit(ctx, storeId, "payment", finalized.id, "approved", { month: computed.month, net }, finalized.id);
    return json(201, { payment: await payrollPaymentPayload(finalized) });
  }
  // PostgREST reports an unavailable RPC as PGRST202. PostgreSQL returns
  // 42883 when invoked before schema-cache refresh. Do not hide other errors.
  if (atomicError.code !== "PGRST202" && atomicError.code !== "42883") checkDb(atomicError);
  const { data, error } = await adminClient.from("crm_payroll_payments").insert(paymentInput).select("*").single();
  checkDb(error);
  for (const claim of computed.reimbursement_claims || []) {
    const { error: linkError } = await adminClient.from("crm_payroll_expense_reimbursements").insert({ payment_id: data.id, expense_claim_id: claim.id, amount: claim.amount });
    checkDb(linkError);
    const { error: claimError } = await adminClient.from("crm_expense_claims").update({ reimbursed_payment_id: data.id, updated_at: new Date().toISOString() }).eq("id", claim.id).is("reimbursed_payment_id", null);
    checkDb(claimError);
  }
  for (const visit of computed.sales_visit_expenses || []) {
    const { error: visitError } = await adminClient.from("crm_payroll_visit_expenses").insert({ payment_id: data.id, visit_id: visit.id, amount: visit.expense });
    checkDb(visitError);
  }
  let remainingRecovery = advanceRecovery;
  for (const advance of computed.advances || []) {
    if (remainingRecovery <= 0) break;
    const recovered = Math.min(remainingRecovery, Number(advance.remaining_amount));
    const { error: repaymentError } = await adminClient.from("crm_payroll_advance_repayments").insert({ payment_id: data.id, advance_id: advance.id, amount: recovered });
    checkDb(repaymentError);
    const next = Number(advance.remaining_amount) - recovered;
    const { error: advanceError } = await adminClient.from("crm_salary_advances").update({ remaining_amount: next, status: next <= 0 ? "closed" : "approved", updated_at: new Date().toISOString() }).eq("id", advance.id);
    checkDb(advanceError);
    remainingRecovery -= recovered;
  }
  await payrollAudit(ctx, storeId, "payment", data.id, status === "submitted" ? "submitted" : "created", { month: computed.month, net, allowance_amount: allowanceAmount, overtime_hours_auto: computed.overtime_hours, overtime_hours: overtimeHours, overtime_rate: overtimeRate, sales_expense_auto_amount: computed.sales_expense_amount, sales_expense_amount: salesExpenseAmount });
  if (requestedStatus !== "approved") return json(201, { payment: await payrollPaymentPayload(data) });
  const finalizedAt = new Date().toISOString();
  const { data: finalized, error: finalizeError } = await adminClient.from("crm_payroll_payments").update({ status: "approved", approved_by: ctx.user.id, approved_at: finalizedAt, finalized_by: ctx.user.id, finalized_at: finalizedAt, updated_at: finalizedAt }).eq("id", data.id).select("*").single();
  checkDb(finalizeError);
  await payrollAudit(ctx, storeId, "payment", finalized.id, "approved", { month: computed.month, net }, finalized.id);
  return json(201, { payment: await payrollPaymentPayload(finalized) });
}

async function updatePayrollPayment(ctx: Context, storeId: string, paymentId: string, body: any) {
  requireAdmin(ctx);
  const { data: current, error: readError } = await adminClient.from("crm_payroll_payments").select("*").eq("id", paymentId).eq("store_id", storeId).maybeSingle();
  checkDb(readError);
  if (!current) fail(404, "Payroll record not found.");
  if (!["draft", "submitted", "rejected"].includes(current.status)) fail(400, "Only draft, submitted, or rejected payroll can be edited.");
  const status = valueString(body.status || "draft");
  if (!['draft', 'submitted', 'approved'].includes(status)) fail(400, "Choose Draft, Submitted, or Approved.");
  const returnedPayroll = current.status === "rejected"
    ? await calculatePayroll(ctx, storeId, current.employee_id, String(current.payroll_month).slice(0, 7))
    : null;
  const bonus = payrollAmount(body.bonus_amount, "bonus");
  const deduction = payrollAmount(body.deduction_amount, "deduction");
  const salesExpense = payrollAmount(body.sales_expense_amount, "sales expense");
  const requestedRecovery = payrollAmount(body.advance_recovery, "advance recovery");
  const { data: oldRepayments, error: repaymentReadError } = await adminClient.from("crm_payroll_advance_repayments").select("advance_id,amount").eq("payment_id", current.id);
  checkDb(repaymentReadError);
  for (const repayment of oldRepayments || []) {
    const { data: advance, error: advanceReadError } = await adminClient.from("crm_salary_advances").select("remaining_amount").eq("id", repayment.advance_id).maybeSingle();
    checkDb(advanceReadError);
    if (advance) { const { error } = await adminClient.from("crm_salary_advances").update({ remaining_amount: Number(advance.remaining_amount) + Number(repayment.amount), status: "approved", updated_at: new Date().toISOString() }).eq("id", repayment.advance_id); checkDb(error); }
  }
  const { error: repaymentDeleteError } = await adminClient.from("crm_payroll_advance_repayments").delete().eq("payment_id", current.id);
  checkDb(repaymentDeleteError);
  const { data: advances, error: advancesError } = await adminClient.from("crm_salary_advances").select("id,remaining_amount").eq("store_id", storeId).eq("employee_id", current.employee_id).eq("status", "approved").gt("remaining_amount", 0).order("created_at");
  checkDb(advancesError);
  let advanceRecovery = Math.min(requestedRecovery, (advances || []).reduce((sum: number, item: any) => sum + Number(item.remaining_amount), 0));
  const basicSalary = Number(returnedPayroll?.salary?.basic_salary ?? current.basic_salary);
  const enteredAllowance = valueString(body.allowance_amount);
  const allowanceAmount = enteredAllowance ? payrollAmount(enteredAllowance, "allowance") : Number(returnedPayroll?.salary?.allowance_amount || returnedPayroll?.settings?.default_allowance_amount || current.allowance_amount || 0);
  const enteredOvertimeHours = valueString(body.overtime_hours);
  const overtimeHours = enteredOvertimeHours ? payrollAmount(enteredOvertimeHours, "overtime hours") : Number(returnedPayroll?.overtime_hours ?? current.overtime_hours);
  if (overtimeHours > 744) fail(400, "Overtime hours cannot exceed 744 for one month.");
  // Preserve the payroll's configured rate snapshot unless a rejected payroll
  // is recalculated, in which case the latest Payroll Settings rate is used.
  const overtimeRate = Number(returnedPayroll?.overtime_rate ?? current.overtime_rate ?? 0);
  const overtimeAmount = Math.round(overtimeHours * overtimeRate * 100) / 100;
  const expenseClaimAmount = Number(returnedPayroll?.expense_claim_amount ?? current.expense_claim_amount);
  const lopDeduction = Number(returnedPayroll?.lop_deduction ?? current.lop_deduction);
  const gross = basicSalary + allowanceAmount + overtimeAmount + expenseClaimAmount + salesExpense + bonus;
  const net = gross - lopDeduction - deduction - advanceRecovery;
  if (net < 0) fail(400, "Deductions cannot exceed calculated earnings.");
  let remainingRecovery = advanceRecovery;
  for (const advance of advances || []) {
    if (remainingRecovery <= 0) break;
    const recovered = Math.min(remainingRecovery, Number(advance.remaining_amount));
    const next = Number(advance.remaining_amount) - recovered;
    const { error: repaymentError } = await adminClient.from("crm_payroll_advance_repayments").insert({ payment_id: current.id, advance_id: advance.id, amount: recovered }); checkDb(repaymentError);
    const { error: advanceError } = await adminClient.from("crm_salary_advances").update({ remaining_amount: next, status: next <= 0 ? "closed" : "approved", updated_at: new Date().toISOString() }).eq("id", advance.id); checkDb(advanceError);
    remainingRecovery -= recovered;
  }
  const previousCalculation = current.calculation && typeof current.calculation === "object" ? current.calculation : {};
  const calculationBasis = returnedPayroll ? { ...returnedPayroll, salary: undefined, employee: undefined, advances: undefined, reimbursement_claims: (returnedPayroll.reimbursement_claims || []).map((item: any) => item.id), sales_visit_expenses: (returnedPayroll.sales_visit_expenses || []).map((item: any) => item.id) } : previousCalculation;
  const calculation = { ...calculationBasis, allowance_amount: allowanceAmount, overtime_hours: overtimeHours, overtime_rate: overtimeRate, overtime_amount: overtimeAmount, sales_expense_amount: salesExpense, reimbursement_amount: expenseClaimAmount + salesExpense, advance_recovery: advanceRecovery, bonus_amount: bonus, deduction_amount: deduction, net_amount: net };
  const refreshedValues = returnedPayroll ? {
    salary_structure_id: returnedPayroll.salary.id, basic_salary: basicSalary, allowance_amount: allowanceAmount,
    overtime_hours: overtimeHours, overtime_rate: overtimeRate, overtime_amount: overtimeAmount,
    expense_claim_amount: expenseClaimAmount, lop_deduction: lopDeduction,
    present_days: returnedPayroll.present_days, absent_days: returnedPayroll.absent_days,
    paid_leave_days: returnedPayroll.paid_leave_days, unpaid_leave_days: returnedPayroll.unpaid_leave_days,
  } : {};
  const finalizedAt = status === "approved" ? new Date().toISOString() : null;
  const finalizationValues = status === "approved" ? { approved_by: ctx.user.id, approved_at: finalizedAt, finalized_by: ctx.user.id, finalized_at: finalizedAt } : {};
  const { data, error } = await adminClient.from("crm_payroll_payments").update({ ...refreshedValues, ...finalizationValues, allowance_amount: allowanceAmount, overtime_hours: overtimeHours, overtime_rate: overtimeRate, overtime_amount: overtimeAmount, bonus_amount: bonus, deduction_amount: deduction, advance_recovery: advanceRecovery, sales_expense_amount: salesExpense, reimbursement_amount: expenseClaimAmount + salesExpense, gross_amount: gross, net_amount: net, remaining_amount: Math.max(0, net - Number(current.paid_amount || 0)), calculation, payment_date: valueString(body.payment_date) || current.payment_date, payment_method: valueString(body.payment_method) || current.payment_method, reference_number: valueString(body.reference_number), notes: valueString(body.notes), status, updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single();
  checkDb(error);
  if (returnedPayroll) {
    for (const claim of returnedPayroll.reimbursement_claims || []) {
      const { error: linkError } = await adminClient.from("crm_payroll_expense_reimbursements").insert({ payment_id: current.id, expense_claim_id: claim.id, amount: claim.amount });
      checkDb(linkError);
      const { error: claimError } = await adminClient.from("crm_expense_claims").update({ reimbursed_payment_id: current.id, updated_at: new Date().toISOString() }).eq("id", claim.id).is("reimbursed_payment_id", null);
      checkDb(claimError);
    }
    for (const visit of returnedPayroll.sales_visit_expenses || []) {
      const { error: visitError } = await adminClient.from("crm_payroll_visit_expenses").insert({ payment_id: current.id, visit_id: visit.id, amount: visit.expense });
      checkDb(visitError);
    }
  }
  await payrollAudit(ctx, storeId, "payment", data.id, status === "approved" ? "approved" : "updated", { allowance_amount: allowanceAmount, overtime_hours: overtimeHours, overtime_rate: overtimeRate, bonus, deduction, sales_expense: salesExpense, advance_recovery: advanceRecovery, status }, data.id);
  return json(200, { payment: await payrollPaymentPayload(data) });
}

async function rejectPayrollPayment(ctx: Context, storeId: string, paymentId: string, body: any) {
  requireAdmin(ctx);
  const { data: current, error: readError } = await adminClient.from("crm_payroll_payments").select("*").eq("id", paymentId).eq("store_id", storeId).maybeSingle();
  checkDb(readError);
  if (!current || current.status !== "submitted") fail(400, "Only submitted payroll can be rejected.");
  const [{ data: reimbursements, error: reimbursementError }, { data: repayments, error: repaymentError }] = await Promise.all([
    adminClient.from("crm_payroll_expense_reimbursements").select("expense_claim_id").eq("payment_id", current.id),
    adminClient.from("crm_payroll_advance_repayments").select("advance_id,amount").eq("payment_id", current.id),
  ]);
  checkDb(reimbursementError); checkDb(repaymentError);
  for (const item of reimbursements || []) {
    const { error } = await adminClient.from("crm_expense_claims").update({ reimbursed_payment_id: null, updated_at: new Date().toISOString() }).eq("id", item.expense_claim_id).eq("reimbursed_payment_id", current.id);
    checkDb(error);
  }
  for (const item of repayments || []) {
    const { data: advance, error: advanceError } = await adminClient.from("crm_salary_advances").select("remaining_amount").eq("id", item.advance_id).maybeSingle();
    checkDb(advanceError);
    if (advance) {
      const { error } = await adminClient.from("crm_salary_advances").update({ remaining_amount: Number(advance.remaining_amount) + Number(item.amount), status: "approved", updated_at: new Date().toISOString() }).eq("id", item.advance_id);
      checkDb(error);
    }
  }
  const [{ error: expenseDeleteError }, { error: visitDeleteError }, { error: repaymentDeleteError }] = await Promise.all([
    adminClient.from("crm_payroll_expense_reimbursements").delete().eq("payment_id", current.id),
    adminClient.from("crm_payroll_visit_expenses").delete().eq("payment_id", current.id),
    adminClient.from("crm_payroll_advance_repayments").delete().eq("payment_id", current.id),
  ]);
  checkDb(expenseDeleteError); checkDb(visitDeleteError); checkDb(repaymentDeleteError);
  const { data, error } = await adminClient.from("crm_payroll_payments").update({ status: "rejected", notes: [current.notes, valueString(body.note)].filter(Boolean).join("\n"), updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single();
  checkDb(error);
  await payrollAudit(ctx, storeId, "payment", data.id, "rejected", { note: valueString(body.note) }, data.id);
  return json(200, { payment: await payrollPaymentPayload(data) });
}

async function calculatePayroll(ctx: Context, storeId: string, employeeId: string, month: string) {
  const { start, end } = payrollMonthBounds(month);
  const [{ data: employee, error: employeeError }, { data: settings, error: settingsError }] = await Promise.all([
    adminClient.from("profiles").select("id,name,employee_id,store_id,active").eq("id", employeeId).eq("store_id", storeId).eq("role", "employee").maybeSingle(),
    adminClient.from("crm_payroll_settings").select("*").eq("store_id", storeId).maybeSingle(),
  ]);
  checkDb(employeeError); checkDb(settingsError);
  if (!employee?.active) fail(400, "Choose an active employee in this store.");
  const { data: salary, error: salaryError } = await adminClient.from("crm_salary_structures").select("*").eq("store_id", storeId).eq("employee_id", employeeId).lt("effective_from", end).order("effective_from", { ascending: false }).limit(1).maybeSingle();
  checkDb(salaryError);
  if (!salary) fail(400, "Set the employee salary structure before calculating payroll.");
  const [attendanceRows, leaves, overtime, expenseClaims, advances, salesVisits] = await Promise.all([
    fetchAll(() => adminClient.from("attendance_records").select("punched_at").eq("user_id", employeeId).gte("punched_at", start + "T00:00:00+05:30").lt("punched_at", end + "T00:00:00+05:30")),
    fetchAll(() => adminClient.from("attendance_leave_days").select("leave_date,leave_type").eq("user_id", employeeId).gte("leave_date", start).lt("leave_date", end)),
    fetchAll(() => adminClient.from("crm_overtime_requests").select("approved_minutes").eq("employee_id", employeeId).eq("status", "approved").gte("work_date", start).lt("work_date", end)),
    fetchAll(() => adminClient.from("crm_expense_claims").select("id,amount").eq("store_id", storeId).eq("employee_id", employeeId).eq("status", "approved").eq("reimbursable", true).is("reimbursed_payment_id", null).gte("expense_date", start).lt("expense_date", end)),
    fetchAll(() => adminClient.from("crm_salary_advances").select("id,remaining_amount").eq("store_id", storeId).eq("employee_id", employeeId).eq("status", "approved").gt("remaining_amount", 0).order("created_at")),
    fetchAll(() => adminClient.from("crm_visits").select("id,expense").eq("store_id", storeId).eq("owner_id", employeeId).gt("expense", 0).gte("visit_date", start).lt("visit_date", end)),
  ]);
  const visitIds = (salesVisits || []).map((visit: any) => visit.id);
  const reimbursedVisitIds = visitIds.length ? new Set((await fetchAll(() => adminClient.from("crm_payroll_visit_expenses").select("visit_id").in("visit_id", visitIds))).map((row: any) => row.visit_id)) : new Set<number>();
  const eligibleSalesVisits = (salesVisits || []).filter((visit: any) => !reimbursedVisitIds.has(visit.id));
  // For an in-progress month, future dates cannot be treated as absences or LOP.
  const todayValue = indiaDate();
  const currentMonth = todayValue.slice(0, 7);
  const tomorrow = new Date(todayValue + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const attendanceEnd = month < currentMonth ? end : month === currentMonth ? tomorrow.toISOString().slice(0, 10) : start;
  const workDays: string[] = [];
  for (let day = new Date(start + "T00:00:00Z"); day < new Date(attendanceEnd + "T00:00:00Z"); day.setUTCDate(day.getUTCDate() + 1)) if (day.getUTCDay() !== 0) workDays.push(day.toISOString().slice(0, 10));
  const evaluatedDays = new Set(workDays);
  // Punches are stored as timestamps. Convert them to the CRM's India
  // calendar day before comparing them with payroll dates; slicing a UTC
  // timestamp would otherwise put late-evening punches into the prior day.
  const present = new Set((attendanceRows || []).map((row: any) => indiaDate(new Date(row.punched_at))).filter((day: string) => evaluatedDays.has(day)));
  const paidLeave = new Set((leaves || []).filter((row: any) => row.leave_type === "paid" && evaluatedDays.has(row.leave_date)).map((row: any) => row.leave_date));
  const unpaidLeave = new Set((leaves || []).filter((row: any) => row.leave_type === "unpaid" && evaluatedDays.has(row.leave_date)).map((row: any) => row.leave_date));
  const absentDays = workDays.filter((day) => !present.has(day) && !paidLeave.has(day) && !unpaidLeave.has(day)).length;
  const overtimeHours = Math.round((overtime || []).reduce((sum: number, row: any) => sum + Number(row.approved_minutes || 0), 0) / 60 * 100) / 100;
  const expenseClaimAmount = (expenseClaims || []).reduce((sum: number, row: any) => sum + Number(row.amount || 0), 0);
  const salesExpenseAmount = eligibleSalesVisits.reduce((sum: number, row: any) => sum + Number(row.expense || 0), 0);
  const reimbursementAmount = expenseClaimAmount + salesExpenseAmount;
  const base = Number(salary.basic_salary || 0);
  const unpaidDays = unpaidLeave.size + absentDays;
  const divisor = Number(settings?.payroll_days_per_month || 26);
  const lopDeduction = Math.round((base / divisor) * unpaidDays * 100) / 100;
  const payrollSettings = settings || { payroll_days_per_month: 26, paid_leave_allowance: 0, default_allowance_amount: 0, default_overtime_rate: 0 };
  const overtimeRate = Number(payrollSettings.default_overtime_rate || 0);
  const overtimeAmount = Math.round(overtimeHours * overtimeRate * 100) / 100;
  return { employee, salary, settings: payrollSettings, month, start, end, present_days: present.size, absent_days: absentDays, paid_leave_days: paidLeave.size, unpaid_leave_days: unpaidLeave.size, overtime_hours: overtimeHours, overtime_rate: overtimeRate, overtime_amount: overtimeAmount, expense_claim_amount: expenseClaimAmount, sales_expense_amount: salesExpenseAmount, reimbursement_amount: reimbursementAmount, reimbursement_claims: expenseClaims || [], sales_visit_expenses: eligibleSalesVisits, advances: advances || [], lop_deduction: lopDeduction };
}

async function handlePayroll(ctx: Context, method: string, parts: string[], params: URLSearchParams, body: any) {
  const storeId = requireStoreContext(ctx);
  const admin = isAdminRole(ctx.profile.role);
  const superAdmin = isSuperAdmin(ctx);
  const section = parts[1] || "";
  if (section === "store-data" && method === "DELETE") {
    requireSuperAdmin(ctx);
    const { data, error } = await adminClient.rpc("crm_clear_payroll_store", {
      p_actor: ctx.user.id,
      p_store: storeId,
    });
    if (error?.code === "42501") fail(403, "Only an active Super Admin can clear payroll data.");
    if (error?.code === "P0002") fail(404, "Store not found.");
    checkDb(error);
    return json(200, data);
  }
  if (section === "employees" && method === "GET") { requireAdmin(ctx); return json(200, { results: await payrollEmployees(storeId) }); }
  if (section === "settings") {
    if (method === "GET") { requireAdmin(ctx); const { data, error } = await adminClient.from("crm_payroll_settings").select("*").eq("store_id", storeId).maybeSingle(); checkDb(error); return json(200, data || { payroll_days_per_month: 26, paid_leave_allowance: 0, default_allowance_amount: 0, default_overtime_rate: 0 }); }
    if (method === "PATCH") { requireAdmin(ctx); const values = { payroll_days_per_month: payrollAmount(body.payroll_days_per_month, "payroll days", false), paid_leave_allowance: payrollAmount(body.paid_leave_allowance, "paid leave allowance"), default_allowance_amount: payrollAmount(body.default_allowance_amount, "default allowance"), default_overtime_rate: payrollAmount(body.default_overtime_rate, "OT rate per hour"), updated_by: ctx.user.id, updated_at: new Date().toISOString() }; if (values.payroll_days_per_month <= 0 || values.payroll_days_per_month > 31) fail(400, "Payroll days must be between 1 and 31."); const { data, error } = await adminClient.from("crm_payroll_settings").upsert({ store_id: storeId, ...values }).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "settings", null, "updated", values); return json(200, data); }
  }
  if (section === "salary-structures") {
    if (method === "GET") { requireAdmin(ctx); const { data, error } = await adminClient.from("crm_salary_structures").select("*").eq("store_id", storeId).order("effective_from", { ascending: false }); checkDb(error); return json(200, { results: data || [] }); }
    if (method === "POST") {
      requireAdmin(ctx);
      const employeeId = valueString(body.employee_id);
      const effectiveFrom = valueString(body.effective_from);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) fail(400, "Choose an effective date.");
      const employee = (await payrollEmployees(storeId)).find((item: any) => item.id === employeeId);
      if (!employee) fail(400, "Choose an active employee in this store.");
      const inheritedBank = await inheritedPayrollBankDetails(storeId, employeeId);
      const { data: existing, error: existingError } = await adminClient.from("crm_salary_structures")
        .select("id").eq("store_id", storeId).eq("employee_id", employeeId).eq("effective_from", effectiveFrom).maybeSingle();
      checkDb(existingError);
      const bankAccountNumber = valueString(body.bank_account_number) || inheritedBank.bank_account_number || "";
      if (bankAccountNumber && !/^\d{1,80}$/.test(bankAccountNumber)) {
        fail(400, "Enter a valid bank account number.", { errors: { bank_account_number: ["Account number must contain numbers only."] } });
      }
      const values = {
        store_id: storeId,
        employee_id: employeeId,
        effective_from: effectiveFrom,
        basic_salary: payrollAmount(body.basic_salary, "basic salary", false),
        allowance_amount: payrollAmount(body.allowance_amount, "allowance"),
        overtime_rate: payrollAmount(body.overtime_rate, "overtime rate"),
        bank_account_holder: valueString(body.bank_account_holder) || inheritedBank.bank_account_holder || "",
        bank_name: valueString(body.bank_name) || inheritedBank.bank_name || "",
        bank_account_number: bankAccountNumber,
        bank_ifsc: valueString(body.bank_ifsc) || inheritedBank.bank_ifsc || "",
        notes: valueString(body.notes),
        created_by: ctx.user.id,
      };
      const query = existing
        ? adminClient.from("crm_salary_structures").update(values).eq("id", existing.id)
        : adminClient.from("crm_salary_structures").insert(values);
      const { data, error } = await query.select("*").single();
      checkDb(error);
      await payrollAudit(ctx, storeId, "salary_structure", data.id, existing ? "updated" : "created", {
        employee_id: employeeId,
        effective_from: effectiveFrom,
      });
      return json(existing ? 200 : 201, data);
    }
  }
  if (section === "expense-preview" && method === "GET") {
    requireAdmin(ctx);
    const employeeId = valueString(params.get("employee_id"));
    const { start, end } = payrollMonthBounds(valueString(params.get("month")));
    const employee = (await payrollEmployees(storeId)).find((item: any) => item.id === employeeId);
    if (!employee) fail(400, "Choose an active employee in this store.");
    const [claims, visits] = await Promise.all([
      fetchAll(() => adminClient.from("crm_expense_claims").select("amount").eq("store_id", storeId).eq("employee_id", employeeId).eq("status", "approved").eq("reimbursable", true).is("reimbursed_payment_id", null).gte("expense_date", start).lt("expense_date", end)),
      fetchAll(() => adminClient.from("crm_visits").select("id,expense").eq("store_id", storeId).eq("owner_id", employeeId).gt("expense", 0).gte("visit_date", start).lt("visit_date", end)),
    ]);
    const visitIds = visits.map((visit: any) => visit.id);
    const reimbursedIds = visitIds.length ? new Set((await fetchAll(() => adminClient.from("crm_payroll_visit_expenses").select("visit_id").in("visit_id", visitIds))).map((row: any) => row.visit_id)) : new Set<number>();
    const approvedExpenseAmount = claims.reduce((sum: number, claim: any) => sum + Number(claim.amount || 0), 0);
    const salesExpenseAmount = visits.filter((visit: any) => !reimbursedIds.has(visit.id)).reduce((sum: number, visit: any) => sum + Number(visit.expense || 0), 0);
    return json(200, { month: start.slice(0, 7), approved_expense_amount: approvedExpenseAmount, sales_expense_amount: salesExpenseAmount, total_expense_amount: approvedExpenseAmount + salesExpenseAmount });
  }
  if (section === "expenses") {
    if (parts.length === 2 && method === "GET") { let query = adminClient.from("crm_expense_claims").select("*").eq("store_id", storeId).order("expense_date", { ascending: false }); if (!admin) query = query.eq("employee_id", ctx.user.id); const { data, error } = await query; checkDb(error); return json(200, { results: await Promise.all((data || []).map(payrollEmployeePayload)) }); }
    if (parts.length === 2 && method === "POST" && Number(valueString(body.amount)) < 1) fail(400, "Expense amount must be at least 1.");
    if (parts.length === 2 && method === "POST") { const amount = payrollAmount(body.amount, "expense", false); const expenseDate = valueString(body.expense_date); if (!/^\d{4}-\d{2}-\d{2}$/.test(expenseDate)) fail(400, "Choose an expense date."); const { data, error } = await adminClient.from("crm_expense_claims").insert({ store_id: storeId, employee_id: ctx.user.id, expense_date: expenseDate, category: valueString(body.category) || "Other", description: valueString(body.description), amount, reimbursable: body.reimbursable !== false }).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "expense", data.id, "submitted", { amount }); return json(201, data); }
    if (parts.length === 4 && parts[3] === "review" && method === "POST") { requireAdmin(ctx); const status = valueString(body.status); if (!["approved", "rejected"].includes(status)) fail(400, "Choose Approved or Rejected."); const { data: current, error: readError } = await adminClient.from("crm_expense_claims").select("*").eq("id", parts[2]).eq("store_id", storeId).maybeSingle(); checkDb(readError); if (!current || current.status !== "submitted") fail(400, "This expense cannot be reviewed."); const { data, error } = await adminClient.from("crm_expense_claims").update({ status, reviewed_by: ctx.user.id, reviewed_at: new Date().toISOString(), review_note: valueString(body.note), updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "expense", data.id, status, {}); return json(200, data); }
  }
  if (section === "advances") {
    if (parts.length === 2 && method === "GET") { let query = adminClient.from("crm_salary_advances").select("*").eq("store_id", storeId).order("created_at", { ascending: false }); if (!admin) query = query.eq("employee_id", ctx.user.id); const { data, error } = await query; checkDb(error); return json(200, { results: await Promise.all((data || []).map(payrollEmployeePayload)) }); }
    if (parts.length === 2 && method === "POST" && Number(valueString(body.amount)) < 1) fail(400, "Salary advance amount must be at least 1.");
    if (parts.length === 2 && method === "POST") { const amount = payrollAmount(body.amount, "salary advance", false); const { data, error } = await adminClient.from("crm_salary_advances").insert({ store_id: storeId, employee_id: ctx.user.id, requested_amount: amount, reason: valueString(body.reason) }).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "advance", data.id, "submitted", { amount }); return json(201, data); }
    if (parts.length === 4 && parts[3] === "review" && method === "POST") { requireAdmin(ctx); const status = valueString(body.status); if (!["approved", "rejected"].includes(status)) fail(400, "Choose Approved or Rejected."); const { data: current, error: readError } = await adminClient.from("crm_salary_advances").select("*").eq("id", parts[2]).eq("store_id", storeId).maybeSingle(); checkDb(readError); if (!current || current.status !== "submitted") fail(400, "This advance cannot be reviewed."); const approved = status === "approved" ? payrollAmount(body.approved_amount, "approved advance", false) : 0; const { data, error } = await adminClient.from("crm_salary_advances").update({ status, approved_amount: approved, remaining_amount: approved, reviewed_by: ctx.user.id, reviewed_at: new Date().toISOString(), review_note: valueString(body.note), updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "advance", data.id, status, { approved }); return json(200, data); }
  }
  if (section === "calculate" && method === "POST") { requireAdmin(ctx); const result = await calculatePayroll(ctx, storeId, valueString(body.employee_id), valueString(body.payroll_month)); return json(200, result); }
  if (section === "payments") {
    if (parts.length === 2 && method === "GET") { let query = adminClient.from("crm_payroll_payments").select("*").eq("store_id", storeId).order("payroll_month", { ascending: false }); if (!admin) query = query.eq("employee_id", ctx.user.id).in("status", ["approved", "paid"]); const { data, error } = await query; checkDb(error); return json(200, { results: await Promise.all((data || []).map(payrollPaymentPayload)), can_manage: admin, can_approve: admin }); }
    if (parts.length === 2 && method === "POST") return await createAutomaticPayrollPayment(ctx, storeId, body);
    if (parts.length === 3 && method === "PATCH") return await updatePayrollPayment(ctx, storeId, parts[2], body);
    if (parts.length === 2 && method === "POST") { requireAdmin(ctx); const computed = await calculatePayroll(ctx, storeId, valueString(body.employee_id), valueString(body.payroll_month)); const bonus = payrollAmount(body.bonus_amount, "bonus"); const otherDeduction = payrollAmount(body.deduction_amount, "deduction"); let advanceRecovery = Math.min(payrollAmount(body.advance_recovery, "advance recovery"), computed.advances.reduce((sum: number, item: any) => sum + Number(item.remaining_amount), 0)); const overtimeAmount = Math.round(computed.overtime_hours * computed.overtime_rate * 100) / 100; const gross = Number(computed.salary.basic_salary) + Number(computed.salary.allowance_amount) + overtimeAmount + computed.reimbursement_amount + bonus; const net = gross - computed.lop_deduction - otherDeduction - advanceRecovery; if (net < 0) fail(400, "Deductions cannot exceed calculated earnings."); const status = valueString(body.status || "draft"); if (!["draft", "submitted"].includes(status)) fail(400, "Choose Draft or Submitted."); const calculation = { ...computed, salary: undefined, employee: undefined, advances: undefined, reimbursement_claims: (computed.reimbursement_claims || []).map((item: any) => item.id) }; const { data, error } = await adminClient.from("crm_payroll_payments").insert({ store_id: storeId, employee_id: computed.employee.id, payroll_month: computed.start, salary_structure_id: computed.salary.id, basic_salary: computed.salary.basic_salary, allowance_amount: computed.salary.allowance_amount, gross_amount: gross, bonus_amount: bonus, overtime_hours: computed.overtime_hours, overtime_rate: computed.overtime_rate, overtime_amount: overtimeAmount, reimbursement_amount: computed.reimbursement_amount, lop_deduction: computed.lop_deduction, deduction_amount: otherDeduction, advance_recovery: advanceRecovery, net_amount: net, paid_amount: 0, remaining_amount: net, present_days: computed.present_days, absent_days: computed.absent_days, paid_leave_days: computed.paid_leave_days, unpaid_leave_days: computed.unpaid_leave_days, calculation, payment_date: valueString(body.payment_date) || null, payment_method: valueString(body.payment_method || "bank_transfer"), reference_number: valueString(body.reference_number), notes: valueString(body.notes), status, created_by: ctx.user.id }).select("*").single(); checkDb(error); for (const claim of computed.reimbursement_claims || []) { const { error: reimbursementError } = await adminClient.from("crm_payroll_expense_reimbursements").insert({ payment_id: data.id, expense_claim_id: claim.id, amount: claim.amount }); checkDb(reimbursementError); const { error: expenseError } = await adminClient.from("crm_expense_claims").update({ reimbursed_payment_id: data.id, updated_at: new Date().toISOString() }).eq("id", claim.id).is("reimbursed_payment_id", null); checkDb(expenseError); } let remainingRecovery = advanceRecovery; for (const advance of computed.advances || []) { if (remainingRecovery <= 0) break; const recovered = Math.min(remainingRecovery, Number(advance.remaining_amount)); const next = Number(advance.remaining_amount) - recovered; const { error: repaymentError } = await adminClient.from("crm_payroll_advance_repayments").insert({ payment_id: data.id, advance_id: advance.id, amount: recovered }); checkDb(repaymentError); const { error: advanceError } = await adminClient.from("crm_salary_advances").update({ remaining_amount: next, status: next <= 0 ? "closed" : "approved", updated_at: new Date().toISOString() }).eq("id", advance.id); checkDb(advanceError); remainingRecovery -= recovered; } await payrollAudit(ctx, storeId, "payment", data.id, status === "submitted" ? "submitted" : "created", { month: computed.month, net }); return json(201, { payment: await payrollPaymentPayload(data) }); }
    if (parts.length === 4 && parts[3] === "approve" && method === "POST") { requireAdmin(ctx); const { data: current, error: readError } = await adminClient.from("crm_payroll_payments").select("*").eq("id", parts[2]).eq("store_id", storeId).maybeSingle(); checkDb(readError); if (!current || current.status !== "submitted") fail(400, "Only submitted payroll can be finalized."); const { data, error } = await adminClient.from("crm_payroll_payments").update({ status: "approved", approved_by: ctx.user.id, approved_at: new Date().toISOString(), finalized_by: ctx.user.id, finalized_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "payment", data.id, "approved", {}, data.id); return json(200, { payment: await payrollPaymentPayload(data) }); }
    if (parts.length === 4 && parts[3] === "reject" && method === "POST") return await rejectPayrollPayment(ctx, storeId, parts[2], body);
    if (parts.length === 4 && parts[3] === "reject" && method === "POST") { requireSuperAdmin(ctx); const { data: current, error: readError } = await adminClient.from("crm_payroll_payments").select("*").eq("id", parts[2]).eq("store_id", storeId).maybeSingle(); checkDb(readError); if (!current || current.status !== "submitted") fail(400, "Only submitted payroll can be rejected."); const [{ data: reimbursements, error: reimbursementReadError }, { data: repayments, error: repaymentReadError }] = await Promise.all([adminClient.from("crm_payroll_expense_reimbursements").select("expense_claim_id").eq("payment_id", current.id), adminClient.from("crm_payroll_advance_repayments").select("advance_id,amount").eq("payment_id", current.id)]); checkDb(reimbursementReadError); checkDb(repaymentReadError); for (const item of reimbursements || []) { const { error } = await adminClient.from("crm_expense_claims").update({ reimbursed_payment_id: null, updated_at: new Date().toISOString() }).eq("id", item.expense_claim_id).eq("reimbursed_payment_id", current.id); checkDb(error); } for (const item of repayments || []) { const { data: advance, error: advanceReadError } = await adminClient.from("crm_salary_advances").select("remaining_amount").eq("id", item.advance_id).maybeSingle(); checkDb(advanceReadError); if (advance) { const { error } = await adminClient.from("crm_salary_advances").update({ remaining_amount: Number(advance.remaining_amount) + Number(item.amount), status: "approved", updated_at: new Date().toISOString() }).eq("id", item.advance_id); checkDb(error); } } const [{ error: reimbursementDeleteError }, { error: repaymentDeleteError }] = await Promise.all([adminClient.from("crm_payroll_expense_reimbursements").delete().eq("payment_id", current.id), adminClient.from("crm_payroll_advance_repayments").delete().eq("payment_id", current.id)]); checkDb(reimbursementDeleteError); checkDb(repaymentDeleteError); const { data, error } = await adminClient.from("crm_payroll_payments").update({ status: "rejected", notes: [current.notes, valueString(body.note)].filter(Boolean).join("\n"), updated_at: new Date().toISOString() }).eq("id", current.id).select("*").single(); checkDb(error); await payrollAudit(ctx, storeId, "payment", data.id, "rejected", { note: valueString(body.note) }, data.id); return json(200, { payment: await payrollPaymentPayload(data) }); }
    if (parts.length === 4 && parts[3] === "pay" && method === "POST") {
      requireAdmin(ctx);
      const { data: current, error: readError } = await adminClient.from("crm_payroll_payments").select("*")
        .eq("id", parts[2]).eq("store_id", storeId).maybeSingle();
      checkDb(readError);
      if (!current || !["approved", "paid"].includes(current.status)) fail(400, "Approve payroll before recording a payment.");
      const netAmount = Math.max(0, Number(current.net_amount || 0));
      const paidAmount = Math.min(netAmount, Math.max(0, Number(current.paid_amount || 0)));
      const currentRemaining = Math.max(0, netAmount - paidAmount);
      if (currentRemaining <= 0) fail(400, "This salary is already fully paid.");
      const amount = payrollAmount(body.amount, "payment", false);
      if (amount > currentRemaining) fail(400, "Payment amount cannot exceed the remaining balance.");
      const paid = paidAmount + amount;
      const remaining = Math.max(0, netAmount - paid);
      const { error: transactionError } = await adminClient.from("crm_salary_payment_transactions").insert({
        payment_id: current.id,
        store_id: storeId,
        amount,
        payment_date: valueString(body.payment_date) || indiaDate(),
        payment_method: valueString(body.payment_method || current.payment_method),
        reference_number: valueString(body.reference_number),
        notes: valueString(body.notes),
        recorded_by: ctx.user.id,
      });
      checkDb(transactionError);
      const { data, error } = await adminClient.from("crm_payroll_payments").update({
        paid_amount: paid,
        remaining_amount: remaining,
        status: remaining === 0 ? "paid" : "approved",
        updated_at: new Date().toISOString(),
      }).eq("id", current.id).select("*").single();
      checkDb(error);
      await payrollAudit(ctx, storeId, "payment", data.id, "payment_recorded", { amount, remaining }, data.id);
      return json(200, { payment: await payrollPaymentPayload(data) });
    }
    if (parts.length === 4 && parts[3] === "payslip" && method === "GET") { const { data: payment, error } = await adminClient.from("crm_payroll_payments").select("*").eq("id", parts[2]).eq("store_id", storeId).maybeSingle(); checkDb(error); if (!payment || (!admin && (payment.employee_id !== ctx.user.id || !["approved", "paid"].includes(payment.status)))) fail(404, "Payslip not found."); const { data: transactions, error: transactionsError } = await adminClient.from("crm_salary_payment_transactions").select("*").eq("payment_id", payment.id).order("payment_date"); checkDb(transactionsError); return json(200, { payment: await payrollPaymentPayload(payment), transactions: transactions || [] }); }
  }
  if (section === "reports" && method === "GET") {
    requireAdmin(ctx);
    const month = valueString(params.get("month")) || indiaDate().slice(0, 7);
    const { start, end } = payrollMonthBounds(month);
    const { data, error } = await adminClient.from("crm_payroll_payments").select("*")
      .eq("store_id", storeId).gte("payroll_month", start).lt("payroll_month", end);
    checkDb(error);
    const rows = (data || []).map((row: any) => {
      const netAmount = Math.max(0, Number(row.net_amount || 0));
      const paidAmount = Math.min(netAmount, Math.max(0, Number(row.paid_amount || 0)));
      return { ...row, paid_amount: paidAmount, remaining_amount: Math.max(0, netAmount - paidAmount) };
    });
    return json(200, {
      month,
      totals: {
        payroll: rows.reduce((sum: number, row: any) => sum + Number(row.net_amount), 0),
        paid: rows.reduce((sum: number, row: any) => sum + Number(row.paid_amount), 0),
        pending: rows.reduce((sum: number, row: any) => sum + Number(row.remaining_amount), 0),
        awaitingApproval: rows.filter((row: any) => row.status === "submitted").length,
        reimbursements: rows.reduce((sum: number, row: any) => sum + Number(row.reimbursement_amount), 0),
        lopDeductions: rows.reduce((sum: number, row: any) => sum + Number(row.lop_deduction), 0),
        overtime: rows.reduce((sum: number, row: any) => sum + Number(row.overtime_amount), 0),
      },
      results: await Promise.all(rows.map(payrollPaymentPayload)),
    });
  }
  fail(404, "Payroll endpoint not found.");
}

async function profileWithCounts(profile: any) {
  const id = profile.id;
  const { count: datasetCount, error: datasetError } = await adminClient.from("crm_datasets")
    .select("id", { count: "exact", head: true }).eq("owner_id", id);
  checkDb(datasetError);
  const datasets = await fetchAll(() => adminClient.from("crm_datasets").select("id").eq("owner_id", id));
  let actualCustomerCount = 0;
  if (datasets.length) {
    const { count, error } = await adminClient.from("crm_customer_records").select("id", { count: "exact", head: true }).in("dataset_id", datasets.map((item: any) => item.id));
    checkDb(error); actualCustomerCount = count || 0;
  }
  return userPayload(profile, {
    dataset_count: datasetCount || 0,
    customer_count: actualCustomerCount,
  });
}

async function profilesWithCounts(profiles: any[]) {
  if (!profiles.length) return [];
  const profileIds = profiles.map((profile: any) => profile.id);
  const [datasets, stores] = await Promise.all([
    fetchAll(() => adminClient.from("crm_datasets").select("id,owner_id").in("owner_id", profileIds)),
    fetchAll(() => adminClient.from("crm_stores").select("id,name")),
  ]);
  const datasetIds = datasets.map((dataset: any) => Number(dataset.id));
  const customers = await datasetRecordCounts(datasetIds);
  const datasetCounts = new Map<string, number>();
  const customerCountsByDataset = new Map<number, number>();
  const customerCountsByOwner = new Map<string, number>();
  const storeNames = new Map(stores.map((store: any) => [store.id, store.name]));
  for (const dataset of datasets) datasetCounts.set(dataset.owner_id, (datasetCounts.get(dataset.owner_id) || 0) + 1);
  for (const customer of customers) customerCountsByDataset.set(Number(customer.dataset_id),Number(customer.customer_count));
  for (const dataset of datasets) customerCountsByOwner.set(dataset.owner_id, (customerCountsByOwner.get(dataset.owner_id) || 0) + (customerCountsByDataset.get(Number(dataset.id)) || 0));
  return profiles.map((profile: any) => userPayload(profile, {
    store_name: storeNames.get(profile.store_id) || "",
    dataset_count: datasetCounts.get(profile.id) || 0,
    customer_count: customerCountsByOwner.get(profile.id) || 0,
  }));
}

async function adminUserById(ctx: Context, id: string) {
  let query = adminClient.from("profiles").select("*").eq("id", id);
  query = applyProfileScope(query, ctx);
  const { data, error } = await query.maybeSingle();
  checkDb(error);
  if (!data) fail(404, "User not found.");
  return data;
}

async function handleAdmin(ctx: Context, method: string, parts: string[], params: URLSearchParams, body: any, files: File[] = [], thumbnails: File[] = []) {
  requireAdmin(ctx);
  if (parts[1] === "stores") {
    if (parts.length === 4 && parts[3] === "features" && method === "PATCH") {
      requireSuperAdmin(ctx);
      const features = validateStoreFeatures(body.features);
      const errors: Record<string, string[]> = {};
      const parseLimit = (value: any, field: string, label: string) => {
        const text = String(value ?? "").trim();
        if (!text) return null;
        if (!/^\d+$/.test(text) || Number(text) > 100000) {
          errors[field] = [`Enter a whole-number ${label} between 0 and 100,000.`];
          return null;
        }
        return Number(text);
      };
      const updates: any = { features };
      if (body.admin_limit !== undefined) updates.admin_limit = parseLimit(body.admin_limit, "admin_limit", "Admin limit");
      if (body.user_limit !== undefined) updates.user_limit = parseLimit(body.user_limit, "user_limit", "User limit");
      if (Object.keys(errors).length) fail(400, "Correct the account limits.", { errors });
      const { data, error } = await adminClient.from("crm_stores").update(updates).eq("id", parts[2]).select("*").maybeSingle();
      checkDb(error);
      if (!data) fail(404, "Store not found.");
      return json(200, data);
    }
    if (parts.length === 2 && method === "GET") {
      let query = adminClient.from("crm_stores").select("*").order("name");
      if (!isSuperAdmin(ctx)) query = query.eq("id", ctx.profile.store_id);
      const { data, error } = await query;
      checkDb(error);
      return json(200, { results: data || [], capabilities: { store_features: true } });
    }
    if (parts.length === 2 && method === "POST") {
      requireSuperAdmin(ctx);
      const name = valueString(body.name);
      const contactPerson = valueString(body.contact_person);
      const contactEmail = valueString(body.contact_email).toLowerCase();
      const contactPhone = valueString(body.contact_phone);
      const addressLine1 = valueString(body.address_line1);
      const city = valueString(body.city);
      const state = valueString(body.state);
      const postalCode = valueString(body.postal_code);
      const features = validateStoreFeatures(body.features ?? defaultStoreFeatures);
      const errors: Record<string, string[]> = {};
      const parseLimit = (value: any, field: string, label: string) => {
        const text = String(value ?? "").trim();
        if (!text) return null;
        if (!/^\d+$/.test(text) || Number(text) > 100000) {
          errors[field] = [`Enter a whole-number ${label} between 0 and 100,000.`];
          return null;
        }
        return Number(text);
      };
      const adminLimit = parseLimit(body.admin_limit, "admin_limit", "Admin limit");
      const userLimit = parseLimit(body.user_limit, "user_limit", "User limit");
      if (!name || name.length > 120) errors.name = ["Enter a store name up to 120 characters."];
      if (contactPerson.length > 120) errors.contact_person = ["Enter a contact person up to 120 characters."];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail) || contactEmail.length > 254) errors.contact_email = ["Enter a valid contact email."];
      if (!/^\+?[0-9][0-9\s().-]{6,19}$/.test(contactPhone) || contactPhone.length > 20) errors.contact_phone = ["Enter a valid phone number with 7 to 20 characters."];
      if (addressLine1.length > 240) errors.address_line1 = ["Enter an address up to 240 characters."];
      if (city.length > 100) errors.city = ["Enter a city up to 100 characters."];
      if (state.length > 100) errors.state = ["Enter a state or region up to 100 characters."];
      if (postalCode.length > 20) errors.postal_code = ["Enter a postal code up to 20 characters."];
      if (Object.keys(errors).length) fail(400, "Complete the store details.", { errors });
      const { data, error } = await adminClient.from("crm_stores").insert({
        name, contact_person: contactPerson || null, contact_email: contactEmail,
        contact_phone: contactPhone, address_line1: addressLine1 || null,
        city: city || null, state: state || null, postal_code: postalCode || null, features,
        admin_limit: adminLimit, user_limit: userLimit, created_by: ctx.user.id,
      }).select("*").single();
      checkDb(error);
      return json(201, data);
    }
  }
  if (parts[1] === "summary" && method === "GET") {
    const features = await storeFeaturesFor(ctx);
    const [profiles, datasets, authUsers] = await Promise.all([
      fetchAll(() => applyProfileScope(adminClient.from("profiles").select("*").order("employee_id"), ctx)),
      features.customers ? accessibleDatasets(ctx) : Promise.resolve([]),
      allAuthUsers(),
    ]);
    const customers = await datasetRecordCounts(datasets.map((dataset: any) => dataset.id));
    // Build all user and dataset counts from the three bulk queries above.
    // The former implementation made two extra database requests per user,
    // then repeated those requests for the recent-users section.
    const profilesById = new Map(profiles.map((profile: any) => [profile.id, profile]));
    const accountCreatedAt = new Map(authUsers.map((account: any) => [account.id, account.created_at]));
    const datasetCounts = new Map<string, number>();
    const customerCountsByDataset = new Map<number, number>();
    const customerCountsByUser = new Map<string, number>();
    for (const dataset of datasets) datasetCounts.set(dataset.owner_id, (datasetCounts.get(dataset.owner_id) || 0) + 1);
    for (const customer of customers) customerCountsByDataset.set(Number(customer.dataset_id),Number(customer.customer_count));
    for (const dataset of datasets) {
      customerCountsByUser.set(dataset.owner_id, (customerCountsByUser.get(dataset.owner_id) || 0) + (customerCountsByDataset.get(dataset.id) || 0));
    }
    const userRows = profiles.map((profile: any) => userPayload(profile, {
      dataset_count: datasetCounts.get(profile.id) || 0,
      customer_count: customerCountsByUser.get(profile.id) || 0,
      // Profile timestamps may be retained from the old CRM migration. The
      // authentication account timestamp is the real CRM-account creation
      // time used by the admin table and "Recently created users" list.
      date_joined: accountCreatedAt.get(profile.id) || profile.created_at,
    }));
    const recentDatasets = datasets.slice(0, 5).map((dataset: any) => ({
      id: dataset.id,
      name: dataset.name,
      owner_username: profilesById.get(dataset.owner_id)?.employee_id || profilesById.get(dataset.owner_id)?.name || "Unknown user",
      customer_count: customerCountsByDataset.get(dataset.id) || 0,
    }));
    const response = json(200, {
      metrics: {
        totalUsers: profiles.length,
        activeUsers: profiles.filter((item: any) => item.active).length,
        totalDatasets: datasets.length,
        totalCustomers: customers.reduce((sum: number, row: any) => sum + Number(row.customer_count || 0), 0),
      },
      users: userRows,
      recentDatasets,
      recentUsers: [...userRows].sort((a: any, b: any) => String(b.date_joined).localeCompare(String(a.date_joined))).slice(0, 5),
    });
    // Admin dashboards must always reflect account changes made moments ago.
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
  if (parts[1] === "designations") {
    const requestedStoreId = valueString(params.get("store"));
    const storeId = isSuperAdmin(ctx) && requestedStoreId ? requestedStoreId : requireStoreContext(ctx);
    if (parts.length === 2 && method === "GET") {
      const { data, error } = await adminClient.from("crm_designations").select("id,name").eq("store_id", storeId).order("name").order("id");
      checkDb(error);
      return json(200, { results: data || [] });
    }
    if (parts.length === 2 && method === "POST") {
      const name = valueString(body.name).replace(/\s+/g, " ");
      if (!name || name.length > 80) fail(400, "Enter a designation up to 80 characters.", { errors: { name: ["Enter a designation up to 80 characters."] } });
      const { data, error } = await adminClient.from("crm_designations").insert({ store_id: storeId, name, created_by: ctx.user.id }).select("id,name").single();
      checkDb(error);
      return json(201, data);
    }
  }
  if (parts[1] === "users") {
    if (parts.length === 2 && method === "GET") {
      const requestedStoreId = valueString(params.get("store"));
      const requestedRole = valueString(params.get("role"));
      if (requestedRole && !isSuperAdmin(ctx)) fail(403, "Super Admin access required.");
      // A Super Admin can deliberately open one store's team. Other admins
      // are always restricted to their own store, regardless of this query.
      const profiles = await fetchAll(() => {
        const query = adminClient.from("profiles").select("*").order("employee_id");
        const scoped = isSuperAdmin(ctx) && requestedStoreId ? query.eq("store_id", requestedStoreId) : applyProfileScope(query, ctx);
        return requestedRole ? scoped.eq("role", requestedRole) : scoped;
      });
      return json(200, { results: await profilesWithCounts(profiles) });
    }
    if (parts.length === 2 && method === "POST") {
      const username = valueString(body.username).toUpperCase();
      const email = valueString(body.email).toLowerCase();
      const password1 = String(body.password1 || "");
      const password2 = String(body.password2 || "");
      const role = body.role === undefined ? "employee" : body.role;
      const designation = role === "employee" ? valueString(body.designation).replace(/\s+/g, " ") : "";
      const accountStoreId = role === "super_admin" ? null : (isSuperAdmin(ctx) ? valueString(body.store_id) : ctx.profile.store_id);
      const errors: Record<string, string[]> = {};
      if (role !== "employee" && role !== "admin" && role !== "super_admin") errors.role = ["Choose Employee, Admin, or Super Admin."];
      if (role === "super_admin" && !isSuperAdmin(ctx)) errors.role = ["Only a Super Admin can create another Super Admin."];
      if (!isSuperAdmin(ctx) && role !== "employee") errors.role = ["Only a Super Admin can create administrator accounts."];
      if (role !== "super_admin" && !accountStoreId) errors.store_id = ["Select a store first, then add the account from that store."];
      if (!username || username.length > 150) errors.username = ["Enter a username up to 150 characters."];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = ["Enter a valid email address."];
      if (role === "employee" && !designation) errors.designation = ["Choose a designation."];
      if (designation.length > 80) errors.designation = ["Choose a designation up to 80 characters."];
      if (password1.length < 8) errors.password1 = ["This password must contain at least 8 characters."];
      if (password1 !== password2) errors.password2 = ["The two password fields did not match."];
      if (Object.keys(errors).length) fail(400, "Unable to create user.", { errors });
      // Username and email can each match a different existing account. Read
      // both matches instead of using maybeSingle(), which turns that normal
      // validation case into a PostgREST PGRST116 error.
      const duplicate = await adminClient.from("profiles").select("id,employee_id,email").or("employee_id.eq." + username + ",email.eq." + email).limit(2);
      checkDb(duplicate.error);
      if (duplicate.data?.length) {
        const usernameTaken = duplicate.data.some((profile: any) => String(profile.employee_id || "").toLocaleLowerCase() === username.toLocaleLowerCase());
        const emailTaken = duplicate.data.some((profile: any) => String(profile.email || "").toLocaleLowerCase() === email);
        const errors: Record<string, string[]> = { non_field_errors: ["Use a different username or email address."] };
        if (usernameTaken) errors.username = ["This username is already in use."];
        if (emailTaken) errors.email = ["This email address is already in use."];
        fail(400, "A user with that username or email already exists.", { errors });
      }
      await enforceStoreAccountLimit(accountStoreId, role, body.is_active !== false);
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email, password: password1, email_confirm: true,
        user_metadata: { employee_id: username, name: username },
      });
      if (createError) {
        const authCode = String(createError.code || "").toLowerCase();
        const authMessage = String(createError.message || "").toLowerCase();
        if (["email_exists", "email_already_exists", "user_already_exists"].includes(authCode) || /already (registered|exists|in use)/.test(authMessage)) {
          fail(400, "This email address already has an account.", { errors: { email: ["This email address already has an account. Use a different email address."] } });
        }
        console.error("CRM account creation failed:", authCode || "unknown", createError.message || "No message");
        fail(503, "The authentication account could not be created. Please try again shortly.");
      }
      if (!created.user) fail(502, "Unable to create the user account.");
      let profile: any;
      try {
        const { data: readProfile, error: readError } = await adminClient.from("profiles").select("*").eq("id", created.user.id).maybeSingle();
        checkDb(readError); profile = readProfile;
        if (!profile) {
          const { data: inserted, error: insertError } = await adminClient.from("profiles").insert({
            id: created.user.id, employee_id: username, name: username, email, role, active: body.is_active !== false, designation,
            store_id: accountStoreId,
          }).select("*").single();
          checkDb(insertError); profile = inserted;
        } else {
          const { data: updated, error: updateError } = await adminClient.from("profiles").update({ employee_id: username, name: username, email, role, active: body.is_active !== false, designation, store_id: accountStoreId }).eq("id", profile.id).select("*").single();
          checkDb(updateError); profile = updated;
        }
        await syncAttendanceAdmin(profile);
      } catch (error) {
        const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
        if (cleanupError) fail(503, "Account setup failed and the CRM account could not be rolled back. Contact an administrator before retrying.");
        throw error;
      }
      // Creation only needs the new account ID so the client can open its
      // detail page. Avoid unrelated dataset-count reads here: if one of
      // those reads is temporarily unavailable, a successfully created user
      // must never be reported as a failed save.
      return json(201, userPayload(profile, { dataset_count: 0, customer_count: 0 }));
    }
    if (parts.length === 3) {
      const target = await adminUserById(ctx, parts[2]);
      if (method === "GET") return json(200, await profileWithCounts(target));
      if (method === "PATCH") {
        if (target.id === ctx.user.id && body.is_active === false) fail(400, "You cannot deactivate your own administrator account.", { errors: { is_active: ["You cannot deactivate your own administrator account."] } });
        const username = body.username === undefined ? target.employee_id : valueString(body.username).toUpperCase();
        const email = body.email === undefined ? target.email : valueString(body.email).toLowerCase();
        const active = body.is_active === undefined ? target.active : Boolean(body.is_active);
        const role = body.role === undefined ? target.role : body.role;
        const requestedDesignation = body.designation === undefined ? String(target.designation || "") : valueString(body.designation).replace(/\s+/g, " ");
        const designation = role === "employee" ? requestedDesignation : "";
        if (!["employee", "admin", "super_admin"].includes(role) && body.role !== undefined) fail(400, "Choose a valid role.", { errors: { role: ["Choose Employee, Admin, or Super Admin."] } });
        if (!isSuperAdmin(ctx) && (role === "super_admin" || target.role === "super_admin")) fail(403, "Only a Super Admin can manage Super Admin accounts.");
        if (!isSuperAdmin(ctx) && (target.role !== "employee" || role !== "employee")) fail(403, "Only a Super Admin can manage administrator accounts.");
        if (target.id === ctx.user.id && !isAdminRole(role)) fail(400, "You cannot remove your own administrator access.", { errors: { role: ["You cannot remove your own administrator access."] } });
        if (!username || username.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid username and email.", { errors: { username: ["Enter a valid username and email."], email: ["Enter a valid username and email."] } });
        if (role === "employee" && !designation) fail(400, "Choose a designation.", { errors: { designation: ["Choose a designation."] } });
        if (designation.length > 80) fail(400, "Choose a designation up to 80 characters.", { errors: { designation: ["Choose a designation up to 80 characters."] } });
        const duplicate = await adminClient.from("profiles").select("id,employee_id,email").or("employee_id.eq." + username + ",email.eq." + email).neq("id", target.id).limit(2);
        checkDb(duplicate.error);
        if (duplicate.data?.length) {
          const usernameTaken = duplicate.data.some((profile: any) => String(profile.employee_id || "").toLocaleLowerCase() === username.toLocaleLowerCase());
          const emailTaken = duplicate.data.some((profile: any) => String(profile.email || "").toLocaleLowerCase() === email);
          const errors: Record<string, string[]> = { non_field_errors: ["Use a different username or email address."] };
          if (usernameTaken) errors.username = ["This username is already in use."];
          if (emailTaken) errors.email = ["This email address is already in use."];
          fail(400, "A user with that username or email already exists.", { errors });
        }
        const requestedStoreId = isSuperAdmin(ctx) ? valueString(body.store_id) : "";
        // Store ownership is immutable after creation. Every CRM record is
        // scoped through its owner's store, so moving an existing account
        // would otherwise carry its historical data into another store.
        if (target.role !== "super_admin" && role !== "super_admin" && requestedStoreId && requestedStoreId !== target.store_id) {
          fail(400, "An existing account cannot be moved to another store. Create a new account in that store instead.", {
            errors: { store_id: ["Existing accounts stay in their original store."] },
          });
        }
        let storeId = role === "super_admin" ? null : target.store_id;
        if (target.role === "super_admin" && role !== "super_admin") {
          if (!requestedStoreId) fail(400, "Choose a store before changing a global account to a store role.", { errors: { store_id: ["Choose the store for this account."] } });
          if (target.store_binding_id && requestedStoreId !== target.store_binding_id) {
            fail(400, "This account must return to its original store. Create a new account for another store.", {
              errors: { store_id: ["Choose this account's original store."] },
            });
          }
          const { data: selectedStore, error: storeError } = await adminClient.from("crm_stores").select("id").eq("id", requestedStoreId).maybeSingle();
          checkDb(storeError);
          if (!selectedStore) fail(400, "The selected store no longer exists.", { errors: { store_id: ["Choose an existing store."] } });
          storeId = selectedStore.id;
        }
        if (role !== target.role || active !== target.active || storeId !== target.store_id) {
          await enforceStoreAccountLimit(storeId, role, active, target.id);
        }
        if (email !== target.email) {
          const { error } = await adminClient.auth.admin.updateUserById(target.id, { email, email_confirm: true });
          checkDb(error);
        }
        const { data, error } = await adminClient.from("profiles").update({ employee_id: username, email, active, role, designation, store_id: storeId }).eq("id", target.id).select("*").single();
        if (error) {
          if (email !== target.email) {
            const { error: restoreError } = await adminClient.auth.admin.updateUserById(target.id, { email: target.email, email_confirm: true });
            if (restoreError) fail(503, "The profile update failed and its authentication email could not be restored. Contact an administrator.");
          }
          checkDb(error);
        }
        if (role !== target.role) {
          try {
            await syncAttendanceAdmin(data, true);
          } catch (syncError) {
            const { error: rollbackError } = await adminClient.from("profiles").update({ employee_id: target.employee_id, email: target.email, active: target.active, role: target.role, store_id: target.store_id }).eq("id", target.id);
            const { error: authRollbackError } = email !== target.email
              ? await adminClient.auth.admin.updateUserById(target.id, { email: target.email, email_confirm: true })
              : { error: null };
            if (rollbackError || authRollbackError) fail(503, "Attendance role synchronization failed and the CRM changes could not be restored. Contact an administrator.");
            fail(503, "The role was not changed because Attendance could not be updated.", { errors: { role: [(syncError as Error).message || "Attendance is unavailable. Try again shortly."] } });
          }
        }
        return json(200, await profileWithCounts(data));
      }
    }
    if (parts.length === 4 && parts[3] === "datasets" && method === "GET") {
      const target = await adminUserById(ctx, parts[2]);
      const datasets = await fetchAll(() => adminClient.from("crm_datasets").select("*").eq("owner_id", target.id).order("uploaded_at", { ascending: false }));
      return json(200, { results: await serializeDatasets(datasets) });
    }
    if (parts.length === 4 && method === "POST") {
      const target = await adminUserById(ctx, parts[2]);
      const action = parts[3];
      if (action === "toggle-active") {
        if (target.id === ctx.user.id) fail(400, "You cannot change your own active status here.");
        const { data, error } = await adminClient.from("profiles").update({ active: !target.active }).eq("id", target.id).select("*").single();
        checkDb(error); return json(200, await profileWithCounts(data));
      }
      if (action === "password") {
        if (isAdminRole(target.role) && !isSuperAdmin(ctx)) fail(403, "Only a Super Admin can reset an administrator password.");
        const password1 = String(body.password1 || "");
        const password2 = String(body.password2 || "");
        const errors: Record<string, string[]> = {};
        if (password1.length < 8) errors.password1 = ["This password must contain at least 8 characters."];
        if (password1 !== password2) errors.password2 = ["The two password fields did not match."];
        if (Object.keys(errors).length) fail(400, "Unable to reset password.", { errors });
        const { error } = await adminClient.auth.admin.updateUserById(target.id, { password: password1 });
        checkDb(error); return json(200, await profileWithCounts(target));
      }
      fail(404, "Unknown user action.");
    }
  }
  if (parts[1] === "sales-performance" && parts.length === 2 && method === "GET") {
    const month = reportMonth(params.get("month"));
    return json(200, { month: month.slice(0, 7), results: await salesPerformance(ctx, month) });
  }
  if (parts[1] === "user-performance" && parts.length === 2 && method === "GET") {
    const month = reportMonth(params.get("month"));
    return json(200, { month: month.slice(0, 7), results: await userPerformance(ctx, month) });
  }
  if (parts[1] === "tasks") {
    if (parts.length === 2 && method === "GET") {
      const userId = valueString(params.get("userId"));
      const storeUserIds = hasGlobalStoreAccess(ctx) ? null : await accessibleStoreUserIds(ctx);
      const tasks = await fetchAll(() => {
        let query = adminClient.from("crm_assigned_tasks").select("*").order("status").order("due_at").order("created_at", { ascending: false }).order("id", { ascending: false });
        if (userId) query = query.eq("assignee_id", userId);
        if (storeUserIds) query = storeUserIds.length ? query.in("assignee_id", storeUserIds) : query.eq("assignee_id", "00000000-0000-0000-0000-000000000000");
        return query;
      });
      return json(200, { results: await serializeTasks(tasks) });
    }
    if (parts.length === 2 && method === "POST") {
      const assigneeId = valueString(body.assignee);
      const title = valueString(body.title);
      if (!title) fail(400, "Enter a task.", { errors: { title: ["Enter a task."] } });
      const assignee = await adminUserById(ctx, assigneeId);
      if (isAdminRole(assignee.role)) fail(400, "Tasks can only be assigned to normal users.");
      if (!assignee.active) fail(400, "Tasks cannot be assigned to an inactive user.");
      await requireTaskImageUploads(ctx, files, thumbnails);
      const data = await saveTaskPhotos(adminClient, ctx.user.id, null, "assignment", {
        assignee: assigneeId, title, note: valueString(body.note), due_at: body.due_at || null,
      }, files, thumbnails);
      return json(201, await serializeTask(data));
    }
    if (parts.length === 3 && method === "PATCH") {
      const id = parseId(parts[2]);
      const { data: current, error: readError } = await adminClient.from("crm_assigned_tasks").select("*").eq("id", id).maybeSingle();
      checkDb(readError); if (!current) fail(404, "Task not found.");
      await adminUserById(ctx, current.assignee_id);
      if (body.review_action !== undefined) {
        if (files.length || thumbnails.length) fail(400, "Review the submitted photos without uploading replacement files.");
        const data = await reviewTaskSubmission(adminClient, ctx.user.id, id, parseId(body.submission_id), valueString(body.review_action), valueString(body.review_note));
        return json(200, await serializeTask(data));
      }
      const updates: any = {};
      if (body.status !== undefined) updates.status = valueString(body.status);
      if (body.title !== undefined) updates.title = valueString(body.title);
      if (body.note !== undefined) updates.note = String(body.note || "");
      if (body.due_at !== undefined) updates.due_at = body.due_at || null;
      await requireTaskImageUploads(ctx, files, thumbnails);
      const data = await saveTaskPhotos(adminClient, ctx.user.id, id, "assignment", updates, files, thumbnails);
      return json(200, await serializeTask(data));
    }
  }
  if (parts[1] === "targets") {
    if (parts.length === 2 && method === "GET") return json(200, await listTargets(ctx));
    if (parts.length === 2 && method === "POST") {
      const userId = valueString(body.userId);
      const monthText = valueString(body.month);
      const target = Number(body.target);
      const metric = valueString(body.metric || "count");
      if (!userId) fail(400, "Select a sales user.");
      const monthDate = new Date((monthText.length === 7 ? monthText + "-01" : monthText) + "T00:00:00Z");
      if (!/^\d{4}-(?:0[1-9]|1[0-2])(?:-\d{2})?$/.test(monthText) || Number.isNaN(monthDate.getTime()) || monthDate.toISOString().slice(0, monthText.length) !== monthText) fail(400, "Choose a valid target month.");
      if (!['count', 'amount'].includes(metric)) fail(400, "Choose count or amount for the target.");
      if (!Number.isFinite(target) || target <= 0 || (metric === "count" && !Number.isInteger(target)) || (metric === "amount" && (target > 9999999999.99 || Math.abs(target - Math.round(target * 100) / 100) > 0.0000001))) fail(400, metric === "count" ? "Target count must be a positive whole number." : "Target amount must be positive and use no more than two decimals.");
      const profile = await adminUserById(ctx, userId);
      if (isAdminRole(profile.role) || !profile.active || String(profile.designation || "").trim().toLowerCase() !== "sales") fail(400, "Targets can only be assigned to active users with the Sales designation.");
      const month = monthText.slice(0, 7) + "-01";
      const { data, error } = await adminClient.from("crm_sales_targets").upsert({ user_id: userId, month, target, metric }, { onConflict: "user_id,month" }).select("*").single();
      checkDb(error); return json(200, await targetPayload(data));
    }
    if (parts.length === 3 && method === "PATCH") {
      const id = parseId(parts[2]);
      const target = Number(body.target);
      const { data: existing, error: existingError } = await adminClient.from("crm_sales_targets").select("*").eq("id", id).maybeSingle();
      checkDb(existingError); if (!existing) fail(404, "Target not found.");
      const metric = valueString(body.metric || existing.metric || "count");
      if (!['count', 'amount'].includes(metric)) fail(400, "Choose count or amount for the target.");
      if (!Number.isFinite(target) || target <= 0 || (metric === "count" && !Number.isInteger(target)) || (metric === "amount" && (target > 9999999999.99 || Math.abs(target - Math.round(target * 100) / 100) > 0.0000001))) fail(400, metric === "count" ? "Target count must be a positive whole number." : "Target amount must be positive and use no more than two decimals.");
      const profile = await adminUserById(ctx, existing.user_id);
      if (isAdminRole(profile.role) || !profile.active || String(profile.designation || "").trim().toLowerCase() !== "sales") fail(400, "Targets can only be assigned to active users with the Sales designation.");
      const { data, error } = await adminClient.from("crm_sales_targets").update({ target, metric }).eq("id", id).select("*").maybeSingle();
      checkDb(error); if (!data) fail(404, "Target not found.");
      return json(200, await targetPayload(data));
    }
  }
  fail(404, "Admin API endpoint not found.");
}

async function overtimeContext(profile: any, workDate: string) {
  const start = String(profile.shift_start_time || "09:30:00").slice(0, 5);
  const end = String(profile.shift_end_time || "17:30:00").slice(0, 5);
  const officialParts = end.split(":").map(Number);
  let officialMinutes = officialParts[0] * 60 + officialParts[1] + 5;
  const officialEnd = String(Math.floor(officialMinutes / 60) % 24).padStart(2, "0") + ":" + String(officialMinutes % 60).padStart(2, "0");
  const { data, error } = await adminClient.from("attendance_records").select("punched_at")
    .eq("user_id", profile.id).gte("punched_at", workDate + "T00:00:00+05:30")
    .lt("punched_at", new Date(Date.parse(workDate + "T00:00:00+05:30") + 86400000).toISOString()).order("punched_at");
  checkDb(error);
  const punches = data || [];
  const lastPunch = punches.at(-1)?.punched_at;
  const officialEndAt = new Date(`${workDate}T${end}:00+05:30`).getTime() + 5 * 60000;
  const actualPunchOut = punches.length >= 2 && punches.length % 2 === 0
    && new Date(lastPunch).getTime() > officialEndAt ? lastPunch : null;
  return { start, end, officialEnd, actualPunchOut, punchCount: punches.length };
}

async function serializeOvertime(ctx: Context, item: any) {
  const employee = await adminUserById(ctx, item.employee_id);
  // Pending requests are commonly submitted before clocking out. Read the
  // current punches so the approval button becomes available after clock-out.
  const context = item.status === "pending" ? await overtimeContext({ ...employee,
    shift_start_time: item.assigned_start_time, shift_end_time: item.assigned_end_time,
  }, item.work_date) : null;
  const reviewedBy = item.reviewed_by ? await profileName(item.reviewed_by) : null;
  const actualPunchOut = context ? context.actualPunchOut : item.actual_punch_out;
  const cutoff = Date.parse(`${item.work_date}T${String(item.assigned_end_time).slice(0,5)}:00+05:30`) + 5 * 60000;
  const verifiedMinutes = actualPunchOut ? Math.max(0,Math.floor((Date.parse(actualPunchOut)-cutoff)/60000)) : null;
  return {
    id: item.id, employeeId: employee.employee_id, employeeName: employee.name || employee.employee_id,
    username: employee.employee_id, workDate: item.work_date,
    assignedStartTime: String(item.assigned_start_time).slice(0, 5),
    assignedEndTime: String(item.assigned_end_time).slice(0, 5),
    officialEndTime: String(item.official_end_time).slice(0, 5),
    declaredLeaveTime: item.declared_leave_time, actualPunchOut, verifiedMinutes,
    requestedMinutes: item.requested_minutes, approvedMinutes: item.approved_minutes,
    status: item.status, rejectionMessage: item.rejection_message,
    reviewedBy, reviewedAt: item.reviewed_at, createdAt: item.created_at,
  };
}

async function handleOvertime(ctx: Context, method: string, parts: string[], body: any) {
  if (parts.length === 1 && method === "GET") {
    const admin = isAdminRole(ctx.profile.role);
    const storeUserIds = admin && !hasGlobalStoreAccess(ctx) ? await accessibleStoreUserIds(ctx) : null;
    const requests = await fetchAll(() => {
      let query = adminClient.from("crm_overtime_requests").select("*").order("work_date", { ascending: false }).order("created_at", { ascending: false }).order("id", { ascending: false });
      if (!admin) query = query.eq("employee_id", ctx.user.id);
      else if (storeUserIds) query = storeUserIds.length ? query.in("employee_id", storeUserIds) : query.eq("employee_id", "00000000-0000-0000-0000-000000000000");
      return query;
    });
    const approvedMinutes = requests.filter((item: any) => item.status === "approved" && item.employee_id === ctx.user.id)
      .reduce((sum: number, item: any) => sum + Number(item.approved_minutes || 0), 0);
    return json(200, { requests: await Promise.all(requests.map((item: any) => serializeOvertime(ctx, item))), approvedMinutes });
  }
  if (parts.length === 1 && method === "POST") {
    const workDate = valueString(body.workDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fail(400, "Choose a valid working date.");
    const declared = new Date(String(body.declaredLeaveTime || ""));
    if (Number.isNaN(declared.getTime())) fail(400, "Enter a valid expected leaving time.");
    if (indiaDate(declared) !== workDate) fail(400, "Expected leaving time must be on the selected working date.");
    const data = await writeOvertime(ctx, null, "create", { workDate, declaredLeaveTime: declared.toISOString() });
    return json(201, await serializeOvertime(ctx, data));
  }
  if (parts.length === 3 && method === "POST") {
    requireAdmin(ctx);
    const id = parseId(parts[1]);
    const action = parts[2];
    const { data: item, error: readError } = await adminClient.from("crm_overtime_requests").select("*").eq("id", id).maybeSingle();
    checkDb(readError); if (!item) fail(404, "OT request not found.");
    if (item.status !== "pending") fail(409, "This OT request has already been reviewed.");
    const employee = await adminUserById(ctx, item.employee_id);
    const data = await writeOvertime(ctx, id, action, { message: valueString(body.message) });
    return json(200, await serializeOvertime(ctx, data));
  }
  fail(404, "Overtime API endpoint not found.");
}

async function writeOvertime(ctx: Context, id: number | null, action: string, values: any) {
  const { data, error } = await adminClient.rpc("crm_write_overtime", {
    p_actor: ctx.user.id, p_store: requireStoreContext(ctx), p_id: id, p_action: action, p_values: values,
  });
  if (error?.code === "42501") fail(403, "This overtime request is not accessible.");
  if (["23505", "P0001"].includes(error?.code)) fail(409, error.code === "23505" ? "An OT request already exists for this working date." : error.message);
  if (["22023", "22007", "22008", "22P02"].includes(error?.code)) fail(400, error.message);
  if (error?.code === "P0002") fail(404, "OT request not found.");
  checkDb(error);
  return data;
}

function mapProfile(profile: any) {
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
    shiftStartTime: String(profile.shift_start_time || "09:00").slice(0, 5),
    shiftEndTime: String(profile.shift_end_time || "17:30").slice(0, 5),
  };
}

async function handleAttendance(ctx: Context, method: string, parts: string[], params: URLSearchParams, body: any) {
  if (parts[1] === "manual") {
    requireAdmin(ctx);
    requireStoreContext(ctx);
    const employeesQuery = () => applyProfileScope(
      adminClient.from("profiles").select("id,name,employee_id,active,role").eq("active", true).eq("role", "employee").order("name"), ctx,
    );
    if (parts.length === 3 && parts[2] === "records" && method === "GET") {
      const attendanceDate = valueString(params.get("date"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) fail(400, "Choose a valid attendance date.");
      const parsedDate = new Date(attendanceDate + "T00:00:00Z");
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== attendanceDate) fail(400, "Choose a valid attendance date.");
      const profiles = await fetchAll(() => applyProfileScope(
        adminClient.from("profiles").select("id,name,employee_id,active,role").eq("active", true).eq("role", "employee").order("name"), ctx,
      ));
      const employeeIds = profiles.map((profile: any) => profile.id);
      if (!employeeIds.length) return json(200, { results: [] });
      const nextDay = new Date(parsedDate.getTime() + 86_400_000).toISOString().slice(0, 10);
      const { data: records, error } = await adminClient.from("attendance_records")
        .select("user_id,status,punched_at,raw").in("user_id", employeeIds).eq("serial_number", "CRM-MANUAL")
        .gte("punched_at", `${attendanceDate}T00:00:00+05:30`).lt("punched_at", `${nextDay}T00:00:00+05:30`)
        .order("punched_at", { ascending: true });
      checkDb(error);
      const recordsByEmployee = new Map<string, any[]>();
      for (const record of records || []) {
        const entries = recordsByEmployee.get(record.user_id) || [];
        entries.push(record);
        recordsByEmployee.set(record.user_id, entries);
      }
      return json(200, { results: profiles.map((profile: any) => {
        const entries = recordsByEmployee.get(profile.id) || [];
        const checkIn = entries.find((record: any) => String(record.status || "").trim().toUpperCase() === "IN")?.punched_at || "";
        const checkOut = entries.find((record: any) => String(record.status || "").trim().toUpperCase() === "OUT")?.punched_at || "";
        const entryMetadata = entries.map((record: any) => {
          try {
            const raw = JSON.parse(String(record.raw || ""));
            return {
              note: typeof raw?.note === "string" ? raw.note.trim() : "",
              breakMinutes: Number.isSafeInteger(raw?.break_minutes) && raw.break_minutes >= 0 ? raw.break_minutes : 0,
            };
          } catch { return { note: "", breakMinutes: 0 }; }
        });
        const notes = [...new Set(entryMetadata.map((item: any) => item.note).filter(Boolean))];
        const breakMinutes = entries.reduce((total: number, record: any, index: number) => (
          ["BREAK", "OUT"].includes(String(record.status || "").trim().toUpperCase()) ? total + entryMetadata[index].breakMinutes : total
        ), 0);
        const checkInTime = new Date(checkIn).getTime();
        const checkOutTime = new Date(checkOut).getTime();
        const workingMinutes = Number.isFinite(checkInTime) && Number.isFinite(checkOutTime) && checkOutTime > checkInTime
          ? Math.max(0, Math.round((checkOutTime - checkInTime) / 60_000) - breakMinutes)
          : null;
        return {
          userId: profile.id,
          employeeId: profile.employee_id || "",
          employeeName: profile.name || profile.employee_id || "Employee",
          checkIn,
          checkOut,
          notes,
          breakMinutes,
          workingMinutes,
          status: checkOut ? "checked_out" : checkIn ? "checked_in" : "not_marked",
        };
      }) });
    }
    if (parts.length === 3 && parts[2] === "employees" && method === "GET") {
      const employees = await fetchAll(employeesQuery);
      const attendanceDate = valueString(params.get("date"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate)) fail(400, "Choose a valid attendance date.");
      const parsedDate = new Date(attendanceDate + "T00:00:00Z");
      if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== attendanceDate) fail(400, "Choose a valid attendance date.");
      const employeeIds = employees.map((employee: any) => employee.id);
      const nextDay = new Date(parsedDate.getTime() + 86_400_000).toISOString().slice(0, 10);
      const start = `${attendanceDate}T00:00:00+05:30`;
      const end = `${nextDay}T00:00:00+05:30`;
      const { data: dayRecords, error: dayRecordsError } = employeeIds.length
        ? await adminClient.from("attendance_records").select("user_id,status,serial_number,punched_at")
          .in("user_id", employeeIds).gte("punched_at", start).lt("punched_at", end)
        : { data: [], error: null };
      checkDb(dayRecordsError);
      const recordsByEmployee = new Map<string, any[]>();
      for (const record of dayRecords || []) {
        const records = recordsByEmployee.get(record.user_id) || [];
        records.push(record);
        recordsByEmployee.set(record.user_id, records);
      }
      return json(200, { results: employees.map((employee: any) => {
        const records = recordsByEmployee.get(employee.id) || [];
        const manualRecords = records.filter((record: any) => record.serial_number === "CRM-MANUAL");
        const manualIns = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "IN");
        const manualOuts = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "OUT");
        const state = manualIns.length > manualOuts.length ? "checked_in"
          : manualIns.length ? "checked_out"
            : records.length ? "recorded"
              : "not_started";
        return {
          id: employee.id,
          name: employee.name || employee.employee_id || "Employee",
          employeeId: employee.employee_id || "",
          state,
        };
      }) });
    }
    if (parts.length === 2 && method === "POST") {
      const employeeIds = [...new Set((Array.isArray(body.employee_ids) ? body.employee_ids : [body.employee_id])
        .map((id: any) => valueString(id)).filter(Boolean))];
      const attendanceDate = valueString(body.attendance_date);
      const action = valueString(body.action || "check_in");
      const checkIn = valueString(body.check_in);
      const checkOut = valueString(body.check_out);
      const breakTime = valueString(body.break_time);
      const breakEnd = valueString(body.break_end);
      const note = valueString(body.note);
      const parsedDate = new Date(attendanceDate + "T00:00:00Z");
      // Profile IDs are verified against the active, store-scoped roster below.
      // Do not reject valid legacy/auth identifiers merely because they do not
      // use an RFC UUID version nibble.
      if (!employeeIds.length || employeeIds.length > 500 || employeeIds.some((id) => id.length > 128)) fail(400, "Choose between 1 and 500 employees.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(attendanceDate) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== attendanceDate) fail(400, "Choose a valid attendance date.");
      if (!["check_in", "check_out", "break"].includes(action)) fail(400, "Choose whether to record check-in, break, or check-out.");
      const punchTime = action === "check_in" ? checkIn : action === "check_out" ? checkOut : breakTime;
      const actionLabel = action === "check_in" ? "check-in" : action === "check_out" ? "check-out" : "break start";
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(punchTime)) fail(400, `Enter a valid ${actionLabel} time.`);
      if (action === "break" && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(breakEnd)) fail(400, "Enter a valid break end time.");
      const toMinutes = (time: string) => {
        const [hour, minute] = time.split(":").map(Number);
        return hour * 60 + minute;
      };
      const breakMinutes = action === "break" ? toMinutes(breakEnd) - toMinutes(breakTime) : 0;
      if (action === "break" && (breakMinutes < 1 || breakMinutes > 720)) fail(400, "Break end time must be after break start time and within 12 hours.");
      if (note.length > 500) fail(400, "The note must be 500 characters or fewer.");
      const { data: employees, error: employeeError } = await applyProfileScope(
        adminClient.from("profiles").select("id,name,employee_id,active,role").in("id", employeeIds).eq("active", true).eq("role", "employee"), ctx,
      );
      checkDb(employeeError);
      if ((employees || []).length !== employeeIds.length) fail(404, "One or more employees were not found in the selected store.");
      const nextDay = new Date(parsedDate.getTime() + 86_400_000).toISOString().slice(0, 10);
      const start = `${attendanceDate}T00:00:00+05:30`;
      const end = `${nextDay}T00:00:00+05:30`;
      const { data: existing, error: existingError } = await adminClient.from("attendance_records").select("id,user_id,status,serial_number,punched_at")
        .in("user_id", employeeIds).gte("punched_at", start).lt("punched_at", end);
      checkDb(existingError);
      const raw = JSON.stringify({ source: "manual", entered_by: ctx.profile.employee_id || ctx.user.id, note, break_minutes: action === "break" ? breakMinutes : 0, break_end: action === "break" ? breakEnd : "" });
      const recordsByEmployee = new Map<string, any[]>();
      for (const record of existing || []) {
        const records = recordsByEmployee.get(record.user_id) || [];
        records.push(record);
        recordsByEmployee.set(record.user_id, records);
      }
      const punchAt = new Date(`${attendanceDate}T${punchTime}:00+05:30`).getTime();
      if (action === "check_out" || action === "break") {
        const entryBeforeCheckin = (employees || []).some((employee: any) => {
          const manualRecords = (recordsByEmployee.get(employee.id) || []).filter((record: any) => record.serial_number === "CRM-MANUAL");
          const manualIns = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "IN");
          const manualOuts = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "OUT");
          const latestCheckIn = Math.max(...manualIns.map((record: any) => new Date(record.punched_at).getTime()));
          return manualIns.length > manualOuts.length && latestCheckIn >= punchAt;
        });
        if (entryBeforeCheckin) fail(400, `${action === "check_out" ? "Check-out" : "Break start"} must be after the recorded check-in time.`);
      }
      const pendingEmployees = (employees || []).filter((employee: any) => {
        const records = recordsByEmployee.get(employee.id) || [];
        if (action === "check_in") return records.length === 0;
        const manualRecords = records.filter((record: any) => record.serial_number === "CRM-MANUAL");
        const manualIns = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "IN").length;
        const manualOuts = manualRecords.filter((record: any) => String(record.status || "").trim().toUpperCase() === "OUT").length;
        return manualIns > manualOuts;
      });
      const records = pendingEmployees.map((employee: any) => {
        const punchCode = `MANUAL:${employee.employee_id || employee.id}`;
        const shared = { user_id: employee.id, employee_id: employee.employee_id || "", employee_name: employee.name || employee.employee_id || "Employee", punch_code: punchCode, serial_number: "CRM-MANUAL", verify_mode: "MANUAL", raw };
        return { ...shared, punched_at: `${attendanceDate}T${punchTime}:00+05:30`, status: action === "check_in" ? "IN" : action === "check_out" ? "OUT" : "BREAK" };
      });
      if (!records.length) return json(200, { createdCount: 0, skippedCount: employeeIds.length, attendanceDate, action });
      const { error: insertError } = await adminClient.from("attendance_records").insert(records);
      if (insertError?.code === "23505") fail(409, "An identical manual attendance entry already exists.");
      checkDb(insertError);
      return json(201, { createdCount: pendingEmployees.length, skippedCount: employeeIds.length - pendingEmployees.length, attendanceDate, action, checkIn: action === "check_in" ? punchTime : undefined, checkOut: action === "check_out" ? punchTime : undefined, breakTime: action === "break" ? punchTime : undefined, breakEnd: action === "break" ? breakEnd : undefined, breakMinutes: action === "break" ? breakMinutes : 0 });
    }
    fail(404, "Manual attendance endpoint not found.");
  }
  if (parts[1] === "leaves") {
    requireAdmin(ctx);
    const profiles = await fetchAll(() => applyProfileScope(
      adminClient.from("profiles").select("id,employee_id,name,active,role").eq("active", true).order("employee_id"), ctx,
    ));
    const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
    const scopedIds = profiles.map((profile: any) => profile.id);
    const validDate = (value: string, label: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, "Choose a valid " + label + ".");
      const date = new Date(value + "T00:00:00Z");
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(400, "Choose a valid " + label + ".");
      return value;
    };
    if (parts.length === 2 && method === "GET") {
      const from = valueString(params.get("from"));
      const to = valueString(params.get("to"));
      const userId = valueString(params.get("userId"));
      if (from) validDate(from, "start date");
      if (to) validDate(to, "end date");
      if (from && to && from > to) fail(400, "The leave start date must be before the end date.");
      if (userId && !profileById.has(userId)) fail(404, "Employee not found.");
      const leaves = await fetchAll(() => {
        let query = adminClient.from("attendance_leave_days").select("*").order("leave_date", { ascending: false }).order("id", { ascending: false });
        query = scopedIds.length ? query.in("user_id", scopedIds) : query.eq("user_id", "00000000-0000-0000-0000-000000000000");
        if (userId) query = query.eq("user_id", userId);
        if (from) query = query.gte("leave_date", from);
        if (to) query = query.lte("leave_date", to);
        return query;
      });
      return json(200, { results: leaves.map((leave: any) => {
        const profile = profileById.get(leave.user_id);
        return { id: leave.id, userId: leave.user_id, date: leave.leave_date, reason: leave.reason || "", leaveType: leave.leave_type || "paid",
          employeeName: profile?.name || profile?.employee_id || "Employee", employeeId: profile?.employee_id || "" };
      }) });
    }
    if (parts.length === 2 && method === "POST") {
      const userId = valueString(body.userId);
      const from = validDate(valueString(body.from), "leave start date");
      const to = validDate(valueString(body.to || body.from), "leave end date");
      const reason = valueString(body.reason);
      const leaveType = valueString(body.leaveType || "paid");
      if (!profileById.has(userId)) fail(404, "Employee not found.");
      if (from > to) fail(400, "The leave start date must be before the end date.");
      if (reason.length > 500) fail(400, "Leave reason must be 500 characters or fewer.");
      if (!["paid", "unpaid"].includes(leaveType)) fail(400, "Choose Paid or Unpaid leave.");
      const start = new Date(from + "T00:00:00Z");
      const end = new Date(to + "T00:00:00Z");
      const days: string[] = [];
      for (let date = start; date <= end; date = new Date(date.getTime() + 86_400_000)) {
        days.push(date.toISOString().slice(0, 10));
        if (days.length > 366) fail(400, "A leave entry can cover up to 366 days.");
      }
      const { error } = await adminClient.from("attendance_leave_days").upsert(
        days.map((leaveDate) => ({ user_id: userId, leave_date: leaveDate, reason, leave_type: leaveType, created_by: ctx.user.id })),
        { onConflict: "user_id,leave_date" },
      );
      checkDb(error);
      return json(201, { created: days.length });
    }
    if (parts.length === 3 && method === "DELETE") {
      const id = parseId(parts[2]);
      const { data: leave, error: readError } = await adminClient.from("attendance_leave_days").select("id,user_id").eq("id", id).maybeSingle();
      checkDb(readError);
      if (!leave || !profileById.has(leave.user_id)) fail(404, "Leave record not found.");
      const { error } = await adminClient.from("attendance_leave_days").delete().eq("id", id);
      checkDb(error);
      return json(204);
    }
    fail(404, "Attendance leave endpoint not found.");
  }
  if (parts.length === 1 && method === "GET") {
    const admin = isAdminRole(ctx.profile.role);
    let profileQuery = admin
      ? applyProfileScope(adminClient.from("profiles").select("*").order("name"), ctx)
      : adminClient.from("profiles").select("*").eq("id", ctx.user.id);
    const { data: profiles, error: profileError } = await profileQuery;
    checkDb(profileError);
    const from = valueString(params.get("from"));
    const to = valueString(params.get("to"));
    let recordQuery = adminClient.from("attendance_records").select("*").order("punched_at", { ascending: false });
    const scopedIds = (profiles || []).map((profile: any) => profile.id);
    if (!admin) recordQuery = recordQuery.eq("user_id", ctx.user.id);
    else recordQuery = scopedIds.length ? recordQuery.in("user_id", scopedIds) : recordQuery.eq("user_id", "00000000-0000-0000-0000-000000000000");
    if (params.get("userId") && admin && scopedIds.includes(params.get("userId"))) recordQuery = recordQuery.eq("user_id", params.get("userId"));
    if (from) recordQuery = recordQuery.gte("punched_at", from + "T00:00:00+05:30");
    if (to) recordQuery = recordQuery.lte("punched_at", to + "T23:59:59+05:30");
    const { data: records, error: recordError } = await recordQuery;
    checkDb(recordError);
    let devices: any[] = [];
    let mappings: any[] = [];
    if (admin && hasGlobalStoreAccess(ctx)) {
      const [deviceResult, mappingResult] = await Promise.all([
        adminClient.from("attendance_devices").select("*").order("last_seen", { ascending: false }),
        adminClient.from("attendance_mappings").select("*"),
      ]);
      checkDb(deviceResult.error); checkDb(mappingResult.error);
      devices = deviceResult.data || []; mappings = mappingResult.data || [];
    }
    const profileById = new Map((profiles || []).map((profile: any) => [profile.id, profile]));
    const serialized = (records || []).map((record: any) => {
      const profile = profileById.get(record.user_id);
      return {
        id: record.id, userId: record.user_id, employeeId: profile?.employee_id || record.employee_id,
        employeeName: profile?.name || record.employee_name, punchCode: record.punch_code,
        timestamp: record.punched_at, serialNumber: record.serial_number, status: record.status,
        verifyMode: record.verify_mode,
      };
    });
    return json(200, {
      records: serialized,
      employees: (profiles || []).map(mapProfile),
      punchCodes: admin ? [...new Set((records || []).filter((item: any) => !item.user_id).map((item: any) => item.punch_code))].map((punchCode: string) => ({ punchCode, employeeName: "Unmatched" })) : [],
      devices,
      availableFrom: serialized.length ? serialized[serialized.length - 1].timestamp.slice(0, 10) : "",
      availableTo: serialized.length ? serialized[0].timestamp.slice(0, 10) : "",
    });
  }
  if (parts.length === 2 && parts[1] === "mappings" && method === "POST") {
    requireSuperAdmin(ctx);
    const punchCode = valueString(body.punchCode);
    const userId = valueString(body.userId);
    let profileQuery = adminClient.from("profiles").select("*").eq("id", userId);
    profileQuery = applyProfileScope(profileQuery, ctx);
    const { data: profile, error: profileError } = await profileQuery.maybeSingle();
    checkDb(profileError); if (!profile) fail(404, "Employee not found.");
    const { data: mapped, error } = await adminClient.rpc("map_attendance_employee", { p_punch_code: punchCode, p_user_id: userId });
    checkDb(error);
    return json(200, { matched: mapped || 0, employee: { id: profile.id, name: profile.name, employeeId: profile.employee_id } });
  }
  fail(404, "Attendance API endpoint not found.");
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!supabaseUrl || !serviceRoleKey) fail(503, "Supabase service configuration is missing.");
    const url = new URL(request.url);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const functionIndex = pathSegments.lastIndexOf("crm-api");
    const routeSegments = pathSegments.slice(functionIndex >= 0 ? functionIndex + 1 : 0);
    const apiIndex = routeSegments.indexOf("api");
    const apiPath = (apiIndex >= 0 ? routeSegments.slice(apiIndex + 1) : routeSegments).join("/");
    if (request.method === "POST" && apiPath.replace(/^\/+|\/+$/g, "") === "auth/legacy-login") {
      let body: any;
      try { body = await request.json(); } catch { fail(400, "The login request is not valid JSON."); }
      return await handleLegacyLogin(request, body);
    }
    if (request.method === "POST" && apiPath.replace(/^\/+|\/+$/g, "") === "migration/import") {
      let body: any;
      try { body = await request.json(); } catch { fail(400, "The migration payload is not valid JSON."); }
      return await migrateLegacyData(request, body);
    }
    const ctx = await authenticate(request);
    if (request.method === "POST" && apiPath.replace(/^\/+|\/+$/g, "") === "auth/attendance-session") {
      // authenticate() supplies the trusted CRM identity; never accept an
      // employee ID from the request when opening another project's session.
      await requireStoreFeature(ctx, "attendance");
      return await startAttendanceSession(ctx);
    }
    const { values, files, thumbnails } = await requestBody(request);
    return await routeApi(ctx, request, apiPath, queryParams(url), values, files, thumbnails);
  } catch (error) {
    if (error instanceof ApiError) return json(error.status, error.payload || { detail: error.message });
    if (error instanceof TaskImageError) return json(error.status, { detail: error.message });
    const message = error instanceof Error ? error.message : "An unexpected server error occurred.";
    console.error("CRM API error:", message);
    return json(500, { detail: "An unexpected server error occurred." });
  }
});

