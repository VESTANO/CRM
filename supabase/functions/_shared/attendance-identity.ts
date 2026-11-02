// Attendance employee_id is its login username. Email and display name are not identifiers.
export function matchAttendanceProfile(username: unknown, profiles: any[]) {
  const normalize = (value: unknown) => String(value || "").trim().toLowerCase();
  const identity = normalize(username);
  if (!identity) return null;
  const matches = profiles.filter((profile) => normalize(profile.employee_id) === identity);
  return matches.length === 1 && matches[0].active === true ? matches[0] : null;
}
