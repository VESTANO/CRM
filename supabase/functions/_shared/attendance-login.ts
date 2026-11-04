// Re-authenticate the same CRM identity before issuing an Attendance session.
export async function verifyAttendanceLogin(auth: any, ctx: any, body: any) {
  const identity = String(body?.username || "").trim().toLowerCase();
  const password = typeof body?.password === "string" ? body.password : "";
  if (!identity || !password) throw new Error("Enter your CRM username or email and password.");
  const identities = [ctx.profile.employee_id, ctx.profile.email, ctx.user.email]
    .filter(Boolean).map((value: string) => value.trim().toLowerCase());
  if (!identities.includes(identity)) throw new Error("Use the credentials of the currently signed-in CRM account.");
  const { data, error } = await auth.signInWithPassword({ email: ctx.user.email, password });
  if (error || !data?.session || data.user?.id !== ctx.user.id) throw new Error("Invalid CRM username or password.");
  await auth.signOut({ scope: "local" });
}
