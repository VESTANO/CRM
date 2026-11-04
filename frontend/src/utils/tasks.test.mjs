import assert from "node:assert/strict";
import test from "node:test";
import { getTaskStatus, isTaskOverdue, nextTaskDeadlineDelay, compareNewestTasks } from "./tasks.js";

const now = Date.parse("2026-11-03T16:37:00+05:30");

test("unfinished tasks past their deadline are overdue", () => {
  assert.equal(getTaskStatus({ status: "pending", due_at: "2026-10-13T18:26:00+05:30" }, now), "overdue");
});

test("review states stay distinct and rejected tasks continue tracking their deadline", () => {
  const due_at = new Date(now - 1000).toISOString();
  assert.equal(getTaskStatus({ status: "submitted", due_at }, now), "submitted");
  assert.equal(isTaskOverdue({ status: "submitted", due_at }, now), false);
  assert.equal(getTaskStatus({ status: "rejected", due_at }, now), "rejected");
  assert.equal(isTaskOverdue({ status: "rejected", due_at }, now), true);
  assert.equal(getTaskStatus({ status: "done", current_submission: { status: "approved" }, due_at }, now), "approved");
  assert.equal(nextTaskDeadlineDelay([{ status: "rejected", due_at: new Date(now + 1000).toISOString() }], now), 1001);
});

test("future tasks remain pending", () => {
  assert.equal(getTaskStatus({ status: "pending", due_at: "2026-11-10T16:18:00+05:30" }, now), "pending");
});

test("completed tasks remain completed even with a past deadline", () => {
  assert.equal(getTaskStatus({ status: "done", due_at: "2026-10-13T18:26:00+05:30" }, now), "completed");
});

test("missing and invalid deadlines do not make tasks overdue", () => {
  for (const due_at of [null, undefined, "", "invalid"]) {
    assert.equal(getTaskStatus({ status: "pending", due_at }, now), "pending");
  }
});

test("a task becomes overdue immediately after its exact deadline", () => {
  const task = { status: "pending", due_at: new Date(now).toISOString() };
  assert.equal(getTaskStatus(task, now), "pending");
  assert.equal(nextTaskDeadlineDelay([task], now), 1);
  assert.equal(getTaskStatus(task, now + 1), "overdue");
});

test("UTC and India timestamps identify the same deadline", () => {
  for (const due_at of ["2026-11-03T16:36:00+05:30", "2026-11-03T11:06:00Z"]) {
    assert.equal(getTaskStatus({ status: "pending", due_at }, now), "overdue");
  }
});

test("the next refresh targets the earliest unfinished deadline", () => {
  const tasks = [
    { status: "done", due_at: new Date(now + 10).toISOString() },
    { status: "pending", due_at: new Date(now - 1000).toISOString() },
    { status: "pending", due_at: new Date(now + 5000).toISOString() },
    { status: "pending", due_at: new Date(now + 2000).toISOString() },
    { status: "pending", due_at: "invalid" },
  ];
  assert.equal(nextTaskDeadlineDelay(tasks, now), 2001);
});

test("no timer is needed when there are no upcoming deadlines", () => {
  assert.equal(nextTaskDeadlineDelay(null, now), null);
  assert.equal(nextTaskDeadlineDelay([], now), null);
  assert.equal(nextTaskDeadlineDelay([{ status: "done", due_at: new Date(now + 1000).toISOString() }], now), null);
});

test("distant deadlines stay within the browser timer limit", () => {
  assert.equal(nextTaskDeadlineDelay([{ status: "pending", due_at: "2036-11-03T16:37:00+05:30" }], now), 2_147_483_647);
});

test("new assignments appear first regardless of status or due date", () => {
  const tasks = [
    { id: 1, status: "rejected", created_at: "2026-11-01T10:00:00Z", due_at: "2026-11-02T10:00:00Z" },
    { id: 2, status: "pending", created_at: "2026-11-04T10:00:00Z", due_at: "2026-12-01T10:00:00Z" },
    { id: 3, status: "done", created_at: "2026-11-03T10:00:00Z" },
    { id: 4, status: "pending", created_at: "2026-11-04T15:30:00+05:30" },
  ];
  assert.deepEqual(tasks.sort(compareNewestTasks).map((task) => task.id), [4, 2, 3, 1]);
});
