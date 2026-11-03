// Called only after the CRM server has authorized the account or its creator.
export async function ensureAttendanceAdmin(attendance: any, crmProfile: any, exactRole = false) {
  const admin = ["admin", "super_admin"].includes(crmProfile.role);
  if (!admin && !(exactRole && crmProfile.role === "employee")) return null;
  const username = String(crmProfile.employee_id || "").trim();
  if (!username) throw new Error("The CRM admin needs a username to link Attendance.");
  const pattern = username.replace(/[\\%_]/g, "\\$&");
  const { data: matches, error } = await attendance.from("profiles").select("*").ilike("employee_id", pattern).limit(2);
  if (error) throw error;
  if ((matches || []).length > 1) throw new Error("Multiple Attendance accounts match this CRM username.");
  const existing = matches?.[0];
  if (existing) {
    if (!existing.active && !exactRole) throw new Error("The matching Attendance account is inactive. Activate it in Attendance first.");
    // Keep an existing Attendance super admin's higher access and personal data.
    if ((!exactRole && existing.role === "super_admin") || existing.role === crmProfile.role) return existing;
    const { data, error: updateError } = await attendance.from("profiles")
      .update({ role: crmProfile.role }).eq("id", existing.id).select("*").single();
    if (updateError) throw updateError;
    return data;
  }
  if (!admin) return null;
  // Do not attach a different employee just because their email happens to match.
  const { data: emailMatch, error: emailError } = await attendance.from("profiles")
    .select("id").ilike("email", String(crmProfile.email).replace(/[\\%_]/g, "\\$&")).limit(1);
  if (emailError) throw emailError;
  if (emailMatch?.length) throw new Error("This email belongs to a different Attendance username. Correct the employee IDs before linking.");
  const { data: created, error: createError } = await attendance.auth.admin.createUser({
    email: crmProfile.email,
    // Attendance is opened through the existing CRM single-login flow.
    password: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}aA1!`,
    email_confirm: true,
    user_metadata: { employee_id: username, name: crmProfile.name || username },
  });
  if (createError) throw createError;
  if (!created.user) throw new Error("Unable to create the Attendance admin account.");
  try {
    const { data, error: profileError } = await attendance.from("profiles").upsert({
      id: created.user.id, employee_id: username, name: crmProfile.name || username,
      email: crmProfile.email, role: crmProfile.role, active: crmProfile.active !== false,
    }, { onConflict: "id" }).select("*").single();
    if (profileError) throw profileError;
    return data;
  } catch (error) {
    const { error: cleanupError } = await attendance.auth.admin.deleteUser(created.user.id);
    if (cleanupError) throw new Error("Attendance setup failed and its partial account could not be removed. Contact an administrator before retrying.");
    throw error;
  }
}
