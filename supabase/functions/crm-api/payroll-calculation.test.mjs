import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./index.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""),
);
const storeId = "00000000-0000-4000-8000-000000000011";
const employeeId = "00000000-0000-4000-8000-000000000012";
const context = { user: { id: "00000000-0000-4000-8000-000000000001" }, profile: { role: "admin", store_id: storeId } };

// A deterministic PostgREST-shaped adapter for the actual payroll calculator.
// It deliberately applies every filter used by calculatePayroll so that a
// change to eligibility/status/date logic is caught by these regressions.
function clientFor(tables) {
  return {
    from(table) {
      const filters = [];
      let limit = null;
      let range = null;
      const matches = (row) => filters.every(([operator, key, value]) => {
        const actual = row[key];
        if (operator === "=") return actual === value;
        if (operator === ">") return actual > value;
        if (operator === ">=") return actual >= value;
        if (operator === "<") return actual < value;
        if (operator === "in") return value.includes(actual);
        if (operator === "is") return actual === value;
        return false;
      });
      const run = () => {
        let data = (tables[table] || []).filter(matches);
        if (limit !== null) data = data.slice(0, limit);
        if (range) data = data.slice(range[0], range[1] + 1);
        return { data: structuredClone(data), error: null };
      };
      const query = {
        select: () => query,
        eq: (key, value) => { filters.push(["=", key, value]); return query; },
        gt: (key, value) => { filters.push([">", key, value]); return query; },
        gte: (key, value) => { filters.push([">=", key, value]); return query; },
        lt: (key, value) => { filters.push(["<", key, value]); return query; },
        in: (key, value) => { filters.push(["in", key, value]); return query; },
        is: (key, value) => { filters.push(["is", key, value]); return query; },
        order: () => query,
        limit: (value) => { limit = value; return query; },
        range: (from, to) => { range = [from, to]; return query; },
        maybeSingle: async () => ({ ...run(), data: run().data[0] || null }),
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject),
      };
      return query;
    },
  };
}

function payrollCalculator(tables) {
  const api = new Function("createClient", "Deno", "corsHeaders", `${source}; return { calculatePayroll };`)(
    () => clientFor(tables), { env: { get: () => "" }, serve: () => {} }, {},
  );
  return api.calculatePayroll;
}

function fixtures(overrides = {}) {
  return {
    profiles: [{ id: employeeId, name: "Asha", employee_id: "EMP01", store_id: storeId, role: "employee", active: true }],
    crm_payroll_settings: [{ store_id: storeId, payroll_days_per_month: 26, default_overtime_rate: 25 }],
    crm_salary_structures: [{ id: "00000000-0000-4000-8000-000000000100", store_id: storeId, employee_id: employeeId, effective_from: "2026-01-01", basic_salary: 2600, overtime_rate: 100 }],
    // 2026-02-01T19:30Z is 02-Feb in India. This boundary value protects
    // payroll from counting a valid late-evening UTC punch against 01-Feb.
    attendance_records: [
      { user_id: employeeId, punched_at: "2026-02-01T19:30:00.000Z" },
      { user_id: employeeId, punched_at: "2026-02-03T04:00:00.000Z" },
    ],
    attendance_leave_days: [
      { user_id: employeeId, leave_date: "2026-02-04", leave_type: "paid" },
      { user_id: employeeId, leave_date: "2026-02-05", leave_type: "unpaid" },
    ],
    crm_overtime_requests: [{ employee_id: employeeId, status: "approved", work_date: "2026-02-06", approved_minutes: 90 }],
    crm_expense_claims: [
      { id: "00000000-0000-4000-8000-000000000201", store_id: storeId, employee_id: employeeId, status: "approved", reimbursable: true, reimbursed_payment_id: null, expense_date: "2026-02-10", amount: 200 },
      { id: "00000000-0000-4000-8000-000000000202", store_id: storeId, employee_id: employeeId, status: "submitted", reimbursable: true, reimbursed_payment_id: null, expense_date: "2026-02-10", amount: 999 },
      { id: "00000000-0000-4000-8000-000000000203", store_id: storeId, employee_id: employeeId, status: "approved", reimbursable: false, reimbursed_payment_id: null, expense_date: "2026-02-10", amount: 999 },
      { id: "00000000-0000-4000-8000-000000000204", store_id: storeId, employee_id: employeeId, status: "approved", reimbursable: true, reimbursed_payment_id: "previous-payment", expense_date: "2026-02-10", amount: 999 },
    ],
    crm_salary_advances: [{ id: "00000000-0000-4000-8000-000000000301", store_id: storeId, employee_id: employeeId, status: "approved", remaining_amount: 300, created_at: "2026-01-01" }],
    crm_visits: [
      { id: 1, store_id: storeId, owner_id: employeeId, visit_date: "2026-02-11", expense: 50 },
      { id: 2, store_id: storeId, owner_id: employeeId, visit_date: "2026-02-12", expense: 75 },
      { id: 3, store_id: storeId, owner_id: employeeId, visit_date: "2026-02-13", expense: 0 },
    ],
    crm_payroll_visit_expenses: [{ payment_id: "previous-payment", visit_id: 2, amount: 75 }],
    ...overrides,
  };
}

