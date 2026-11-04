import { verifyAttendanceLogin } from "./attendance-login.ts";

const ctx = { user: { id: "crm-1", email: "auth@example.com" }, profile: { employee_id: "ADMIN01", email: "staff@example.com" } };
function setup(options: { badPassword?: boolean; wrongUser?: boolean } = {}) {
  const attempts: any[] = [], signouts: any[] = [];
  const auth = {
    signInWithPassword: (body: any) => {
      attempts.push(body);
      return Promise.resolve(options.badPassword ? { error: new Error("Invalid credentials") } : { data: { session: {}, user: { id: options.wrongUser ? "other-user" : ctx.user.id } } });
    },
    signOut: (body: any) => { signouts.push(body); return Promise.resolve({}); },
  };
  return { auth, attempts, signouts };
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

Deno.test("Attendance login accepts this CRM user's username or email and verifies the password", async () => {
  for (const username of [" admin01 ", "STAFF@example.com", "auth@example.com"]) {
    const app = setup();
    await verifyAttendanceLogin(app.auth, ctx, { username, password: "valid password" });
    equal(app.attempts, [{ email: ctx.user.email, password: "valid password" }]);
    equal(app.signouts, [{ scope: "local" }]);
  }
});

Deno.test("Attendance rejects empty credentials and another account before authentication", async () => {
  for (const body of [{}, null, { username: "ADMIN01" }, { username: "other@example.com", password: "password" }]) {
    const app = setup();
    let rejected = false;
    try { await verifyAttendanceLogin(app.auth, ctx, body); } catch { rejected = true; }
    equal(rejected, true);
    equal(app.attempts, []);
  }
});

Deno.test("wrong passwords and mismatched authenticated IDs cannot open Attendance", async () => {
  for (const options of [{ badPassword: true }, { wrongUser: true }]) {
    const app = setup(options);
    let rejected = false;
    try { await verifyAttendanceLogin(app.auth, ctx, { username: "ADMIN01", password: "wrong" }); } catch { rejected = true; }
    equal(rejected, true);
  }
});
