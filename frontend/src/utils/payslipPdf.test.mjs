import assert from "node:assert/strict";
import test from "node:test";
import { createPayslipPdf } from "./payslipPdf.js";

test("creates a downloadable PDF payslip with payroll details", async () => {
  const blob = createPayslipPdf({
    employee_name: "Test Employee",
    payroll_month: "2026-11-01",
    status: "paid",
    basic_salary: 10000,
    allowance_amount: 500,
    overtime_amount: 250,
    reimbursement_amount: 100,
    lop_deduction: 300,
    deduction_amount: 50,
    advance_recovery: 100,
    net_amount: 10400,
    paid_amount: 10400,
    remaining_amount: 0,
  }, [{ payment_date: "2026-11-30", payment_method: "bank_transfer", reference_number: "TX-1" }]);

  assert.equal(blob.type, "application/pdf");
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(bytes.toString(), /Test Employee/);
  assert.match(bytes.toString(), /INR 10,400\.00/);
  assert.match(bytes.toString(), /TX-1/);
  assert.match(bytes.toString(), /%%EOF$/);
});
