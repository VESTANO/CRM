import { test, expect } from '@playwright/test';
import { mobileWidths, shellFixture } from './helpers/mobile-shell-fixture.js';

const widths = [...mobileWidths, 1440];
const employeeId = '00000000-0000-4000-8000-000000000021';
const longName = 'ManualAttendanceAndPayrollEmployeeWithAnIntentionallyLongDisplayName'.repeat(2);

async function fixture(page) {
  const app = await shellFixture(page, { role: 'admin' });
  const employee = { id: employeeId, name: longName, employee_id: 'MANUAL-EMPLOYEE-001', employeeId: 'MANUAL-EMPLOYEE-001', role: 'employee', active: true };
  const payroll = { id: 1, employee_id: employeeId, employee_name: longName, employee_code: employee.employee_id, payroll_month: '2026-11', basic_salary: 325435, gross_amount: 350435, allowance_amount: 10000, overtime_hours: 2, overtime_rate: 500, overtime_amount: 1000, sales_expense_amount: 4000, expense_claim_amount: 0, lop_deduction: 0, deduction_amount: 0, advance_recovery: 0, net_amount: 350435, present_days: 26, absent_days: 0, status: 'approved' };
  await page.route('http://127.0.0.1:54321/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json = null;
    if (path.endsWith('/attendance/manual/employees/')) {
      json = { results: [{ ...employee, state: 'not_started' }] };
    } else if (path.endsWith('/attendance/manual/records/')) {
      json = { results: [{ userId: employeeId, employeeName: longName, employeeId: employee.employee_id, checkIn: '2026-11-12T09:30:00+05:30', checkOut: '2026-11-12T17:30:00+05:30', breakMinutes: 30, workingMinutes: 450, notes: ['Store roster'], status: 'checked_out' }] };
    } else if (path.endsWith('/payroll/payments/')) {
      json = { results: [payroll] };
    } else if (path.endsWith('/payroll/employees/')) {
      json = { results: [employee] };
    } else if (path.endsWith('/payroll/salary-structures/')) {
      json = { results: [{ id: 1, employee_id: employeeId, employee_name: longName, effective_from: '2026-11-01', basic_salary: 325435, bank_name: 'Long Test Bank Name' }] };
    } else if (path.endsWith('/payroll/expenses/') || path.endsWith('/payroll/advances/')) {
      json = { results: [] };
    } else if (path.endsWith('/payroll/reports/')) {
      json = { month: '2026-11', results: [payroll], totals: { payroll: 350435, reimbursements: 0, lopDeductions: 0, overtime: 1000 } };
    } else if (path.endsWith('/payroll/settings/')) {
      json = { payroll_days_per_month: 30, paid_leave_allowance: 1, default_allowance_amount: 10000, default_overtime_rate: 500 };
    }
    if (json === null) return route.fallback();
    return route.fulfill({ json, headers: { 'access-control-allow-origin': '*' } });
  });
  return app;
}

async function expectResponsive(page, label, width) {
  const result = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const overflow = [...document.querySelectorAll('.content-wrap *')]
      .filter((element) => visible(element) && !element.closest('.table-responsive,svg,.offcanvas,[hidden]'))
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.left < -1 || rect.right > viewport + 1)
      .slice(0, 8)
      .map(({ element, rect }) => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80), left: rect.left, right: rect.right }));
    return { viewport, documentWidth: document.documentElement.scrollWidth, overflow };
  });
  expect(result.documentWidth, `${label} at ${width}px document overflow`).toBeLessThanOrEqual(width + 1);
  expect(result.overflow, `${label} at ${width}px visible overflow`).toEqual([]);
}

for (const width of widths) test(`${width}px manual attendance and payroll pages remain responsive`, async ({ page }) => {
  await page.setViewportSize({ width, height: 740 });
  const app = await fixture(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto('/attendance/manual');
  await expect(page.getByRole('heading', { name: 'Manual Attendance', exact: true })).toBeVisible();
  await expectResponsive(page, 'Manual attendance check-in', width);
  await page.getByRole('button', { name: 'Break', exact: true }).click();
  await expect(page.getByLabel('Break end time', { exact: true })).toBeVisible();
  await expectResponsive(page, 'Manual attendance break', width);

  await page.goto('/attendance/manual/records');
  await expect(page.getByRole('heading', { name: 'Employee Attendance', exact: true })).toBeVisible();
  await expectResponsive(page, 'Manual attendance records', width);

  for (const [path, heading] of [
    ['/payroll/overview', 'Payroll Overview'],
    ['/payroll/salaries', 'Employee Salary Management'],
    ['/payroll/process', 'Process Payroll'],
    ['/payroll/payslips', 'Payslips'],
    ['/payroll/settings', 'Payroll Settings'],
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectResponsive(page, heading, width);
  }

  expect(errors).toEqual([]);
  expect(app.mutations).toEqual([]);
});
