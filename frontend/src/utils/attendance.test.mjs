import assert from "node:assert/strict";
import test from "node:test";
import { attendanceDateFromTimestamp, buildAttendanceDays, calculateAttendanceDay, countedAttendanceTime, dateInputValue, parseTimestamp, timeFromTimestamp, timestampFromDate } from "./attendance.js";

test("paired punches subtract lunch and count the break", () => {
  const totals = calculateAttendanceDay([
    "2026-10-29 09:30:00", "2026-10-29 13:00:00",
    "2026-10-29 13:30:00", "2026-10-29 17:30:00",
  ], new Date("2026-10-29T19:00:00+05:30"));
  assert.equal(totals.workingHours, 7.5);
  assert.equal(totals.breakHours, 0.5);
  assert.equal(totals.breakCount, 1);
  assert.equal(totals.employeeStatus, "Left");
});

test("counted hours honor the imported shift and grace period", () => {
  const totals = calculateAttendanceDay(["2026-10-29 08:00:00", "2026-10-29 19:00:00"]);
  assert.ok(Math.abs(totals.workingHours - (8 + 10 / 60)) < 0.00001);
  assert.equal(countedAttendanceTime("2026-10-29 08:00:00", {}, "start"), "09:25");
});

test("short completed days and open punches retain source status rules", () => {
  const short = calculateAttendanceDay(["2026-10-29 09:30:00", "2026-10-29 11:00:00"], new Date("2026-10-29T19:00:00+05:30"));
  assert.equal(short.employeeStatus, "Short hours");
  const open = calculateAttendanceDay(["2026-10-29 09:30:00"], new Date("2026-10-30T10:00:00+05:30"));
  assert.equal(open.isOpen, true);
  assert.equal(open.employeeStatus, "Awaiting punch-out");
  assert.equal(open.workingHours, 8 + 5 / 60);
});

test("employee and date grouping keeps different employees separate", () => {
  const days = buildAttendanceDays([
    { userId: "crm:1", employeeId: "EMP001", timestamp: "2026-10-29 17:30:00" },
    { userId: "crm:2", employeeId: "EMP002", timestamp: "2026-10-29 09:30:00" },
    { userId: "crm:1", employeeId: "EMP001", timestamp: "2026-10-29 09:30:00" },
  ]);
  assert.equal(days.length, 2);
  assert.deepEqual(days.find((day) => day.userId === "crm:1").punches, ["2026-10-29 09:30:00", "2026-10-29 17:30:00"]);
  assert.equal(dateInputValue(new Date("2026-10-29T20:00:00Z")), "2026-10-30");
});
test('UTC and offset punches use the India calendar day and the same working-hours rules',()=>{
  assert.equal(attendanceDateFromTimestamp('2026-11-06T23:30:00Z'),'2026-11-07');
  assert.equal(timeFromTimestamp('2026-11-07T04:00:00Z'),'09:30');
  assert.equal(parseTimestamp('2026-11-07T09:30:00+05:30').toISOString(),'2026-11-07T04:00:00.000Z');
  const day=calculateAttendanceDay(['2026-11-07T04:00:00Z','2026-11-07T12:00:00Z'],new Date('2026-11-07T14:00:00Z'));
  assert.equal(day.workingHours,8);assert.equal(day.employeeStatus,'Left');
  const grouped=buildAttendanceDays([{userId:'A',timestamp:'2026-11-07 09:30:00'},{userId:'A',timestamp:'2026-11-07T02:00:00Z'}]);
  assert.deepEqual(grouped[0].punches,['2026-11-07T02:00:00Z','2026-11-07 09:30:00']);
});
test('empty attendance has no negative break count and timestamps ignore host timezone',()=>{
  assert.equal(calculateAttendanceDay([],new Date('2026-11-07T10:00:00Z')).breakCount,0);
  assert.equal(timestampFromDate(new Date('2026-11-07T23:00:00Z')),'2026-11-08 04:30:00');
});