test("payroll calculation uses approved sources once and correctly totals a manually checked month", async () => {
  const result = await payrollCalculator(fixtures())(context, storeId, employeeId, "2026-02");

  // February 2026 has 24 non-Sunday work days. Two present days and one of
  // each leave type produce 20 absences and 21 unpaid/LOP days in total.
  assert.equal(result.present_days, 2);
  assert.equal(result.paid_leave_days, 1);
  assert.equal(result.unpaid_leave_days, 1);
  assert.equal(result.absent_days, 20);
  assert.equal(result.lop_deduction, 2100);
  assert.equal(result.overtime_hours, 1.5);
  // The store-wide Payroll Settings rate is authoritative. A legacy OT rate
  // on an old employee salary revision must not silently override it.
  assert.equal(result.overtime_rate, 25);
  assert.equal(result.overtime_amount, 37.5);
  assert.equal(result.expense_claim_amount, 200);
  assert.equal(result.sales_expense_amount, 50);
  assert.equal(result.reimbursement_amount, 250);
  assert.deepEqual(result.reimbursement_claims.map((claim) => claim.id), ["00000000-0000-4000-8000-000000000201"]);
  assert.deepEqual(result.sales_visit_expenses.map((visit) => visit.id), [1]);
  assert.equal(result.advances[0].remaining_amount, 300);
});

test("zero approved overtime hours always produces zero overtime pay", async () => {
  const result = await payrollCalculator(fixtures({ crm_overtime_requests: [] }))(context, storeId, employeeId, "2026-02");
  assert.equal(result.overtime_hours, 0);
  assert.equal(result.overtime_rate, 25);
  assert.equal(result.overtime_amount, 0);
});

test("future payroll months never create future absence or LOP deductions", async () => {
  const result = await payrollCalculator(fixtures({ attendance_records: [], attendance_leave_days: [], crm_overtime_requests: [], crm_expense_claims: [], crm_visits: [], crm_payroll_visit_expenses: [] }))(context, storeId, employeeId, "2099-02");
  assert.equal(result.present_days, 0);
  assert.equal(result.absent_days, 0);
  assert.equal(result.unpaid_leave_days, 0);
  assert.equal(result.lop_deduction, 0);
});

test("payroll calculation requires an active in-store employee and a salary structure", async () => {
  const withoutSalary = fixtures({ crm_salary_structures: [] });
  await assert.rejects(payrollCalculator(withoutSalary)(context, storeId, employeeId, "2026-02"), (error) => error.status === 400 && /salary structure/i.test(error.message));
  const inactive = fixtures({ profiles: [{ ...fixtures().profiles[0], active: false }] });
  await assert.rejects(payrollCalculator(inactive)(context, storeId, employeeId, "2026-02"), (error) => error.status === 400 && /active employee/i.test(error.message));
});
