import { matchAttendanceProfile } from "./attendance-identity.ts";

const employee = { id: "attendance-13", employee_id: "EMP13", active: true, email: "attendance@example.com" };
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${expected}, received ${actual}`);
}

Deno.test("CRM username matches attendance employee ID regardless of email", () => {
  equal(matchAttendanceProfile("EMP13", [employee]), employee);
});
Deno.test("username matching ignores case and outer spaces", () => {
  equal(matchAttendanceProfile(" emp13 ", [employee]), employee);
});
Deno.test("missing and different usernames cannot see another employee", () => {
  for (const username of ["", null, "EMP1", "EMP14", "EMP%", "EMP_3", "attendance@example.com"]) {
    equal(matchAttendanceProfile(username, [employee]), null);
  }
});
Deno.test("inactive and ambiguous usernames are denied", () => {
  equal(matchAttendanceProfile("EMP13", [{ ...employee, active: false }]), null);
  equal(matchAttendanceProfile("EMP13", [employee, { ...employee, id: "other", employee_id: "emp13" }]), null);
});
