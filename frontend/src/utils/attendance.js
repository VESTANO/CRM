// Attendance calculations adapted from the supplied Time sheet portal.
const REQUIRED_NET_WORKING_HOURS = 7;
const ATTENDANCE_GRACE_MINUTES = 5;
export const DEFAULT_EMPLOYEE_SHIFT = { shiftStartTime: "09:30", shiftEndTime: "17:30" };
const attendanceDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
const attendanceTimeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function dateInputValue(date) {
  return attendanceDateFormatter.format(date);
}

export function timeFromTimestamp(timestamp) {
  const parsed = parseTimestamp(timestamp);
  return Number.isNaN(parsed.getTime()) ? "" : clockTime(parsed);
}

export function attendanceDateFromTimestamp(timestamp) {
  const parsed = parseTimestamp(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return dateInputValue(parsed);
}

export function parseTimestamp(timestamp) {
  const value = String(timestamp ?? "").trim().replace(" ", "T");
  if (!value) return new Date(NaN);
  return new Date(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : value + "+05:30");
}

export function attendanceWindowForTimestamp(timestamp, shift = DEFAULT_EMPLOYEE_SHIFT) {
  const date = attendanceDateFromTimestamp(timestamp);
  const windowStart = new Date(`${date}T${String(shift.shiftStartTime || "09:30").slice(0, 5)}:00+05:30`);
  const windowEnd = new Date(`${date}T${String(shift.shiftEndTime || "17:30").slice(0, 5)}:00+05:30`);
  windowStart.setMinutes(windowStart.getMinutes() - ATTENDANCE_GRACE_MINUTES);
  windowEnd.setMinutes(windowEnd.getMinutes() + ATTENDANCE_GRACE_MINUTES);
  return { windowStart, windowEnd };
}

export function overlapHours(startTime, endTime, rangeStart, rangeEnd) {
  const clippedStart = Math.max(startTime.getTime(), rangeStart.getTime());
  const clippedEnd = Math.min(endTime.getTime(), rangeEnd.getTime());
  if (clippedEnd <= clippedStart) return 0;
  return (clippedEnd - clippedStart) / 3_600_000;
}

export function clockTime(date) {
  return attendanceTimeFormatter.format(date);
}

export function countedAttendanceTime(timestamp, shift, boundary) {
  const punch = parseTimestamp(timestamp);
  if (Number.isNaN(punch.getTime())) return timeFromTimestamp(timestamp);
  const { windowStart, windowEnd } = attendanceWindowForTimestamp(timestamp, shift);
  const counted = boundary === "start"
    ? new Date(Math.max(punch.getTime(), windowStart.getTime()))
    : new Date(Math.min(punch.getTime(), windowEnd.getTime()));
  return clockTime(counted);
}

export function timestampFromDate(date) {
  return `${dateInputValue(date)} ${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)}`;
}

export function isTodayTimestamp(timestamp) {
  return attendanceDateFromTimestamp(timestamp) === dateInputValue(new Date());
}

export function formatDuration(hours) {
  const totalMinutes = Math.max(0, Math.round(Number(hours || 0) * 60));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${wholeHours}h ${String(minutes).padStart(2, "0")}m`;
}

export function attendanceStatusMeta(totals, windowEnd, now = new Date()) {
  if (totals.isOpen) {
    return now >= windowEnd
      ? { label: "Awaiting punch-out", badgeClass: "pending" }
      : { label: "Inside / Working", badgeClass: "submitted" };
  }
  if (totals.workingHours < REQUIRED_NET_WORKING_HOURS && now >= windowEnd) {
    return { label: "Short hours", badgeClass: "rejected" };
  }
  return { label: "Left", badgeClass: "approved" };
}

export function calculateAttendanceDay(punches, now = new Date(), shift = DEFAULT_EMPLOYEE_SHIFT) {
  let workingHours = 0;
  let breakHours = 0;
  const { windowStart, windowEnd } = attendanceWindowForTimestamp(
    punches[0] || timestampFromDate(now),
    shift,
  );

  for (let index = 0; index + 1 < punches.length; index += 2) {
    workingHours += overlapHours(
      parseTimestamp(punches[index]),
      parseTimestamp(punches[index + 1]),
      windowStart,
      windowEnd,
    );
  }
  if (punches.length % 2 === 1) {
    const punchIn = parseTimestamp(punches.at(-1));
    const intervalEnd = now < windowEnd ? now : windowEnd;
    workingHours += overlapHours(
      punchIn,
      intervalEnd,
      windowStart,
      windowEnd,
    );
  }
  for (let index = 1; index + 1 < punches.length; index += 2) {
    breakHours += overlapHours(
      parseTimestamp(punches[index]),
      parseTimestamp(punches[index + 1]),
      windowStart,
      windowEnd,
    );
  }
  const status = attendanceStatusMeta({
    workingHours,
    isOpen: punches.length % 2 === 1,
  }, windowEnd, now);
  return {
    workingHours,
    breakHours,
    breakCount: Math.max(0, Math.floor((punches.length - 1) / 2)),
    isOpen: punches.length % 2 === 1,
    employeeStatus: status.label,
    employeeStatusClass: status.badgeClass,
  };
}

export function buildAttendanceDays(records) {
  const grouped = new Map();
  for (const record of records) {
    const date = attendanceDateFromTimestamp(record.timestamp);
    const key = `${record.userId || record.punchCode}|${date}`;
    const group = grouped.get(key) || {
      date,
      userId: record.userId,
      employeeName: record.employeeName,
      employeeId: record.employeeId || record.punchCode,
      punches: [],
      matched: Boolean(record.userId),
    };
    group.punches.push(record.timestamp);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => ({ ...group, punches: group.punches.sort((a, b) => parseTimestamp(a) - parseTimestamp(b)) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
