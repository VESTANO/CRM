import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function response(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isAdminRole(role?: string) { return role === "super_admin" || role === "admin"; }
function canSetRole(callerRole: string, role: string) {
  return (callerRole === "super_admin" ? ["employee", "manager", "admin"] : ["employee", "manager"]).includes(role);
}
function validateShift(start: string, end: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end)) {
    return "Shift start and end times must use HH:MM format.";
  }
  return start >= end ? "Shift end time must be after the start time." : "";
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response(405, { error: "Use POST for employee actions." });
  try {
    const authorization = request.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const adminClient = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return response(401, { error: "Authentication required." });
    const { data: caller, error: callerError } = await adminClient.from("profiles").select("id, role, active, store_id").eq("id", user.id).single();
    if (callerError || !caller?.active || !isAdminRole(caller.role)) {
      return response(403, { error: "Only admins can manage employees." });
    }
    const body = await request.json();
    const action = String(body.action || "");
    if (!["create", "update", "delete"].includes(action)) return response(400, { error: "Unsupported employee action." });

    // Resolve tenancy from the authenticated admin, not from editable form data.
    // Global Super Admins must deliberately open a store before managing its team.
    const storeId = caller.role === "super_admin"
      ? (request.headers.get("x-crm-store-id") || "").trim()
      : String(caller.store_id || "");
    if (!storeId) return response(400, {
      error: caller.role === "super_admin"
        ? "Open a store before adding or managing its employees."
        : "Your administrator account is not assigned to a store.",
    });
    if (caller.role === "super_admin") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) {
        return response(400, { error: "The selected store is invalid. Open the store again." });
      }
      const { data: store, error: storeError } = await adminClient.from("crm_stores").select("id").eq("id", storeId).maybeSingle();
      if (storeError) throw storeError;
      if (!store) return response(400, { error: "The selected store no longer exists. Select another store." });
    }

    let current: any = null;
    const userId = String(body.userId || "");
    if (action !== "create") {
      if (!userId) return response(400, { error: "Employee user ID is required." });
      const { data, error } = await adminClient.from("profiles").select("*").eq("id", userId).eq("store_id", storeId).maybeSingle();
      if (error) throw error;
      if (!data) return response(404, { error: "Employee not found." });
      current = data;
      // Check the target account before changing any auth credentials or profile.
      if (current.role === "super_admin") return response(403, { error: "The super admin account cannot be changed here." });
      if (current.role === "admin" && caller.role !== "super_admin") {
        return response(403, { error: "Only the super admin can manage administrator accounts." });
      }
    }

    if (action === "delete") {
      if (userId === user.id) return response(400, { error: "You cannot delete your own account." });
      if (isAdminRole(current.role)) return response(400, { error: "Administrator accounts cannot be deleted." });
      if (current.active) return response(400, { error: "Deactivate the employee before deleting." });
      const { error } = await adminClient.auth.admin.deleteUser(userId);
      if (error) throw error;
      return response(200, { ok: true });
    }

    const email = String(body.email ?? current?.email ?? "").trim().toLowerCase();
    const employeeId = String(body.employeeId ?? current?.employee_id ?? "").trim().toUpperCase();
    const name = String(body.name ?? current?.name ?? "").trim();
    const shiftStart = String(body.shiftStartTime ?? current?.shift_start_time ?? "09:30").slice(0, 5);
    const shiftEnd = String(body.shiftEndTime ?? current?.shift_end_time ?? "17:30").slice(0, 5);
    const role = String(body.role ?? current?.role ?? "employee");
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !employeeId || !name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return response(400, { error: "A valid email, Employee ID, and name are required." });
    }
    if ((action === "create" || password) && password.length < 6) return response(400, { error: "Password must have at least 6 characters." });
    if ((action === "create" || body.role !== undefined) && !canSetRole(caller.role, role)) {
      return response(403, { error: "You cannot assign this employee role." });
    }
    if (body.active !== undefined && typeof body.active !== "boolean") return response(400, { error: "Active must be true or false." });
    const shiftError = validateShift(shiftStart, shiftEnd);
    if (shiftError) return response(400, { error: shiftError });
    // CRM profiles use text, so compare case-insensitively without SQL patterns.
    const { data: existing, error: existingError } = await adminClient.from("profiles").select("id, employee_id, email");
    if (existingError) throw existingError;
    if (existing?.some((item) => item.id !== userId && String(item.employee_id).trim().toUpperCase() === employeeId)) {
      return response(409, { error: "Employee ID already exists. Enter a unique Employee ID." });
    }
    if (existing?.some((item) => item.id !== userId && String(item.email).trim().toLowerCase() === email)) {
      return response(409, { error: "Email already exists. Enter a unique company email." });
    }
    const values = {
      store_id: storeId,
      employee_id: employeeId, name, email,
      department: String(body.department ?? current?.department ?? "Other").trim(),
      manager: String(body.manager ?? current?.manager ?? "").trim(),
      shift_start_time: shiftStart, shift_end_time: shiftEnd,
      role, active: body.active ?? current?.active ?? true,
    };

    if (action === "create") {
      const { data, error } = await adminClient.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { employee_id: employeeId, name },
      });
      if (error) throw error;
      if (!data.user) throw new Error("Unable to create employee account.");
      // CRM does not rely on the old Attendance project's auth trigger.
      const { data: profile, error: profileError } = await adminClient.from("profiles")
        .upsert({ id: data.user.id, ...values }, { onConflict: "id" }).select().single();
      if (profileError) {
        const { error: cleanupError } = await adminClient.auth.admin.deleteUser(data.user.id);
        if (cleanupError) console.error("Unable to roll back employee account:", cleanupError.message);
        throw profileError;
      }
      return response(201, { employee: profile });
    }

    const { data: profile, error: profileError } = await adminClient.from("profiles").update(values).eq("id", userId).eq("store_id", storeId).select().single();
    if (profileError) throw profileError;
    const authUpdates: Record<string, unknown> = {};
    if (email !== current.email) authUpdates.email = email;
    if (password) authUpdates.password = password;
    if (Object.keys(authUpdates).length) {
      const { error } = await adminClient.auth.admin.updateUserById(userId, authUpdates);
      if (error) {
        const rollback = Object.fromEntries(Object.keys(values).map((key) => [key, current[key]]));
        const { error: rollbackError } = await adminClient.from("profiles").update(rollback).eq("id", userId).eq("store_id", storeId);
        if (rollbackError) console.error("Unable to roll back employee profile:", rollbackError.message);
        throw error;
      }
    }
    return response(200, { employee: profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : (error as any)?.message || "Employee request failed.";
    return response(400, { error: message });
  }
});
