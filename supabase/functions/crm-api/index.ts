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
  const status = error.code === "23505" ? 409 : error.code === "23503" ? 400 : 400;
  throw new ApiError(status, error.message || "Database request failed.");
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

async function handleLegacyLogin(request: Request, body: any) {
  const identity = String(body?.identity || "").trim().toLocaleLowerCase();
  const password = typeof body?.password === "string" ? body.password : "";
  if (!identity || !password) fail(400, "Enter your username and password.");

  const { data: accounts, error } = await adminClient.from("crm_legacy_auth").select("*");
  checkDb(error);
  const usernameMatches = (accounts || []).filter((item: any) => String(item.username).toLocaleLowerCase() === identity);
  const emailMatches = (accounts || []).filter((item: any) => String(item.original_email || "").toLocaleLowerCase() === identity);
  const matches = usernameMatches.length ? usernameMatches : emailMatches;
  if (!matches.length) fail(404, "No imported CRM account matches that username or email.");
  if (matches.length > 1) fail(409, "More than one imported account uses that email. Sign in with your username.");

  const account = matches[0];
  if (!account.is_active) fail(403, "This CRM account is inactive.");
  if (!account.password_hash) {
    const authClient = legacyAuthClient(request);
    const { data, error: signInError } = await authClient.auth.signInWithPassword({ email: account.auth_email, password });
    if (signInError || !data.session) fail(401, "Invalid username or password.");
    return json(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  }
  if (account.password_hash.startsWith("!") || !await verifyDjangoPassword(password, account.password_hash)) {
    fail(401, account.password_hash.startsWith("!")
      ? "This account has no usable password. Ask an administrator to reset it."
      : "Invalid username or password.");
  }

  const { error: updateError } = await adminClient.auth.admin.updateUserById(account.auth_user_id, { password });
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
  if (signInError || !data.session) fail(401, "Your password was upgraded. Sign in again with the same username and password.");
  return json(200, { access_token: data.session.access_token, refresh_token: data.session.refresh_token });
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
  const tokenHash = await sha256Hex(token);
  const { data: authorization, error: authorizationError } = await adminClient.from("crm_migration_authorizations")
    .select("token_hash,expires_at,used_at").eq("token_hash", tokenHash).maybeSingle();
  checkDb(authorizationError);
  if (!authorization || authorization.used_at || new Date(authorization.expires_at).getTime() <= Date.now()) {
    fail(401, "Migration authorization is invalid, expired, or already used.");
  }
  if (body?.version !== 1 || !Array.isArray(body.users) || body.users.length === 0) fail(400, "The local CRM migration payload is invalid.");

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

  const { data: consumed, error: consumeError } = await adminClient.from("crm_migration_authorizations")
    .update({ used_at: new Date().toISOString() }).eq("token_hash", tokenHash).is("used_at", null).select("token_hash").maybeSingle();
  checkDb(consumeError);
  if (!consumed) fail(409, "This migration authorization was already used.");
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

function applyProfileScope(query: any, ctx: Context) {
  const storeId = profileScope(ctx);
  return storeId ? query.eq("store_id", storeId) : query;
}

async function accessibleStoreUserIds(ctx: Context) {
  if (hasGlobalStoreAccess(ctx)) return null;
  const profiles = await fetchAll(() => adminClient.from("profiles").select("id").eq("store_id", profileScope(ctx)));
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
    email: profile.email || "",
    role,
    is_staff: admin,
    is_superuser: role === "super_admin",
    is_admin: admin,
    is_active: Boolean(profile.active),
    date_joined: profile.created_at,
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

async function targetAndConversions(ownerId: string, month: string) {
  const { data: target, error: targetError } = await adminClient
    .from("crm_sales_targets").select("id,target").eq("user_id", ownerId).eq("month", month).maybeSingle();
  checkDb(targetError);
  if (!target) return { target: null, converted: 0, remaining_target: null };
  const { count, error } = await adminClient.from("crm_visits").select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId).eq("status", "converted").gte("visit_date", month).lt("visit_date", nextMonth(month));
  checkDb(error);
  const converted = count || 0;
  return { target: target.target, converted_count: converted, remaining_target: Math.max(target.target - converted, 0) };
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
    fetchAll(() => adminClient.from("crm_sales_targets").select("user_id,target").in("user_id", ownerIds).eq("month", currentMonth)),
    fetchAll(() => adminClient.from("crm_visits").select("owner_id").in("owner_id", ownerIds).eq("status", "converted").gte("visit_date", currentMonth).lt("visit_date", followingMonth)),
    Promise.all(datasets.map(async (dataset: any) => [Number(dataset.id), await countRecords(Number(dataset.id))] as const)),
  ]);
  const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
  const targetByOwner = new Map(targets.map((target: any) => [target.user_id, Number(target.target || 0)]));
  const conversionsByOwner = new Map<string, number>();
  for (const visit of convertedVisits) conversionsByOwner.set(visit.owner_id, (conversionsByOwner.get(visit.owner_id) || 0) + 1);
  const countByDataset = new Map(customerCounts);
  return datasets.map((dataset: any) => {
    const profile = profileById.get(dataset.owner_id);
    const target = targetByOwner.get(dataset.owner_id);
    const converted = conversionsByOwner.get(dataset.owner_id) || 0;
    return {
      id: dataset.id,
      name: dataset.name,
      original_filename: dataset.original_filename,
      owner_username: profile?.employee_id || profile?.name || null,
      customer_count: countByDataset.get(Number(dataset.id)) || 0,
      target: target ?? null,
      converted_count: converted,
      remaining_target: target === undefined ? null : Math.max(target - converted, 0),
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

async function customerChangeHistory(recordId: number) {
  const { data, error } = await adminClient.from("crm_customer_record_changes").select("*")
    .eq("record_id", recordId).order("changed_at", { ascending: false }).order("id", { ascending: false });
  checkDb(error);
  return await Promise.all((data || []).map(async (item: any) => recordChangeList(item, await profileName(item.changed_by))));
}

async function recordDetail(ctx: Context, record: any, dataset: any, choices = false) {
  const columns = (await datasetColumns(Number(dataset.id))).filter((column) => column.sheet_name === record.sheet_name);
  const [datasetPayload, recordPayload, history] = await Promise.all([
    serializeDataset(dataset), serializeRecord(record, columns), customerChangeHistory(Number(record.id)),
  ]);
  const result: any = {
    dataset: datasetPayload,
    record: recordPayload,
    fieldRows: fieldRows(record, columns),
    changeHistory: history,
  };
  if (choices) result.responseChoices = responseChoices;
  return result;
}

async function callbackPayload(record: any, dataset: any) {
  const columns = (await datasetColumns(Number(dataset.id))).filter((column) => column.sheet_name === record.sheet_name);
  const values = record.original_data || {};
  const phoneKeys = ["phone_number", "phone", "mobile_number", "mobile", "contact_number", "telephone"];
  let phone = "";
  for (const key of phoneKeys) if (values[key] != null && values[key] !== "") { phone = maskSensitive(values[key]); break; }
  return {
    id: record.id, datasetId: record.dataset_id, datasetName: dataset.name,
    customerName: displayName(record, columns), phone,
    callbackDate: record.callback_date, callbackCompletedAt: record.callback_completed_at,
    callbackCompletedBy: await profileName(record.callback_completed_by),
    status: record.response, statusLabel: responseLabels[record.response] || record.response,
    note: record.note, updatedAt: record.updated_at,
  };
}

async function logCustomerChange(recordId: number, userId: string, previous: any, updated: any) {
  const before = { response: previous.response, callback_date: previous.callback_date || "", note: previous.note || "" };
  const after = { response: updated.response, callback_date: updated.callback_date || "", note: updated.note || "" };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const { error } = await adminClient.from("crm_customer_record_changes").insert({
    record_id: recordId, changed_by: userId, previous_values: before, updated_values: after,
  });
  checkDb(error);
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
  const [userName, converted] = await Promise.all([
    profileName(target.user_id),
    (async () => {
      const { count, error } = await adminClient.from("crm_visits").select("id", { count: "exact", head: true })
        .eq("owner_id", target.user_id).eq("status", "converted")
        .gte("visit_date", target.month).lt("visit_date", nextMonth(target.month));
      checkDb(error);
      return count || 0;
    })(),
  ]);
  const allTargets = await fetchAll(() => adminClient.from("crm_sales_targets").select("target,month")
    .eq("user_id", target.user_id).order("month", { ascending: false }));
  let lowTargetCount = 0;
  for (const item of allTargets) {
    const { count, error } = await adminClient.from("crm_visits").select("id", { count: "exact", head: true })
      .eq("owner_id", target.user_id).eq("status", "converted")
      .gte("visit_date", item.month).lt("visit_date", nextMonth(item.month));
    checkDb(error);
    const percent = item.target ? Math.round(((count || 0) / item.target) * 100) : 0;
    if (percent <= 30) lowTargetCount += 1;
  }
  const percentage = target.target ? Math.round((converted / target.target) * 100) : 0;
  return {
    id: target.id, userId: target.user_id, username: userName,
    month: String(target.month).slice(0, 7),
    monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(String(target.month) + "T00:00:00Z")),
    datasetId: null, datasetName: "", target: target.target, converted, percentage,
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
  const [manualClient, customer, images] = await Promise.all([
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
    pending_amount: Math.max(Number(visit.total_amount || 0) - Number(visit.paid_amount || 0), 0),
    payment_description: visit.payment_description || "", note: visit.note || "",
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
  const [manualClients, customers] = await Promise.all([
    manualIds.length ? fetchAll(() => adminClient.from("crm_manual_clients").select("*").in("id", manualIds)) : [],
    customerIds.length ? fetchAll(() => adminClient.from("crm_customer_records").select("*").in("id", customerIds)) : [],
  ]);
  const datasetIds = [...new Set(customers.map((customer: any) => Number(customer.dataset_id)))];
  const [datasets, columns] = await Promise.all([
    datasetIds.length ? fetchAll(() => adminClient.from("crm_datasets").select("id,name").in("id", datasetIds)) : [],
    datasetIds.length ? fetchAll(() => adminClient.from("crm_dataset_columns").select("*").in("dataset_id", datasetIds).order("sheet_name").order("column_order")) : [],
  ]);
  const manualById = new Map(manualClients.map((item: any) => [Number(item.id), item]));
  const customerById = new Map(customers.map((item: any) => [Number(item.id), item]));
  const datasetById = new Map(datasets.map((item: any) => [Number(item.id), item]));
  const columnsByDataset = new Map<number, any[]>();
  for (const column of columns) columnsByDataset.set(Number(column.dataset_id), [...(columnsByDataset.get(Number(column.dataset_id)) || []), column]);
  return visits.map((visit: any) => {
    const manualClient = manualById.get(Number(visit.manual_client_id));
    const customer = customerById.get(Number(visit.customer_id));
    const dataset = customer ? datasetById.get(Number(customer.dataset_id)) : null;
    const sheetColumns = customer ? (columnsByDataset.get(Number(customer.dataset_id)) || []).filter((column) => column.sheet_name === customer.sheet_name) : [];
    return {
      id: visit.id,
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
      pending_amount: Math.max(Number(visit.total_amount || 0) - Number(visit.paid_amount || 0), 0),
      payment_description: visit.payment_description || "",
      note: visit.note || "",
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
  const visitRequest = fetchAll(() => {
    return applyBusinessScope(adminClient.from("crm_visits").select("owner_id,visit_date,expense,total_amount,paid_amount,payment_status"), ctx);
  });
  const [recordCountRows, visits, recentDatasets] = await Promise.all([
    Promise.all(recordCountRequests),
    visitRequest,
    serializeDatasets(datasets.slice(0, 3)),
  ]);
  const counts = Object.fromEntries(recordCountRows);
  const totalCustomers = recordCountRows.reduce((sum, [, count]) => sum + count, 0);
  const today = indiaDate();
  const month = today.slice(0, 7);
  const paymentTotal = visits.reduce((sum: number, item: any) => sum + Number(item.total_amount || 0), 0);
  const paidTotal = visits.reduce((sum: number, item: any) => sum + Number(item.paid_amount || 0), 0);
  return {
    totalDatasets: datasets.length,
    totalCustomers,
    responseStats: responseChoices.map((item) => ({ ...item, count: counts[item.value] || 0 })),
    recentDatasets,
    payments: {
      totalAmount: paymentTotal, paidAmount: paidTotal,
      pendingAmount: Math.max(paymentTotal - paidTotal, 0),
      paidCount: visits.filter((item: any) => Number(item.paid_amount) > 0).length,
      pendingCount: visits.filter((item: any) => Number(item.total_amount) > Number(item.paid_amount)).length,
      oneTimeCount: visits.filter((item: any) => item.payment_status === "one_time").length,
      completedCount: visits.filter((item: any) => item.payment_status === "completed").length,
    },
    sales: {
      totalVisits: visits.length,
      todaysVisits: visits.filter((item: any) => item.visit_date === today).length,
      monthVisits: visits.filter((item: any) => String(item.visit_date).slice(0, 7) === month).length,
      totalVisitExpenses: visits.reduce((sum: number, item: any) => sum + Number(item.expense || 0), 0),
    },
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
    const records = await visibleRecords(ctx, [Number(dataset.id)]);
    for (const record of records) stats[record.response] = (stats[record.response] || 0) + 1;
    const filtered = records.filter((record: any) => {
      if (responseFilter && record.response !== responseFilter) return false;
      const values = Object.values(record.original_data || {}).map(String).concat([responseLabels[record.response] || record.response, record.note || ""]);
      return values.some((value) => value.toLocaleLowerCase().includes(query));
    });
    filteredCount = filtered.length;
    numPages = Math.max(1, Math.ceil(filteredCount / 20));
    page = Math.min(requestedPage, numPages);
    pageRecords = filtered.slice((page - 1) * 20, page * 20);
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

async function deleteDataset(ctx: Context, dataset: any) {
  const recordRows = await fetchAll(() => adminClient.from("crm_customer_records").select("id").eq("dataset_id", dataset.id));
  const customerIds = recordRows.map((item: any) => item.id);
  if (customerIds.length) {
    for (let offset = 0; offset < customerIds.length; offset += 500) {
      const visitRows = await fetchAll(() => adminClient.from("crm_visits").select("id").in("customer_id", customerIds.slice(offset, offset + 500)));
      const visitIds = visitRows.map((item: any) => item.id);
      if (!visitIds.length) continue;
      const images = await fetchAll(() => adminClient.from("crm_visit_images").select("storage_path,thumbnail_path").in("visit_id", visitIds));
      if (images.length) {
        const { error } = await adminClient.storage.from("crm-visit-images").remove(images.flatMap((item: any) => [item.storage_path, item.thumbnail_path].filter(Boolean)));
        checkDb(error);
      }
    }
  }
  const { error } = await adminClient.from("crm_datasets").delete().eq("id", dataset.id);
  checkDb(error);
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
    // Free-text client-name search still needs JSON field inspection because
    // imported workbooks may use arbitrary column names.
    const records = await visibleRecords(ctx, datasetIds);
    await Promise.all(datasets.map(async (dataset: any) => columnsByDataset.set(Number(dataset.id), await datasetColumns(Number(dataset.id)))));
    const searchRecords = records.filter((record: any) => displayName(record, columnsByDataset.get(Number(record.dataset_id)) || []).toLocaleLowerCase().includes(query));
    for (const record of searchRecords) counts[record.response] = (counts[record.response] || 0) + 1;
    const filtered = statusFilter ? searchRecords.filter((record: any) => record.response === statusFilter) : searchRecords;
    filteredCount = filtered.length;
    numPages = Math.max(1, Math.ceil(filteredCount / 50));
    page = Math.min(requestedPage, numPages);
    pageRecords = filtered.slice((page - 1) * 50, page * 50);
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
  const records = await visibleRecords(ctx, datasets.map((item: any) => Number(item.id)));
  const byId = new Map(datasets.map((item: any) => [Number(item.id), item]));
  const pending = records.filter((item: any) => item.response === "callback" && !item.callback_completed_at);
  const calledBack = records.filter((item: any) => Boolean(item.callback_completed_at));
  const today = indiaDate();
  const tomorrowDate = new Date(today + "T12:00:00+05:30");
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(tomorrowDate);
  let preset = valueString(params.get("preset") || "today").toLowerCase();
  const dateValue = valueString(params.get("date"));
  let selectedDate: string | null = null;
  let list = pending;
  if (preset === "called_back" && !dateValue) list = calledBack;
  else if (dateValue) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) fail(400, "Enter a valid callback date.");
    selectedDate = dateValue;
    preset = "custom";
  } else if (preset === "today") selectedDate = today;
  else if (preset === "tomorrow") selectedDate = tomorrow;
  else if (preset !== "all") { preset = "today"; selectedDate = today; }
  if (selectedDate) list = list.filter((item: any) => item.callback_date === selectedDate);
  const sort = valueString(params.get("sort") || "asc").toLowerCase() === "desc" ? "desc" : "asc";
  list.sort((a: any, b: any) => {
    if (preset === "called_back") return String(b.updated_at).localeCompare(String(a.updated_at)) || Number(b.id) - Number(a.id);
    const aa = a.callback_date || (sort === "asc" ? "9999-99-99" : "0000-00-00");
    const bb = b.callback_date || (sort === "asc" ? "9999-99-99" : "0000-00-00");
    const comparison = aa.localeCompare(bb);
    return (sort === "desc" ? -comparison : comparison) || (sort === "desc" ? String(b.updated_at).localeCompare(String(a.updated_at)) : String(a.updated_at).localeCompare(String(b.updated_at))) || Number(a.id) - Number(b.id);
  });
  return {
    results: await Promise.all(list.map((record: any) => callbackPayload(record, byId.get(Number(record.dataset_id))))),
    counts: {
      today: pending.filter((item: any) => item.callback_date === today).length,
      tomorrow: pending.filter((item: any) => item.callback_date === tomorrow).length,
      total: pending.length, calledBack: calledBack.length,
    },
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

async function listTargets(ctx: Context, userId: string | null = null) {
  const storeUserIds = hasGlobalStoreAccess(ctx) ? null : await accessibleStoreUserIds(ctx);
  let query = adminClient.from("crm_sales_targets").select("*").order("month", { ascending: false });
  if (userId) query = query.eq("user_id", userId);
  if (storeUserIds) query = storeUserIds.length ? query.in("user_id", storeUserIds) : query.eq("user_id", "00000000-0000-0000-0000-000000000000");
  const { data, error } = await query;
  checkDb(error);
  const targets = data || [];
  if (!targets.length) return [];
  const userIds = [...new Set(targets.map((target: any) => target.user_id))];
  const firstMonth = [...targets].sort((a: any, b: any) => String(a.month).localeCompare(String(b.month)))[0].month;
  const lastMonth = [...targets].sort((a: any, b: any) => String(b.month).localeCompare(String(a.month)))[0].month;
  const [profiles, visits] = await Promise.all([
    fetchAll(() => adminClient.from("profiles").select("id,employee_id,name").in("id", userIds)),
    fetchAll(() => adminClient.from("crm_visits").select("owner_id,visit_date").in("owner_id", userIds).eq("status", "converted").gte("visit_date", firstMonth).lt("visit_date", nextMonth(lastMonth))),
  ]);
  const profileById = new Map(profiles.map((profile: any) => [profile.id, profile]));
  const convertedByUserMonth = new Map<string, number>();
  for (const visit of visits) {
    const key = `${visit.owner_id}|${String(visit.visit_date).slice(0, 7)}`;
    convertedByUserMonth.set(key, (convertedByUserMonth.get(key) || 0) + 1);
  }
  const lowCountsByUser = new Map<string, number>();
  for (const target of targets) {
    const converted = convertedByUserMonth.get(`${target.user_id}|${String(target.month).slice(0, 7)}`) || 0;
    const percentage = target.target ? Math.round((converted / target.target) * 100) : 0;
    if (percentage <= 30) lowCountsByUser.set(target.user_id, (lowCountsByUser.get(target.user_id) || 0) + 1);
  }
  return targets.map((target: any) => {
    const profile = profileById.get(target.user_id);
    const username = profile?.employee_id || profile?.name || null;
    const converted = convertedByUserMonth.get(`${target.user_id}|${String(target.month).slice(0, 7)}`) || 0;
    const percentage = target.target ? Math.round((converted / target.target) * 100) : 0;
    const lowTargetCount = lowCountsByUser.get(target.user_id) || 0;
    return {
      id: target.id,
      userId: target.user_id,
      username,
      month: String(target.month).slice(0, 7),
      monthLabel: new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(String(target.month) + "T00:00:00Z")),
      datasetId: null,
      datasetName: "",
      target: target.target,
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) addError("visit_date", "Enter a valid date.");
  if (meeting && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(meeting)) addError("meeting_time", "Enter a valid meeting time.");
  if (location.length > 255) addError("location", "Enter a meeting location up to 255 characters.");
  if (!validStatuses.includes(status)) addError("status", "Choose a valid visit status.");
  const numberFields = ["expense", "total_amount", "paid_amount"];
  const numbers: Record<string, number> = {};
  for (const name of numberFields) {
    const parsed = Number(body[name] || 0);
    if (!Number.isFinite(parsed) || parsed < 0) addError(name, "Enter a valid non-negative amount.");
    numbers[name] = parsed;
  }
  if (errors.visit_date || errors.meeting_time || errors.location || errors.status || numberFields.some((key) => errors[key])) {
    fail(400, "Please correct the highlighted fields.", { errors });
  }

  const previous = visitId ? await visibleVisit(ctx, visitId) : null;
  let customerId: number | null = null;
  let manualClientId: number | null = null;
  let visitOwnerId = previous?.owner_id || ctx.user.id;
  if (mode === "manual") {
    const clientName = valueString(body.client_name);
    if (!clientName || clientName.length > 255) addError("client_name", "Enter a client name up to 255 characters.");
    if (valueString(body.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valueString(body.email))) addError("email", "Enter a valid email address.");
    if (errors.client_name || errors.email) fail(400, "Please correct the highlighted fields.", { errors });
    const clientValues = {
      store_id: previous?.store_id || storeId,
      owner_id: previous?.owner_id || ctx.user.id,
      client_name: clientName,
      phone: valueString(body.phone).slice(0, 50),
      email: valueString(body.email).slice(0, 254),
      company: valueString(body.company).slice(0, 255),
      location: valueString(body.client_location).slice(0, 255),
    };
    if (previous?.manual_client_id) {
      const { data, error } = await adminClient.from("crm_manual_clients").update(clientValues).eq("id", previous.manual_client_id).select("id").single();
      checkDb(error);
      if (!data) fail(502, "Unable to save the client.");
      manualClientId = data.id;
    } else {
      const { data, error } = await adminClient.from("crm_manual_clients").insert(clientValues).select("id").single();
      checkDb(error);
      if (!data) fail(502, "Unable to save the client.");
      manualClientId = data.id;
    }
  } else {
    const dataset = await accessibleDataset(ctx, body.dataset);
    if (!previous) visitOwnerId = dataset.owner_id;
    const requestedCustomer = parseId(body.customer);
    const { data: record, error } = await adminClient.from("crm_customer_records").select("id")
      .eq("id", requestedCustomer).eq("dataset_id", dataset.id).maybeSingle();
    checkDb(error);
    if (!record) addError("customer", "Select a valid customer from this dataset.");
    else customerId = record.id;
    if (errors.customer) fail(400, "Please correct the highlighted fields.", { errors });
  }
  const paymentStatuses = ["not_paid", "partially_paid", "completed", "one_time"];
  const paymentStatus = valueString(body.payment_status || "not_paid");
  if (!paymentStatuses.includes(paymentStatus)) addError("payment_status", "Choose a valid payment status.");
  if (status === "converted" && numbers.paid_amount > numbers.total_amount) addError("paid_amount", "Paid amount cannot exceed the total amount.");
  if (errors.payment_status || errors.paid_amount) fail(400, "Please correct the highlighted fields.", { errors });
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
  };
  let saved: any;
  if (previous) {
    const { data, error } = await adminClient.from("crm_visits").update(values).eq("id", visitId).select("*").single();
    checkDb(error); saved = data;
  } else {
    const { data, error } = await adminClient.from("crm_visits").insert(values).select("*").single();
    checkDb(error); saved = data;
  }
  await uploadVisitImages(Number(saved.id), files, thumbnails);
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
  const storeId = requireStoreContext(ctx);
  const datasetName = valueString(body.datasetName);
  const inspection = body.inspection || {};
  if (!datasetName || datasetName.length > 255) fail(400, "Enter a dataset name up to 255 characters.", { errors: { dataset_name: ["Enter a dataset name up to 255 characters."] } });
  if (!Array.isArray(inspection.sheets) || !inspection.sheets.length) fail(400, "No workbook sheets were found.");
  const filename = (valueString(inspection.filename || body.filename || "workbook.xlsx").split(/[\\/]/).pop() || "workbook.xlsx").slice(0, 255);
  const { data: dataset, error: datasetError } = await adminClient.from("crm_datasets").insert({
    owner_id: ctx.user.id, store_id: storeId, name: datasetName, original_filename: filename,
  }).select("*").single();
  checkDb(datasetError);
  let rowsFound = 0;
  let rowsImported = 0;
  let rowsSkipped = 0;
  for (const sheet of inspection.sheets) {
    const names: string[] = Array.isArray(sheet.column_names) ? sheet.column_names : [];
    const keys: string[] = Array.isArray(sheet.field_keys) ? sheet.field_keys : names.map((_name, index) => "column_" + (index + 1));
    if (names.length > 500 || names.length !== keys.length) fail(400, "This workbook contains an invalid column layout.");
    const columnRows = names.map((name, index) => ({
      dataset_id: dataset.id, sheet_name: String(sheet.name || "Sheet1").slice(0, 255),
      original_name: String(name || "Column " + (index + 1)).slice(0, 255),
      field_key: String(keys[index] || "column_" + (index + 1)).slice(0, 255), column_order: index + 1,
    }));
    if (columnRows.length) {
      const { error } = await adminClient.from("crm_dataset_columns").insert(columnRows);
      checkDb(error);
    }
  }
  return { dataset: await serializeDataset(dataset), importSummary: { filename, rows_found: rowsFound, rows_imported: rowsImported, rows_skipped: rowsSkipped, errors: 0 } };
}

async function importRecordBatch(ctx: Context, datasetId: string, body: any) {
  const dataset = await accessibleDataset(ctx, datasetId);
  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 500) fail(400, "Send between 1 and 500 customer rows per import batch.");
  const columns = await datasetColumns(Number(dataset.id));
  const keysBySheet = new Map<string, Set<string>>();
  for (const column of columns) {
    const keys = keysBySheet.get(column.sheet_name) || new Set<string>();
    keys.add(column.field_key);
    keysBySheet.set(column.sheet_name, keys);
  }
  const insertRows = rows.map((row: any) => {
    const sheetName = valueString(row.sheet_name);
    const rowNumber = Number(row.row_number);
    const allowedKeys = keysBySheet.get(sheetName);
    if (!allowedKeys || !Number.isSafeInteger(rowNumber) || rowNumber < 2 || !row.original_data || typeof row.original_data !== "object" || Array.isArray(row.original_data)) {
      fail(400, "The workbook contains an invalid customer row.");
    }
    const originalData: Record<string, any> = {};
    for (const key of allowedKeys) {
      const value = row.original_data[key];
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) originalData[key] = value ?? "";
      else if (value !== undefined) originalData[key] = String(value);
    }
    return { dataset_id: dataset.id, sheet_name: sheetName, row_number: rowNumber, original_data: originalData };
  });
  const { error } = await adminClient.from("crm_customer_records").insert(insertRows);
  checkDb(error);
  return json(201, { inserted: insertRows.length });
}

async function routeApi(ctx: Context, request: Request, apiPath: string, params: URLSearchParams, body: any, files: File[], thumbnails: File[] = []) {
  const method = request.method.toUpperCase();
  const path = apiPath.replace(/^\/+|\/+$/g, "");
  const parts = path ? path.split("/").map(decodeURIComponent) : [];

  if (hasGlobalStoreAccess(ctx) && !["auth", "push"].includes(parts[0])
      && !(parts[0] === "admin" && ["stores", "users"].includes(parts[1]))) requireStoreContext(ctx);

  if (path === "dashboard/" || path === "dashboard") {
    if (method === "GET") return json(200, await dashboardSummary(ctx));
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
    if (parts.length === 4 && parts[2] === "customers") {
      const { record, dataset } = await accessibleRecord(ctx, parts[3], parts[1]);
      if (method === "GET") return json(200, await recordDetail(ctx, record, dataset, true));
      if (method === "PATCH") {
        const response = body.response === undefined ? record.response : valueString(body.response);
        if (!responseLabels[response]) fail(400, "Choose a valid response status.", { errors: { response: ["Choose a valid response status."] } });
        const callbackDate = body.callback_date === undefined ? record.callback_date : (valueString(body.callback_date) || null);
        if (callbackDate && !/^\d{4}-\d{2}-\d{2}$/.test(callbackDate)) fail(400, "Enter a valid callback date.", { errors: { callback_date: ["Enter a valid date."] } });
        const note = body.note === undefined ? record.note : String(body.note || "");
        const { data, error } = await adminClient.from("crm_customer_records").update({ response, callback_date: callbackDate, note })
          .eq("id", record.id).select("*").single();
        checkDb(error);
        await logCustomerChange(Number(record.id), ctx.user.id, record, data);
        return json(200, await recordDetail(ctx, data, dataset, false));
      }
      if (method === "DELETE") {
        const { error } = await adminClient.from("crm_customer_records").delete().eq("id", record.id);
        checkDb(error);
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
      const previous = record;
      const { data, error } = await adminClient.from("crm_customer_records").update({
        response: outcome, callback_completed_at: new Date().toISOString(), callback_completed_by: ctx.user.id,
      }).eq("id", record.id).select("*").single();
      checkDb(error);
      await logCustomerChange(Number(record.id), ctx.user.id, previous, data);
      return json(200, {
        record: await serializeRecord(data, (await datasetColumns(Number(dataset.id))).filter((item: any) => item.sheet_name === data.sheet_name)),
        callback: await callbackPayload(data, dataset),
        changeHistory: await customerChangeHistory(Number(data.id)),
      });
    }
  }

  if (parts[0] === "import" && parts[1] === "confirm" && parts.length === 2 && method === "POST") {
    return json(201, await createImportedDataset(ctx, body));
  }
  if (parts[0] === "import" && parts[1] === "datasets") {
    if (parts.length === 4 && parts[3] === "batch" && method === "POST") return await importRecordBatch(ctx, parts[2], body);
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
      const { data, error } = await adminClient.from("crm_assigned_tasks").select("*").eq("assignee_id", ctx.user.id)
        .order("status").order("due_at").order("created_at", { ascending: false });
      checkDb(error); return json(200, { results: await serializeTasks(data || []) });
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
      const data = await saveTaskPhotos(adminClient, ctx.user.id, id, "completion", values, files, thumbnails);
      return json(200, await serializeTask(data));
    }
  }

  if (parts[0] === "targets" && parts.length === 1 && method === "GET") {
    return json(200, { results: await listTargets(ctx, ctx.user.id) });
  }

  if (parts[0] === "sales") {
    if (parts[1] === "summary" && method === "GET") {
      const visits = await accessibleVisits(ctx);
      const today = indiaDate();
      const month = today.slice(0, 7);
      return json(200, {
        totalVisits: visits.length,
        todaysVisits: visits.filter((item: any) => item.visit_date === today).length,
        monthVisits: visits.filter((item: any) => String(item.visit_date).slice(0, 7) === month).length,
        totalVisitExpenses: visits.reduce((sum: number, item: any) => sum + Number(item.expense || 0), 0),
      });
    }
    if (parts[1] === "clients" && method === "GET") {
      const dataset = await accessibleDataset(ctx, params.get("dataset") || "");
      const columns = await datasetColumns(Number(dataset.id));
      const records = await visibleRecords(ctx, [Number(dataset.id)]);
      const query = valueString(params.get("q")).toLocaleLowerCase();
      const filtered = records.filter((record: any) => !query || Object.values(record.original_data || {}).map(String).join(" ").toLocaleLowerCase().includes(query));
      return json(200, { results: await Promise.all(filtered.map(async (record: any) => {
        const sheetColumns = columns.filter((column) => column.sheet_name === record.sheet_name);
        return { id: record.id, label: displayName(record, sheetColumns), sheetName: record.sheet_name, rowNumber: record.row_number };
      })) });
    }
    if (parts[1] === "visits" && parts.length === 2) {
      if (method === "GET") {
        const status = valueString(params.get("status"));
        const validStatus = ["healthy", "follow_up_required", "interested", "not_interested", "converted"].includes(status) ? status : "";
        const visits = await accessibleVisits(ctx, { status: validStatus, dateFrom: valueString(params.get("date_from")), dateTo: valueString(params.get("date_to")) });
        return json(200, { results: await serializeVisitList(visits) });
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
        if (images?.length) await adminClient.storage.from("crm-visit-images").remove(images.flatMap((item: any) => [item.storage_path, item.thumbnail_path].filter(Boolean)));
        const { error } = await adminClient.from("crm_visits").delete().eq("id", visit.id);
        checkDb(error); return json(204);
      }
    }
  }

  if (parts[0] === "overtime") return await handleOvertime(ctx, method, parts, body);
  if (parts[0] === "admin") return await handleAdmin(ctx, method, parts, params, body, files, thumbnails);
  if (parts[0] === "attendance") return await handleAttendance(ctx, method, parts, params, body);
  fail(404, "CRM API endpoint not found.");
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
  const customers = datasetIds.length
    ? await fetchAll(() => adminClient.from("crm_customer_records").select("dataset_id").in("dataset_id", datasetIds))
    : [];
  const datasetCounts = new Map<string, number>();
  const customerCountsByDataset = new Map<number, number>();
  const customerCountsByOwner = new Map<string, number>();
  const storeNames = new Map(stores.map((store: any) => [store.id, store.name]));
  for (const dataset of datasets) datasetCounts.set(dataset.owner_id, (datasetCounts.get(dataset.owner_id) || 0) + 1);
  for (const customer of customers) customerCountsByDataset.set(Number(customer.dataset_id), (customerCountsByDataset.get(Number(customer.dataset_id)) || 0) + 1);
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
    if (parts.length === 2 && method === "GET") {
      let query = adminClient.from("crm_stores").select("*").order("name");
      if (!isSuperAdmin(ctx)) query = query.eq("id", ctx.profile.store_id);
      const { data, error } = await query;
      checkDb(error);
      return json(200, { results: data || [] });
    }
    if (parts.length === 2 && method === "POST") {
      requireSuperAdmin(ctx);
      const name = valueString(body.name);
      if (!name || name.length > 120) fail(400, "Enter a store name up to 120 characters.", { errors: { name: ["Enter a store name up to 120 characters."] } });
      const { data, error } = await adminClient.from("crm_stores").insert({ name, created_by: ctx.user.id }).select("*").single();
      checkDb(error);
      return json(201, data);
    }
  }
  if (parts[1] === "summary" && method === "GET") {
    const [profiles, datasets, authUsers] = await Promise.all([
      fetchAll(() => applyProfileScope(adminClient.from("profiles").select("*").order("employee_id"), ctx)),
      accessibleDatasets(ctx),
      allAuthUsers(),
    ]);
    const customers = datasets.length
      ? await fetchAll(() => adminClient.from("crm_customer_records").select("dataset_id").in("dataset_id", datasets.map((dataset: any) => dataset.id)))
      : [];
    // Build all user and dataset counts from the three bulk queries above.
    // The former implementation made two extra database requests per user,
    // then repeated those requests for the recent-users section.
    const profilesById = new Map(profiles.map((profile: any) => [profile.id, profile]));
    const accountCreatedAt = new Map(authUsers.map((account: any) => [account.id, account.created_at]));
    const datasetCounts = new Map<string, number>();
    const customerCountsByDataset = new Map<number, number>();
    const customerCountsByUser = new Map<string, number>();
    for (const dataset of datasets) datasetCounts.set(dataset.owner_id, (datasetCounts.get(dataset.owner_id) || 0) + 1);
    for (const customer of customers) customerCountsByDataset.set(customer.dataset_id, (customerCountsByDataset.get(customer.dataset_id) || 0) + 1);
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
        totalCustomers: customers.length,
      },
      users: userRows,
      recentDatasets,
      recentUsers: [...userRows].sort((a: any, b: any) => String(b.date_joined).localeCompare(String(a.date_joined))).slice(0, 5),
    });
    // Admin dashboards must always reflect account changes made moments ago.
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
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
      const errors: Record<string, string[]> = {};
      if (role !== "employee" && role !== "admin" && role !== "super_admin") errors.role = ["Choose Employee, Admin, or Super Admin."];
      if (role === "super_admin" && !isSuperAdmin(ctx)) errors.role = ["Only a Super Admin can create another Super Admin."];
      if (role !== "super_admin" && isSuperAdmin(ctx) && !body.store_id) errors.store_id = ["Select a store first, then add the account from that store."];
      if (!username || username.length > 150) errors.username = ["Enter a username up to 150 characters."];
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = ["Enter a valid email address."];
      if (password1.length < 8) errors.password1 = ["This password must contain at least 8 characters."];
      if (password1 !== password2) errors.password2 = ["The two password fields did not match."];
      if (Object.keys(errors).length) fail(400, "Unable to create user.", { errors });
      const duplicate = await adminClient.from("profiles").select("id,employee_id,email").or("employee_id.eq." + username + ",email.eq." + email).maybeSingle();
      checkDb(duplicate.error);
      if (duplicate.data) fail(400, "A user with that username or email already exists.", { errors: { username: ["A user with that username or email already exists."], email: ["A user with that username or email already exists."] } });
      const { data: created, error: createError } = await adminClient.auth.admin.createUser({
        email, password: password1, email_confirm: true,
        user_metadata: { employee_id: username, name: username },
      });
      checkDb(createError);
      if (!created.user) fail(502, "Unable to create the user account.");
      let { data: profile, error: readError } = await adminClient.from("profiles").select("*").eq("id", created.user.id).maybeSingle();
      checkDb(readError);
      if (!profile) {
        const { data: inserted, error: insertError } = await adminClient.from("profiles").insert({
          id: created.user.id, employee_id: username, name: username, email, role, active: body.is_active !== false,
          store_id: role === "super_admin" ? null : (isSuperAdmin(ctx) && body.store_id ? body.store_id : ctx.profile.store_id),
        }).select("*").single();
        checkDb(insertError); profile = inserted;
      } else {
        const { data: updated, error: updateError } = await adminClient.from("profiles").update({ employee_id: username, name: username, email, role, active: body.is_active !== false, store_id: role === "super_admin" ? null : (isSuperAdmin(ctx) && body.store_id ? body.store_id : ctx.profile.store_id) }).eq("id", profile.id).select("*").single();
        checkDb(updateError); profile = updated;
      }
      try {
        await syncAttendanceAdmin(profile);
      } catch (error) {
        const { error: cleanupError } = await adminClient.auth.admin.deleteUser(created.user.id);
        if (cleanupError) fail(503, "Attendance setup failed and the CRM account could not be rolled back. Contact an administrator before retrying.");
        throw error;
      }
      return json(201, await profileWithCounts(profile));
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
        if (!["employee", "admin", "super_admin"].includes(role) && body.role !== undefined) fail(400, "Choose a valid role.", { errors: { role: ["Choose Employee, Admin, or Super Admin."] } });
        if (!isSuperAdmin(ctx) && (role === "super_admin" || target.role === "super_admin")) fail(403, "Only a Super Admin can manage Super Admin accounts.");
        if (target.id === ctx.user.id && !isAdminRole(role)) fail(400, "You cannot remove your own administrator access.", { errors: { role: ["You cannot remove your own administrator access."] } });
        if (!username || username.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid username and email.", { errors: { username: ["Enter a valid username and email."], email: ["Enter a valid username and email."] } });
        const duplicate = await adminClient.from("profiles").select("id,employee_id,email").or("employee_id.eq." + username + ",email.eq." + email).neq("id", target.id).maybeSingle();
        checkDb(duplicate.error);
        if (duplicate.data) fail(400, "A user with that username or email already exists.", { errors: { username: ["A user with that username or email already exists."], email: ["A user with that username or email already exists."] } });
        if (email !== target.email) {
          const { error } = await adminClient.auth.admin.updateUserById(target.id, { email, email_confirm: true });
          checkDb(error);
        }
        const requestedStoreId = isSuperAdmin(ctx) ? valueString(body.store_id) : "";
        // Store ownership is immutable after creation. Every CRM record is
        // scoped through its owner's store, so moving an existing account
        // would otherwise carry its historical data into another store.
        if (requestedStoreId && requestedStoreId !== target.store_id) {
          fail(400, "An existing account cannot be moved to another store. Create a new account in that store instead.", {
            errors: { store_id: ["Existing accounts stay in their original store."] },
          });
        }
        const storeId = target.store_id;
        const { data, error } = await adminClient.from("profiles").update({ employee_id: username, email, active, role, store_id: storeId }).eq("id", target.id).select("*").single();
        checkDb(error);
        if (role !== target.role) {
          try {
            await syncAttendanceAdmin(data, true);
          } catch (syncError) {
            const { error: rollbackError } = await adminClient.from("profiles").update({ employee_id: target.employee_id, email: target.email, active: target.active, role: target.role }).eq("id", target.id);
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
      return json(200, { results: await Promise.all(datasets.map(serializeDataset)) });
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
        if (isAdminRole(target.role)) fail(403, "Password reset is available for normal CRM users only.");
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
  if (parts[1] === "tasks") {
    if (parts.length === 2 && method === "GET") {
      const userId = valueString(params.get("userId"));
      let query = adminClient.from("crm_assigned_tasks").select("*").order("status").order("due_at").order("created_at", { ascending: false });
      if (userId) query = query.eq("assignee_id", userId);
      if (!hasGlobalStoreAccess(ctx)) {
        const storeUserIds = await accessibleStoreUserIds(ctx);
        query = storeUserIds.length ? query.in("assignee_id", storeUserIds) : query.eq("assignee_id", "00000000-0000-0000-0000-000000000000");
      }
      const { data, error } = await query;
      checkDb(error); return json(200, { results: await serializeTasks(data || []) });
    }
    if (parts.length === 2 && method === "POST") {
      const assigneeId = valueString(body.assignee);
      const title = valueString(body.title);
      if (!title) fail(400, "Enter a task.", { errors: { title: ["Enter a task."] } });
      const assignee = await adminUserById(ctx, assigneeId);
      if (isAdminRole(assignee.role)) fail(400, "Tasks can only be assigned to normal users.");
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
      if (!userId) fail(400, "Select a sales user.");
      if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(monthText)) fail(400, "Choose a valid target month.");
      if (!Number.isInteger(target) || target <= 0) fail(400, "Target must be a positive whole number.");
      const profile = await adminUserById(ctx, userId);
      if (isAdminRole(profile.role)) fail(400, "Targets can only be assigned to sales users.");
      const month = monthText.slice(0, 7) + "-01";
      const { data, error } = await adminClient.from("crm_sales_targets").upsert({ user_id: userId, month, target }, { onConflict: "user_id,month" }).select("*").single();
      checkDb(error); return json(200, await targetPayload(data));
    }
    if (parts.length === 3 && method === "PATCH") {
      const id = parseId(parts[2]);
      const target = Number(body.target);
      if (!Number.isInteger(target) || target <= 0) fail(400, "Target must be a positive whole number.");
      const { data: existing, error: existingError } = await adminClient.from("crm_sales_targets").select("*").eq("id", id).maybeSingle();
      checkDb(existingError); if (!existing) fail(404, "Target not found.");
      await adminUserById(ctx, existing.user_id);
      const { data, error } = await adminClient.from("crm_sales_targets").update({ target }).eq("id", id).select("*").maybeSingle();
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
    .lte("punched_at", workDate + "T23:59:59+05:30").order("punched_at");
  checkDb(error);
  const punches = data || [];
  const lastPunch = punches.at(-1)?.punched_at;
  const officialEndAt = new Date(`${workDate}T${officialEnd}:00+05:30`).getTime();
  const actualPunchOut = punches.length >= 2 && punches.length % 2 === 0
    && new Date(lastPunch).getTime() > officialEndAt ? lastPunch : null;
  return { start, end, officialEnd, actualPunchOut, punchCount: punches.length };
}

async function serializeOvertime(item: any) {
  const employee = await adminUserById(ctx, item.employee_id);
  // Pending requests are commonly submitted before clocking out. Read the
  // current punches so the approval button becomes available after clock-out.
  const context = item.status === "pending" ? await overtimeContext(employee, item.work_date) : null;
  const reviewedBy = item.reviewed_by ? await profileName(item.reviewed_by) : null;
  return {
    id: item.id, employeeId: employee.employee_id, employeeName: employee.name || employee.employee_id,
    username: employee.employee_id, workDate: item.work_date,
    assignedStartTime: String(item.assigned_start_time).slice(0, 5),
    assignedEndTime: String(item.assigned_end_time).slice(0, 5),
    officialEndTime: String(item.official_end_time).slice(0, 5),
    declaredLeaveTime: item.declared_leave_time, actualPunchOut: context ? context.actualPunchOut : item.actual_punch_out,
    requestedMinutes: item.requested_minutes, approvedMinutes: item.approved_minutes,
    status: item.status, rejectionMessage: item.rejection_message,
    reviewedBy, reviewedAt: item.reviewed_at, createdAt: item.created_at,
  };
}

async function handleOvertime(ctx: Context, method: string, parts: string[], body: any) {
  if (parts.length === 1 && method === "GET") {
    let query = adminClient.from("crm_overtime_requests").select("*").order("work_date", { ascending: false }).order("created_at", { ascending: false });
    if (!isAdminRole(ctx.profile.role)) query = query.eq("employee_id", ctx.user.id);
    else if (!hasGlobalStoreAccess(ctx)) {
      const storeUserIds = await accessibleStoreUserIds(ctx);
      query = storeUserIds.length ? query.in("employee_id", storeUserIds) : query.eq("employee_id", "00000000-0000-0000-0000-000000000000");
    }
    const { data, error } = await query;
    checkDb(error);
    const requests = data || [];
    const approvedMinutes = requests.filter((item: any) => item.status === "approved" && item.employee_id === ctx.user.id)
      .reduce((sum: number, item: any) => sum + Number(item.approved_minutes || 0), 0);
    return json(200, { requests: await Promise.all(requests.map(serializeOvertime)), approvedMinutes });
  }
  if (parts.length === 1 && method === "POST") {
    const workDate = valueString(body.workDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) fail(400, "Choose a valid working date.");
    const declared = new Date(String(body.declaredLeaveTime || ""));
    if (Number.isNaN(declared.getTime())) fail(400, "Enter a valid expected leaving time.");
    const context = await overtimeContext(ctx.profile, workDate);
    const officialMinutes = Number(context.officialEnd.slice(0, 2)) * 60 + Number(context.officialEnd.slice(3, 5));
    const declaredLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(declared);
    const declaredMinutes = Number(declaredLocal.slice(0, 2)) * 60 + Number(declaredLocal.slice(3, 5));
    if (declaredMinutes <= officialMinutes) fail(400, "Expected leaving time must be after the official end time.");
    const requestedMinutes = Math.max(0, declaredMinutes - officialMinutes);
    const { data, error } = await adminClient.from("crm_overtime_requests").insert({
      employee_id: ctx.user.id, work_date: workDate, assigned_start_time: context.start,
      assigned_end_time: context.end, official_end_time: context.officialEnd,
      declared_leave_time: declared.toISOString(), actual_punch_out: context.actualPunchOut,
      requested_minutes: requestedMinutes,
    }).select("*").single();
    checkDb(error);
    const admins = await fetchAll(() => applyProfileScope(
      adminClient.from("profiles").select("id").eq("active", true).in("role", ["admin", "super_admin"]),
      ctx,
    ));
    if (admins.length) {
      const { error: reminderError } = await adminClient.from("crm_reminders").insert(admins.map((item: any) => ({
        owner_id: item.id,
        text: "New OT request from " + (ctx.profile.name || ctx.profile.employee_id) + " for " + workDate,
        reminder_at: new Date().toISOString(),
      })));
      checkDb(reminderError);
    }
    return json(201, await serializeOvertime(data));
  }
  if (parts.length === 3 && method === "POST") {
    requireAdmin(ctx);
    const id = parseId(parts[1]);
    const action = parts[2];
    const { data: item, error: readError } = await adminClient.from("crm_overtime_requests").select("*").eq("id", id).maybeSingle();
    checkDb(readError); if (!item) fail(404, "OT request not found.");
    if (item.status !== "pending") fail(409, "This OT request has already been reviewed.");
    const employee = await adminUserById(ctx, item.employee_id);
    const context = await overtimeContext(employee, item.work_date);
    let changes: any = { reviewed_by: ctx.user.id, reviewed_at: new Date().toISOString(), actual_punch_out: context.actualPunchOut };
    if (action === "approve") {
      if (!context.actualPunchOut) fail(400, "Approval requires a final punch-out record.");
      const officialMinutes = Number(String(item.official_end_time).slice(0, 2)) * 60 + Number(String(item.official_end_time).slice(3, 5));
      const actual = new Date(context.actualPunchOut);
      const actualLocal = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(actual);
      const actualMinutes = Number(actualLocal.slice(0, 2)) * 60 + Number(actualLocal.slice(3, 5));
      changes.status = "approved";
      changes.approved_minutes = Math.max(0, actualMinutes - officialMinutes);
    } else if (action === "reject") {
      const message = valueString(body.message);
      if (!message) fail(400, "Enter a rejection reason.");
      changes.status = "rejected";
      changes.rejection_message = message;
    } else fail(400, "Unknown review action.");
    const { data, error } = await adminClient.from("crm_overtime_requests").update(changes).eq("id", id).select("*").single();
    checkDb(error);
    const outcome = changes.status === "approved" ? "approved" : "rejected";
    const { error: reminderError } = await adminClient.from("crm_reminders").insert({
      owner_id: item.employee_id,
      text: "Your OT request for " + item.work_date + " was " + outcome + "." + (changes.rejection_message ? " " + changes.rejection_message : ""),
      reminder_at: new Date().toISOString(),
    });
    checkDb(reminderError);
    return json(200, await serializeOvertime(data));
  }
  fail(404, "Overtime API endpoint not found.");
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

