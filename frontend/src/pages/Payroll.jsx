import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "../hooks/useAuth.jsx";
import { useStoreContext } from "../hooks/useStoreContext.js";
import { payrollApi } from "../services/api.js";
import { downloadPayslipPdf } from "../utils/payslipPdf.js";

const money = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const month = () => today().slice(0, 7);
const number = (value) => Number(value || 0);
const blankSalary = () => ({ employee_id: "", effective_from: today(), basic_salary: "", allowance_amount: "0", overtime_rate: "0", bank_account_holder: "", bank_name: "", bank_account_number: "", bank_ifsc: "", notes: "" });
const blankExpense = () => ({ expense_date: today(), category: "Travel", description: "", amount: "", reimbursable: true });
const blankAdvance = () => ({ amount: "", reason: "" });
const blankPayment = () => ({ employee_id: "", payroll_month: month(), allowance_amount: "", overtime_hours: "", overtime_rate: "", bonus_amount: "0", deduction_amount: "0", advance_recovery: "0", sales_expense_amount: "", notes: "" });

function Badge({ status }) { const style = status === "approved" || status === "paid" || status === "closed" ? "text-bg-success" : status === "rejected" ? "text-bg-danger" : status === "submitted" ? "text-bg-primary" : "text-bg-secondary"; return <span className={`badge ${style}`}>{String(status).replace("_", " ")}</span>; }
function FormButton({ children, busy, className = "btn btn-primary", ...props }) { return <button className={className} disabled={busy} {...props}>{busy ? "Saving…" : children}</button>; }
function Field({ label, children }) { return <div className="col-md-4"><label className="form-label">{label}</label>{children}</div>; }

export default function Payroll() {
  const { user, csrfToken } = useAuth(); const storeId = useStoreContext();
  const { section } = useParams();
  const superAdmin = Boolean(user?.is_superuser); const admin = Boolean(user?.is_admin);
  const [data, setData] = useState({ payments: [], employees: [], salaries: [], expenses: [], advances: [], report: null, settings: null });
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [message, setMessage] = useState("");
  const alertRef = useRef(null);
  const [salary, setSalary] = useState(blankSalary); const [expense, setExpense] = useState(blankExpense); const [advance, setAdvance] = useState(blankAdvance); const [payment, setPayment] = useState(blankPayment); const [calculation, setCalculation] = useState(null); const [paymentDraftOpen, setPaymentDraftOpen] = useState(false); const [editingPaymentId, setEditingPaymentId] = useState("");

  const announcePayrollUpdate = () => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("vestatrack-payroll-updates");
    channel.postMessage({ storeId });
    channel.close();
  };

  const load = async () => {
    if (superAdmin && !storeId) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const jobs = [payrollApi.list(), payrollApi.expenses(), payrollApi.advances()];
      if (admin) jobs.push(payrollApi.employees(), payrollApi.salaryStructures(), payrollApi.reports(month()), payrollApi.settings());
      const replies = await Promise.all(jobs); let index = 0;
      const next = { payments: replies[index++].data.results || [], expenses: replies[index++].data.results || [], advances: replies[index++].data.results || [], employees: [], salaries: [], report: null, settings: null };
      if (admin) { next.employees = replies[index++].data.results || []; next.salaries = replies[index++].data.results || []; next.report = replies[index++].data; next.settings = replies[index++].data; }
      setData(next);
    } catch (requestError) { setError(requestError.response?.data?.detail || "Unable to load payroll."); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [storeId, admin, superAdmin]);
  useEffect(() => {
    if (superAdmin && !storeId) return undefined;
    let active = true;
    const refreshLiveData = async () => {
      if (!active || document.hidden || !navigator.onLine) return;
      try {
        const [paymentsReply, expensesReply, advancesReply] = await Promise.all([payrollApi.list(), payrollApi.expenses(), payrollApi.advances()]);
        if (!active) return;
        setData((current) => ({
          ...current,
          payments: paymentsReply.data.results || [],
          expenses: expensesReply.data.results || [],
          advances: advancesReply.data.results || [],
        }));
      } catch {
        // Keep the last successful payroll state during a background outage.
        // The normal page error remains reserved for user-initiated requests.
      }
    };
    const refreshWhenVisible = () => { if (!document.hidden) void refreshLiveData(); };
    const interval = window.setInterval(refreshWhenVisible, 5000);
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("vestatrack-payroll-updates");
    if (channel) channel.onmessage = (event) => { if (!event.data?.storeId || event.data.storeId === storeId) void refreshLiveData(); };
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      channel?.close();
      window.removeEventListener("focus", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [storeId, superAdmin]);
  useEffect(() => {
    if (!error) return undefined;
    const frame = window.requestAnimationFrame(() => alertRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    const timer = window.setTimeout(() => setError(""), 3000);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, [error]);
  const save = async (task, success) => { setBusy(true); setError(""); setMessage(""); try { await task(); setMessage(success); announcePayrollUpdate(); await load(); } catch (requestError) { const details = requestError.response?.data?.errors; setError(details ? Object.values(details).flat().join(" ") : requestError.response?.data?.detail || "Unable to save the payroll change."); } finally { setBusy(false); } };
  const runCalculation = async () => { setBusy(true); setError(""); try { const reply = await payrollApi.calculate({ employee_id: payment.employee_id, payroll_month: payment.payroll_month }, csrfToken); setCalculation(reply.data); setPayment((current) => ({ ...current, allowance_amount: current.allowance_amount === "" ? String(reply.data.salary?.allowance_amount || reply.data.settings?.default_allowance_amount || 0) : current.allowance_amount, overtime_hours: current.overtime_hours === "" ? String(reply.data.overtime_hours || 0) : current.overtime_hours, overtime_rate: current.overtime_rate === "" ? String(reply.data.overtime_rate || 0) : current.overtime_rate, sales_expense_amount: String(reply.data.sales_expense_amount || 0) })); } catch (requestError) { setError(requestError.response?.data?.detail || "Unable to calculate payroll. Add a salary structure first."); setCalculation(null); } finally { setBusy(false); } };
  const requestPayment = async (status) => save(async () => { if (editingPaymentId) await payrollApi.update(editingPaymentId, { ...payment, status }, csrfToken); else await payrollApi.create({ ...payment, status }, csrfToken); setPayment(blankPayment()); setCalculation(null); setPaymentDraftOpen(false); setEditingPaymentId(""); }, status === "approved" ? "Payroll finalized." : editingPaymentId ? "Payroll changes saved." : "Payroll calculation saved as a draft.");
  const editPayment = (record) => {
    const savedCalculation = record.calculation && typeof record.calculation === "object" ? record.calculation : {};
    setPayment({ ...blankPayment(), employee_id: record.employee_id, payroll_month: String(record.payroll_month).slice(0, 7), allowance_amount: String(record.allowance_amount || 0), overtime_hours: String(record.overtime_hours || 0), overtime_rate: String(record.overtime_rate || 0), bonus_amount: String(record.bonus_amount || 0), deduction_amount: String(record.deduction_amount || 0), advance_recovery: String(record.advance_recovery || 0), sales_expense_amount: String(record.sales_expense_amount || 0), notes: record.notes || "" });
    setCalculation({ ...savedCalculation, basic_salary: record.basic_salary, allowance_amount: record.allowance_amount, present_days: savedCalculation.present_days ?? record.present_days, absent_days: savedCalculation.absent_days ?? record.absent_days, paid_leave_days: savedCalculation.paid_leave_days ?? record.paid_leave_days, unpaid_leave_days: savedCalculation.unpaid_leave_days ?? record.unpaid_leave_days, overtime_hours: savedCalculation.overtime_hours ?? record.overtime_hours, overtime_rate: savedCalculation.overtime_rate ?? record.overtime_rate, overtime_amount: savedCalculation.overtime_amount ?? record.overtime_amount, sales_expense_amount: record.sales_expense_amount, expense_claim_amount: record.expense_claim_amount, lop_deduction: record.lop_deduction });
    setEditingPaymentId(record.id); setPaymentDraftOpen(true);
    window.requestAnimationFrame(() => document.getElementById("payroll-calculation-form")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  if (superAdmin && !storeId) return <section className="panel"><h1 className="h3">Payroll</h1><p className="text-secondary">Choose a store to access payroll records.</p><Link className="btn btn-outline-primary" to="/admin-panel/stores">Choose a store</Link></section>;
  const allowedSections = admin ? ["overview", "salaries", "process", "payslips", "settings"] : ["my-salary", "expenses", "payslips"];
  const defaultSection = admin ? "overview" : "my-salary";
  if (!section) return <Navigate to={`/payroll/${defaultSection}`} replace />;
  if (!allowedSections.includes(section)) return <Navigate to={`/payroll/${defaultSection}`} replace />;
  const titles = {
    overview: ["Payroll Overview", "Monthly payroll status and employee salary summary."],
    salaries: ["Employee Salary Management", "Manage basic salary, bank details, and revision history."],
    process: ["Process Payroll", "Calculate, review, finalize, and adjust monthly payroll."],
    payslips: [admin ? "Payslips" : "My Payslips", admin ? "Generate and download employee payslips." : "View and download your approved payslips."],
    settings: ["Payroll Settings", superAdmin ? "Configure payroll rules for this store." : "View the payroll rules configured for this store."],
    "my-salary": ["My Salary", "View your salary earnings, reimbursements, deductions, and advances."],
    expenses: ["My Expenses", "Submit reimbursable expense claims and track their approval status."],
  };
  const [pageTitle, pageDescription] = titles[section];
  return <div>
    <nav aria-label="breadcrumb" className="mb-3"><ol className="breadcrumb mb-0"><li className="breadcrumb-item"><Link to="/dashboard">Dashboard</Link></li><li className="breadcrumb-item"><Link to={`/payroll/${defaultSection}`}>Payroll</Link></li><li className="breadcrumb-item active">{pageTitle}</li></ol></nav>
    <div className="page-header mb-4"><div className="eyebrow">{superAdmin ? "Super Admin" : admin ? "Admin" : "Employee"} workspace</div><h1 className="h2 mb-2">{pageTitle}</h1><p className="text-secondary mb-0">{pageDescription}</p></div>
    {error && <div ref={alertRef} className="alert alert-danger" role="alert">{error}</div>}{message && <div className="alert alert-success" role="status">{message}</div>}
    <div className="d-flex justify-content-end mb-4"><button type="button" className="btn btn-outline-secondary btn-sm" onClick={() => void load()} disabled={loading}><i className="bi bi-arrow-clockwise me-1" />Refresh</button></div>
    {loading ? <section className="panel">Loading payroll…</section> : <>
      {section === "overview" && admin && <PayrollOverview employees={data.employees} payments={data.payments} report={data.report} />}
      {section === "salaries" && admin && <SalaryTab employees={data.employees} salary={salary} setSalary={setSalary} structures={data.salaries} busy={busy} onSave={() => save(async () => { await payrollApi.createSalaryStructure(salary, csrfToken); setSalary(blankSalary()); }, "Salary structure saved. The same effective date is updated; a new date creates revision history.")} />}
      {section === "process" && admin && <><PayrollTab admin={admin} superAdmin={superAdmin} csrfToken={csrfToken} data={data} payment={payment} setPayment={setPayment} calculation={calculation} setCalculation={setCalculation} paymentDraftOpen={paymentDraftOpen} setPaymentDraftOpen={setPaymentDraftOpen} editingPaymentId={editingPaymentId} setEditingPaymentId={setEditingPaymentId} busy={busy} onCalculate={runCalculation} onSave={requestPayment} onEditPayment={editPayment} onApprove={(id) => save(() => payrollApi.approve(id, csrfToken), "Payroll finalized.")} onReject={(id) => save(() => payrollApi.reject(id, { note: "Rejected during payroll review" }, csrfToken), "Payroll rejected and linked reimbursements released.")} /><ApprovalsTab superAdmin={superAdmin} expenses={data.expenses} advances={data.advances} payments={data.payments} busy={busy} onReviewExpense={(id, status) => save(() => payrollApi.reviewExpense(id, { status }, csrfToken), `Expense ${status}.`)} onReviewAdvance={(id, status, amount) => save(() => payrollApi.reviewAdvance(id, { status, approved_amount: amount }, csrfToken), `Salary advance ${status}.`)} onApprovePayroll={(id) => save(() => payrollApi.approve(id, csrfToken), "Payroll finalized.")} onRejectPayroll={(id) => save(() => payrollApi.reject(id, { note: "Rejected during payroll review" }, csrfToken), "Payroll rejected.")} /></>}
      {section === "payslips" && <PayslipsTab admin={admin} payments={data.payments} onDownload={(id) => save(() => downloadPayslip(id), "Payslip downloaded.")} />}
      {section === "settings" && admin && <SettingsTab settings={data.settings} busy={busy} readOnly={false} onSave={(settings) => save(() => payrollApi.updateSettings(settings, csrfToken), "Payroll settings updated.")} />}
      {section === "my-salary" && !admin && <><MySalaryTab payments={data.payments} advances={data.advances} /><div className="mt-4"><AdvanceTab admin={false} advances={data.advances} advance={advance} setAdvance={setAdvance} busy={busy} onSave={() => save(async () => { await payrollApi.createAdvance(advance, csrfToken); setAdvance(blankAdvance()); }, "Salary advance request submitted.")} onReview={() => {}} /></div></>}
      {section === "expenses" && !admin && <ExpenseTab admin={false} expenses={data.expenses} expense={expense} setExpense={setExpense} busy={busy} onSave={() => save(async () => { await payrollApi.createExpense(expense, csrfToken); setExpense(blankExpense()); }, "Expense claim submitted.")} onReview={() => {}} />}
    </>}
  </div>;
}

async function downloadPayslip(id) {
  const reply = await payrollApi.payslip(id);
  downloadPayslipPdf(reply.data.payment, reply.data.transactions || []);
}

function PayrollOverview({ employees, payments, report }) {
  const currentMonth = month();
  const current = payments.filter((item) => String(item.payroll_month).slice(0, 7) === currentMonth);
  const processedEmployees = new Set(current.map((item) => item.employee_id));
  const cards = [
    ["Total employees", employees.length, "All active employees", "bi-people"],
    ["Monthly payroll", money.format(number(report?.totals?.payroll)), "Total salary payable", "bi-cash-stack"],
    ["Processed", current.length, "Completed salary calculations", "bi-check2-circle"],
    ["Pending", Math.max(0, employees.length - processedEmployees.size), "Employees awaiting processing", "bi-hourglass-split"],
  ];
  return <>
    <section className="row g-3 mb-4">{cards.map(([label, value, detail, icon]) => <div className="col-12 col-sm-6 col-xl-4" key={label}><div className="panel h-100"><div className="d-flex align-items-start justify-content-between gap-3"><div><div className="text-secondary small">{label}</div><div className="h3 mt-2 mb-1">{value}</div><div className="small text-secondary">{detail}</div></div><span className="metric-icon"><i className={`bi ${icon}`} /></span></div></div></div>)}</section>
    <ReportsTab report={report} />
  </>;
}

function MySalaryTab({ payments, advances }) {
  const latest = payments[0];
  if (!latest) return <section className="panel"><h2 className="h5">Salary details</h2><p className="text-secondary mb-0">Your approved salary details will appear here after payroll is finalized.</p></section>;
  const deductions = number(latest.lop_deduction) + number(latest.deduction_amount) + number(latest.advance_recovery);
  return <>
    <section className="panel mb-4"><div className="d-flex flex-wrap justify-content-between gap-2"><div><div className="eyebrow">LATEST SALARY</div><h2 className="h5 mb-1">{String(latest.payroll_month).slice(0, 7)}</h2></div><Badge status={latest.status} /></div><div className="row g-3 mt-1"><Metric label="Basic salary" value={money.format(number(latest.basic_salary))} /><Metric label="Allowances" value={money.format(number(latest.allowance_amount))} /><Metric label="Approved overtime" value={money.format(number(latest.overtime_amount))} /><Metric label="Expense reimbursements" value={money.format(number(latest.reimbursement_amount))} /><Metric label="Leave and other deductions" value={money.format(deductions)} /><Metric label="Final net salary" value={money.format(number(latest.net_amount))} /></div></section>
    <section className="panel"><h2 className="h5">Salary advance balance</h2><p className="text-secondary mb-0">Remaining approved advance: <strong>{money.format(advances.filter((item) => ["approved", "closed"].includes(item.status)).reduce((sum, item) => sum + number(item.remaining_amount), 0))}</strong></p></section>
  </>;
}

function PayslipsTab({ admin, payments, onDownload }) {
  const available = payments.filter((item) => ["approved", "paid"].includes(item.status));
  return <section className="panel"><h2 className="h5">{admin ? "Employee payslips" : "My payslips"}</h2><div className="table-responsive"><table className="table table-hover align-middle"><thead className="table-light"><tr>{admin && <th>Employee</th>}<th>Month</th><th>Basic</th><th>Allowances</th><th>Deductions</th><th>Net salary</th><th>Status</th><th>Download</th></tr></thead><tbody>{available.map((item) => <tr key={item.id}>{admin && <td>{item.employee_name}</td>}<td>{String(item.payroll_month).slice(0, 7)}</td><td>{money.format(number(item.basic_salary))}</td><td>{money.format(number(item.allowance_amount))}</td><td>{money.format(number(item.lop_deduction) + number(item.deduction_amount) + number(item.advance_recovery))}</td><td><strong>{money.format(number(item.net_amount))}</strong></td><td><Badge status={item.status} /></td><td><button className="btn btn-sm btn-outline-primary" type="button" onClick={() => void onDownload(item.id)}><i className="bi bi-download me-1" />Download PDF</button></td></tr>)}{!available.length && <tr><td className="text-center text-secondary py-4" colSpan={admin ? 8 : 7}>No approved payslips are available.</td></tr>}</tbody></table></div></section>;
}

function PayrollTab({ admin, superAdmin, csrfToken, hideRecords = false, data, payment, setPayment, calculation, setCalculation, paymentDraftOpen, setPaymentDraftOpen, editingPaymentId, setEditingPaymentId, busy, onCalculate, onSave, onEditPayment, onApprove, onReject }) {
  const change = (event) => setPayment((current) => ({ ...current, [event.target.name]: event.target.value }));
  const correctionActionsRef = useRef(null);
  const previousCalculationRef = useRef(calculation);
  const [expensePreview, setExpensePreview] = useState(null);
  const [expensePreviewLoading, setExpensePreviewLoading] = useState(false);
  const [expensePreviewError, setExpensePreviewError] = useState(false);
  const [overtimePreviewLoading, setOvertimePreviewLoading] = useState(false);
  const [calculationPreviewError, setCalculationPreviewError] = useState("");
  const printPayslip = async (id) => { const reply = await payrollApi.payslip(id); const item = reply.data.payment; const page = window.open("", "_blank", "noopener,noreferrer"); if (!page) return; page.document.write(`<title>Payslip ${item.payroll_month}</title><h1>VestaTrack Payslip</h1><h2>${item.employee_name} · ${String(item.payroll_month).slice(0, 7)}</h2><p>Basic: ${money.format(number(item.basic_salary))}</p><p>Sales visit expenses: ${money.format(number(item.sales_expense_amount))}</p><p>Other approved expenses: ${money.format(number(item.expense_claim_amount))}</p><p>Overtime: ${money.format(number(item.overtime_amount))}</p><p>LOP deduction: ${money.format(number(item.lop_deduction))}</p><h2>Net payable: ${money.format(number(item.net_amount))}</h2>`); page.document.close(); page.print(); };
  const payrollForMonth = (employeeId, payrollMonth = payment.payroll_month) => data.payments.find((item) => item.employee_id === employeeId && String(item.payroll_month).slice(0, 7) === payrollMonth);
  const salaryForMonth = (employeeId, payrollMonth) => data.salaries.find((item) => item.employee_id === employeeId && String(item.effective_from || "") <= `${payrollMonth}-31`);
  const selectedPayroll = payment.employee_id ? payrollForMonth(payment.employee_id) : null;
  const selectedSalary = payment.employee_id && payment.payroll_month ? salaryForMonth(payment.employee_id, payment.payroll_month) : null;
  const allowanceFieldValue = payment.allowance_amount === "" ? String(selectedSalary?.allowance_amount || data.settings?.default_allowance_amount || 0) : payment.allowance_amount;
  const overtimeHoursFieldValue = payment.overtime_hours === "" ? String(calculation?.overtime_hours || 0) : payment.overtime_hours;
  const overtimeRateFieldValue = payment.overtime_rate === "" ? String(data.settings?.default_overtime_rate || 0) : payment.overtime_rate;
  const selectedPayrollLocked = selectedPayroll && !["draft", "submitted", "rejected"].includes(selectedPayroll.status);
  const selectedPayrollRejected = selectedPayroll?.status === "rejected";
  useEffect(() => {
    const calculationChanged = calculation && calculation !== previousCalculationRef.current;
    previousCalculationRef.current = calculation;
    if (!calculationChanged || !selectedPayrollRejected) return undefined;
    const frame = window.requestAnimationFrame(() => correctionActionsRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    return () => window.cancelAnimationFrame(frame);
  }, [calculation, selectedPayrollRejected]);
  const matchingExpenseClaims = data.expenses.filter((item) => item.employee_id === payment.employee_id && String(item.expense_date || "").slice(0, 7) === payment.payroll_month);
  const eligibleClaimAmount = matchingExpenseClaims.filter((item) => item.status === "approved" && item.reimbursable && !item.reimbursed_payment_id).reduce((sum, item) => sum + number(item.amount), 0);
  const expenseClaimsVersion = matchingExpenseClaims.map((item) => [item.id, item.status, item.amount, item.reimbursable, item.reimbursed_payment_id].join(":" )).join("|");
  useEffect(() => {
    if (!paymentDraftOpen || !payment.employee_id || !payment.payroll_month) { setExpensePreview(null); setExpensePreviewLoading(false); setExpensePreviewError(false); return undefined; }
    let active = true;
    setExpensePreviewLoading(true);
    setExpensePreviewError(false);
    payrollApi.expensePreview(payment.employee_id, payment.payroll_month)
      .then((reply) => { if (active) setExpensePreview(reply.data); })
      .catch(() => { if (active) { setExpensePreview(null); setExpensePreviewError(true); } })
      .finally(() => { if (active) setExpensePreviewLoading(false); });
    return () => { active = false; };
  }, [paymentDraftOpen, payment.employee_id, payment.payroll_month, expenseClaimsVersion]);
  useEffect(() => {
    if (!paymentDraftOpen || editingPaymentId || calculation || !payment.employee_id || !payment.payroll_month) return;
    const salary = salaryForMonth(payment.employee_id, payment.payroll_month);
    setPayment((current) => {
      const allowanceAmount = current.allowance_amount === "" ? String(salary?.allowance_amount || data.settings?.default_allowance_amount || 0) : current.allowance_amount;
      const overtimeRate = current.overtime_rate === "" ? String(data.settings?.default_overtime_rate || 0) : current.overtime_rate;
      if (allowanceAmount === current.allowance_amount && overtimeRate === current.overtime_rate) return current;
      return { ...current, allowance_amount: allowanceAmount, overtime_rate: overtimeRate };
    });
  }, [paymentDraftOpen, editingPaymentId, calculation, payment.employee_id, payment.payroll_month, data.salaries, data.settings?.default_allowance_amount, data.settings?.default_overtime_rate]);
  useEffect(() => {
    if (!paymentDraftOpen || editingPaymentId || !payment.employee_id || !payment.payroll_month) { setOvertimePreviewLoading(false); setCalculationPreviewError(""); return undefined; }
    let active = true;
    const employeeId = payment.employee_id;
    const payrollMonth = payment.payroll_month;
    setOvertimePreviewLoading(true);
    setCalculationPreviewError("");
    payrollApi.calculate({ employee_id: employeeId, payroll_month: payrollMonth }, csrfToken)
      .then((reply) => {
        if (!active) return;
        setCalculation(reply.data);
        setPayment((current) => {
          if (current.employee_id !== employeeId || current.payroll_month !== payrollMonth) return current;
          return {
            ...current,
            allowance_amount: current.allowance_amount === "" ? String(reply.data.salary?.allowance_amount || reply.data.settings?.default_allowance_amount || 0) : current.allowance_amount,
            overtime_hours: current.overtime_hours === "" ? String(reply.data.overtime_hours || 0) : current.overtime_hours,
            overtime_rate: current.overtime_rate === "" ? String(reply.data.overtime_rate || 0) : current.overtime_rate,
          };
        });
      })
      .catch((requestError) => { if (active) { setCalculation(null); setCalculationPreviewError(requestError.response?.data?.detail || "Unable to calculate payroll. Add the employee's salary structure first."); } })
      .finally(() => { if (active) setOvertimePreviewLoading(false); });
    return () => { active = false; };
  }, [paymentDraftOpen, editingPaymentId, payment.employee_id, payment.payroll_month, csrfToken, setPayment]);
  const availableAdvance = Array.isArray(calculation?.advances) ? calculation.advances.reduce((sum, item) => sum + number(item.remaining_amount), 0) : null;
  const advanceRecovery = availableAdvance === null ? number(payment.advance_recovery) : Math.min(number(payment.advance_recovery), availableAdvance);
  const appliedAllowance = payment.allowance_amount === "" ? number(calculation?.salary?.allowance_amount ?? calculation?.allowance_amount) : number(payment.allowance_amount);
  const appliedOvertimeRate = payment.overtime_rate === "" ? number(calculation?.overtime_rate) : number(payment.overtime_rate);
  const appliedOvertimeHours = payment.overtime_hours === "" ? number(calculation?.overtime_hours) : number(payment.overtime_hours);
  const overtimeAmount = appliedOvertimeHours * appliedOvertimeRate;
  const autoFetchedExpenses = number(payment.sales_expense_amount || calculation?.sales_expense_amount) + number(calculation?.expense_claim_amount);
  const previewExpenseAmount = number(expensePreview?.sales_expense_amount) + eligibleClaimAmount;
  const grossPreview = number(calculation?.salary?.basic_salary ?? calculation?.basic_salary)
    + appliedAllowance
    + overtimeAmount
    + autoFetchedExpenses
    + number(payment.bonus_amount);
  const deductionPreview = number(calculation?.lop_deduction) + number(payment.deduction_amount) + advanceRecovery;
  const netPreview = grossPreview - deductionPreview;
  const chooseEmployee = (event) => { const employeeId = event.target.value; const existing = payrollForMonth(employeeId); if (existing) { onEditPayment(existing); return; } const salary = salaryForMonth(employeeId, payment.payroll_month); setEditingPaymentId(""); setCalculation(null); setPayment((current) => ({ ...current, employee_id: employeeId, allowance_amount: String(salary?.allowance_amount || data.settings?.default_allowance_amount || 0), overtime_hours: "", overtime_rate: String(data.settings?.default_overtime_rate || 0), sales_expense_amount: "" })); };
  const chooseMonth = (event) => { const payrollMonth = event.target.value; const existing = payrollForMonth(payment.employee_id, payrollMonth); if (existing) { onEditPayment(existing); return; } const salary = salaryForMonth(payment.employee_id, payrollMonth); setEditingPaymentId(""); setCalculation(null); setPayment((current) => ({ ...current, payroll_month: payrollMonth, allowance_amount: String(salary?.allowance_amount || data.settings?.default_allowance_amount || 0), overtime_hours: "", overtime_rate: String(data.settings?.default_overtime_rate || 0), sales_expense_amount: "" })); };
  return <>
    {admin && <div className="mb-3"><button className="btn btn-primary" type="button" onClick={() => setPaymentDraftOpen((open) => !open)}>New monthly payroll</button></div>}
    {paymentDraftOpen && <section id="payroll-calculation-form" className="panel mb-4">
      <h2 className="h5">Monthly salary calculation</h2>
      <div className="row g-3">
        <Field label="Employee"><select className="form-select" name="employee_id" value={payment.employee_id} onChange={chooseEmployee}><option value="">Select employee</option>{data.employees.map((employee) => { const existing = payrollForMonth(employee.id); return <option key={employee.id} value={employee.id}>{employee.name}{existing ? ` — payroll ${existing.status}` : ""}</option>; })}</select></Field>
        <Field label="Month"><input className="form-control" type="month" name="payroll_month" value={payment.payroll_month} onChange={chooseMonth} /></Field>
        <Field label="Allowance"><input className="form-control" type="number" min="0" step="0.01" name="allowance_amount" value={allowanceFieldValue} onChange={change} /><div className="form-text">Fetched from the saved salary when available; it can be adjusted for this month.</div></Field>
        <Field label="Approved OT hours"><input className="form-control" type="number" min="0" max="744" step="0.01" name="overtime_hours" value={overtimeHoursFieldValue} onChange={change} /><div className="form-text">{overtimePreviewLoading ? "Calculating approved overtime…" : "Calculated automatically from approved OT. Edit only for an authorized correction."}</div></Field>
        <Field label="OT rate / hour"><input className="form-control" type="number" min="0" step="0.01" name="overtime_rate" value={overtimeRateFieldValue} readOnly aria-readonly="true" /><div className="form-text">Set by Admin in Payroll Settings. OT pay = approved OT hours × this hourly rate.</div></Field>
        <Field label="Auto-fetched expenses"><input className="form-control" value={calculation ? money.format(autoFetchedExpenses) : expensePreviewLoading ? "Fetching approved expenses…" : expensePreviewError ? "Unable to fetch expenses" : payment.employee_id ? money.format(previewExpenseAmount) : "Select an employee"} readOnly /><div className="form-text">{payment.employee_id && !expensePreviewLoading && !expensePreviewError ? `Approved claims: ${money.format(eligibleClaimAmount)} · Sales visits: ${money.format(number(expensePreview?.sales_expense_amount))}` : "Includes approved reimbursable claims and Sales visit expenses for the selected month."}</div></Field>
        <Field label="Bonus / incentive"><input className="form-control" type="number" min="0" name="bonus_amount" value={payment.bonus_amount} onChange={change} /></Field>
        <Field label="Other deduction"><input className="form-control" type="number" min="0" name="deduction_amount" value={payment.deduction_amount} onChange={change} /></Field>
        <Field label="Advance recovery"><input className="form-control" type="number" min="0" name="advance_recovery" value={payment.advance_recovery} onChange={change} /></Field>
      </div>
      {selectedPayroll && <div className={`alert ${selectedPayrollRejected ? "alert-warning" : "alert-info"} py-2 mt-3 mb-0`}><strong>{String(selectedPayroll.status).replaceAll("_", " ")}</strong> payroll for {payment.payroll_month} is already loaded. {selectedPayrollLocked ? "Finalized or paid payroll cannot be edited." : selectedPayrollRejected ? "Correct the values below, recalculate if needed, and finalize the payroll." : "Review the saved values below and finalize when ready."}</div>}
      {calculationPreviewError && <div className="alert alert-warning py-2 mt-3 mb-0">{calculationPreviewError} <Link className="alert-link" to="/payroll/salaries">Open Employee Salary Management</Link></div>}
      <div className="mt-3"><FormButton busy={busy} disabled={busy || !payment.employee_id || Boolean(selectedPayrollLocked)} type="button" onClick={() => void onCalculate()}>{selectedPayrollRejected ? "Recalculate returned payroll" : calculation ? "Recalculate monthly payroll" : "Calculate monthly payroll"}</FormButton></div>
      {calculation && <>
        <div className="row g-3 mt-2">
          <Metric label="Present days" value={calculation.present_days} />
          <Metric label="Absent / LOP days" value={calculation.absent_days + calculation.unpaid_leave_days} />
          <Metric label="Paid leave" value={calculation.paid_leave_days} />
          <Metric label="Allowance" value={money.format(appliedAllowance)} />
          <Metric label="Approved OT" value={`${appliedOvertimeHours}h · ${money.format(overtimeAmount)}`} />
          <Metric label="Auto-fetched expenses" value={money.format(autoFetchedExpenses)} />
          <Metric label="Auto-fetched Sales expenses" value={money.format(number(calculation.sales_expense_amount))} />
          <Metric label="Other approved expenses" value={money.format(number(calculation.expense_claim_amount))} />
          <Metric label="LOP deduction" value={money.format(number(calculation.lop_deduction))} />
          <Metric label="Gross earnings" value={money.format(grossPreview)} />
          <Metric label="Total deductions" value={money.format(deductionPreview)} />
          <Metric label="Net payable" value={money.format(netPreview)} />
        </div>
        <div className="row g-3 mt-3"><Field label="Sales expenses for this payroll"><input className="form-control" type="number" min="0" step="0.01" name="sales_expense_amount" value={payment.sales_expense_amount} onChange={change} /><div className="form-text">Fetched automatically from Sales visits. Edit only to apply an authorized adjustment.</div></Field></div>
        <div ref={correctionActionsRef} className="d-flex gap-2 mt-3"><FormButton busy={busy} disabled={Boolean(selectedPayrollLocked)} className="btn btn-outline-primary" type="button" onClick={() => onSave("draft")}>{selectedPayrollRejected ? "Save correction" : editingPaymentId ? "Save changes" : "Save draft"}</FormButton><FormButton busy={busy} disabled={Boolean(selectedPayrollLocked)} type="button" onClick={() => onSave("approved")}>{selectedPayrollRejected ? "Finalize corrected payroll" : "Finalize payroll"}</FormButton></div>
      </>}
    </section>}
    {!hideRecords && <section className="panel"><h2 className="h5">{admin ? "Payroll records" : "My payslip history"}</h2><div className="table-responsive"><table className="table table-hover align-middle"><thead className="table-light"><tr>{admin && <th>Employee</th>}<th>Month</th><th>Attendance</th><th>Earnings</th><th>Deductions</th><th>Net salary</th><th>Status</th><th>Action</th></tr></thead><tbody>{data.payments.map((item) => <tr key={item.id}>{admin && <td>{item.employee_name}</td>}<td>{String(item.payroll_month).slice(0, 7)}</td><td>{item.present_days} present · {item.absent_days} absent</td><td>{money.format(number(item.gross_amount || item.basic_salary))}</td><td>{money.format(number(item.lop_deduction) + number(item.deduction_amount) + number(item.advance_recovery))}</td><td><strong>{money.format(number(item.net_amount))}</strong></td><td><Badge status={item.status} /></td><td><div className="d-flex flex-wrap gap-1">{["draft", "submitted", "rejected"].includes(item.status) && <button className="btn btn-sm btn-outline-primary" type="button" disabled={busy} onClick={() => onEditPayment(item)}>Edit</button>}{["approved", "paid"].includes(item.status) && <button className="btn btn-sm btn-outline-secondary" type="button" onClick={() => void printPayslip(item.id)}>Payslip PDF</button>}{admin && item.status === "submitted" && <><button className="btn btn-sm btn-success" type="button" disabled={busy} onClick={() => onApprove(item.id)}>Finalize</button><button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => onReject(item.id)}>Return to draft</button></>}</div></td></tr>)}{!data.payments.length && <tr><td colSpan="8" className="text-secondary text-center py-4">No payroll records yet.</td></tr>}</tbody></table></div></section>}
  </>;
}

function ApprovalsTab({ expenses, advances, busy, onReviewExpense, onReviewAdvance }) {
  const pendingExpenses = expenses.filter((item) => item.status === "submitted");
  const pendingAdvances = advances.filter((item) => item.status === "submitted");
  return <>
    <section className="panel mb-4"><div className="eyebrow">REVIEW CENTER</div><h2 className="h5 mb-1">Pending payroll inputs</h2><p className="text-secondary small mb-0">Store Admins can review employee expenses and salary advances, calculate salaries, and finalize payroll independently.</p></section>
    <section className="panel mb-4"><h2 className="h5">Salary advances</h2><div className="table-responsive"><table className="table table-hover align-middle"><thead><tr><th>Employee</th><th>Requested</th><th>Reason</th><th>Action</th></tr></thead><tbody>{pendingAdvances.map((item) => <tr key={item.id}><td><strong>{item.employee_name || "Employee"}</strong>{item.employee_code && <div className="small text-secondary">{item.employee_code}</div>}</td><td>{money.format(number(item.requested_amount))}</td><td>{item.reason || "—"}</td><td><button className="btn btn-sm btn-success me-1" type="button" disabled={busy} onClick={() => onReviewAdvance(item.id, "approved", item.requested_amount)}>Approve</button><button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => onReviewAdvance(item.id, "rejected", 0)}>Reject</button></td></tr>)}{!pendingAdvances.length && <tr><td colSpan="4" className="text-center text-secondary py-3">No salary advances awaiting approval.</td></tr>}</tbody></table></div></section>
    <section className="panel mb-4"><h2 className="h5">Expense claims</h2><div className="table-responsive"><table className="table table-hover align-middle"><thead><tr><th>Employee</th><th>Date</th><th>Category</th><th>Amount</th><th>Action</th></tr></thead><tbody>{pendingExpenses.map((item) => <tr key={item.id}><td><strong>{item.employee_name || "Employee"}</strong>{item.employee_code && <div className="small text-secondary">{item.employee_code}</div>}</td><td>{item.expense_date}</td><td>{item.category}</td><td>{money.format(number(item.amount))}</td><td><button className="btn btn-sm btn-success me-1" type="button" disabled={busy} onClick={() => onReviewExpense(item.id, "approved")}>Approve</button><button className="btn btn-sm btn-outline-danger" type="button" disabled={busy} onClick={() => onReviewExpense(item.id, "rejected")}>Reject</button></td></tr>)}{!pendingExpenses.length && <tr><td colSpan="5" className="text-center text-secondary py-3">No expense claims awaiting approval.</td></tr>}</tbody></table></div></section>
  </>;
}

function SalaryTab({ employees, salary, setSalary, structures, busy, onSave }) {
  const change = (event) => setSalary((current) => ({ ...current, [event.target.name]: event.target.value }));
  const changeAccountNumber = (event) => setSalary((current) => ({ ...current, bank_account_number: event.target.value.replace(/\D/g, "").slice(0, 80) }));
  useEffect(() => {
    if (!/\D/.test(salary.bank_account_number || "")) return;
    setSalary((current) => ({ ...current, bank_account_number: String(current.bank_account_number || "").replace(/\D/g, "").slice(0, 80) }));
  }, [salary.bank_account_number, setSalary]);
  const selectEmployee = (event) => {
    const employeeId = event.target.value;
    if (!employeeId) { setSalary(blankSalary()); return; }
    const latest = structures.find((item) => item.employee_id === employeeId);
    if (!latest) { setSalary({ ...blankSalary(), employee_id: employeeId }); return; }
    setSalary({
      ...blankSalary(),
      employee_id: employeeId,
      effective_from: latest.effective_from,
      basic_salary: String(latest.basic_salary ?? ""),
      allowance_amount: String(latest.allowance_amount ?? "0"),
      overtime_rate: String(latest.overtime_rate ?? "0"),
      bank_account_holder: latest.bank_account_holder || "",
      bank_name: latest.bank_name || "",
      bank_account_number: String(latest.bank_account_number || "").replace(/\D/g, ""),
      bank_ifsc: latest.bank_ifsc || "",
      notes: latest.notes || "",
    });
  };
  const editingExisting = structures.some((item) => item.employee_id === salary.employee_id && item.effective_from === salary.effective_from);
  return <>
    <section className="panel mb-4">
      <h2 className="h5">Salary structure</h2>
      <p className="small text-secondary">This screen saves the employee's basic salary and bank details. Allowance, approved overtime, and approved expenses are reviewed in Process Payroll when the monthly payroll is calculated.</p>
      <form className="row g-3" onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
        <Field label="Employee"><select className="form-select" name="employee_id" value={salary.employee_id} onChange={selectEmployee} required><option value="">Select employee</option>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></Field>
        <Field label="Effective from"><input className="form-control" type="date" name="effective_from" value={salary.effective_from} onChange={change} required /></Field>
        <Field label="Basic salary"><input className="form-control" type="number" name="basic_salary" value={salary.basic_salary} onChange={change} required /></Field>
        <Field label="Account holder"><input className="form-control" name="bank_account_holder" value={salary.bank_account_holder} onChange={change} /></Field>
        <Field label="Bank"><input className="form-control" name="bank_name" value={salary.bank_name} onChange={change} /></Field>
        <Field label="Account number"><input className="form-control" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off" maxLength={80} name="bank_account_number" value={salary.bank_account_number} onChange={changeAccountNumber} /><div className="form-text">Enter numbers only. Leading zeroes are preserved.</div></Field>
        <Field label="IFSC / bank code"><input className="form-control" type="text" inputMode="text" autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck={false} maxLength={32} name="bank_ifsc" value={salary.bank_ifsc} onChange={change} /></Field>
        <div className="col-12 d-flex flex-column align-items-start gap-2"><FormButton busy={busy}>{editingExisting ? "Update salary" : "Create revision"}</FormButton><p className="form-text mb-0">Saving with the same effective date updates the existing salary. Choose a different effective date only when creating a new revision.</p></div>
      </form>
    </section>
    <section className="panel"><h2 className="h5">Revision history</h2><div className="table-responsive"><table className="table"><thead><tr><th>Employee</th><th>Effective</th><th>Basic salary</th><th>Bank</th></tr></thead><tbody>{structures.map((item) => <tr key={item.id}><td>{employees.find((employee) => employee.id === item.employee_id)?.name || "Employee"}</td><td>{item.effective_from}</td><td>{money.format(number(item.basic_salary))}</td><td>{item.bank_name || "—"}</td></tr>)}</tbody></table></div></section>
  </>;
}

function ExpenseTab({ admin, expenses, expense, setExpense, busy, onSave, onReview }) {
  const change = (event) => setExpense((current) => ({ ...current, [event.target.name]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  return <><section className="panel mb-4"><h2 className="h5">Submit expense claim</h2><form className="row g-3" onSubmit={(event) => { event.preventDefault(); void onSave(); }}><Field label="Date"><input className="form-control" type="date" name="expense_date" value={expense.expense_date} onChange={change} /></Field><Field label="Category"><input className="form-control" name="category" value={expense.category} onChange={change} /></Field><Field label="Amount"><input className="form-control" type="number" min="1" step="0.01" name="amount" value={expense.amount} onChange={change} required /></Field><div className="col-md-8"><label className="form-label">Description</label><input className="form-control" name="description" value={expense.description} onChange={change} /></div><div className="col-md-4 d-flex align-items-end"><div className="form-check"><input className="form-check-input" type="checkbox" name="reimbursable" checked={expense.reimbursable} onChange={change} /><label className="form-check-label">Reimbursable</label></div></div><div className="col-12"><FormButton busy={busy}>Submit expense</FormButton></div></form></section><section className="panel"><h2 className="h5">Expense claims</h2><div className="table-responsive"><table className="table"><thead><tr>{admin && <th>Employee</th>}<th>Date</th><th>Category</th><th>Amount</th><th>Reimbursable</th><th>Status</th>{admin && <th>Action</th>}</tr></thead><tbody>{expenses.map((item) => <tr key={item.id}>{admin && <td><strong>{item.employee_name || "Employee"}</strong>{item.employee_code && <div className="small text-secondary">{item.employee_code}</div>}</td>}<td>{item.expense_date}</td><td>{item.category}</td><td>{money.format(number(item.amount))}</td><td>{item.reimbursable ? "Yes" : "No"}</td><td><Badge status={item.status} /></td>{admin && <td>{item.status === "submitted" && <><button className="btn btn-sm btn-success me-1" disabled={busy} onClick={() => void onReview(item.id, "approved")}>Approve</button><button className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => void onReview(item.id, "rejected")}>Reject</button></>}</td>}</tr>)}</tbody></table></div></section></>;
}

function AdvanceTab({ admin, advances, advance, setAdvance, busy, onSave, onReview }) { return <><section className="panel mb-4"><h2 className="h5">Request salary advance</h2><form className="row g-3" onSubmit={(event) => { event.preventDefault(); void onSave(); }}><Field label="Amount"><input className="form-control" type="number" min="1" step="0.01" value={advance.amount} onChange={(event) => setAdvance({ ...advance, amount: event.target.value })} required /></Field><div className="col-md-8"><label className="form-label">Reason</label><input className="form-control" value={advance.reason} onChange={(event) => setAdvance({ ...advance, reason: event.target.value })} /></div><div className="col-12"><FormButton busy={busy}>Request advance</FormButton></div></form></section><section className="panel"><h2 className="h5">Advance history</h2><div className="table-responsive"><table className="table"><thead><tr>{admin && <th>Employee</th>}<th>Requested</th><th>Approved</th><th>Remaining</th><th>Status</th>{admin && <th>Action</th>}</tr></thead><tbody>{advances.map((item) => <tr key={item.id}>{admin && <td><strong>{item.employee_name || "Employee"}</strong>{item.employee_code && <div className="small text-secondary">{item.employee_code}</div>}</td>}<td>{money.format(number(item.requested_amount))}</td><td>{money.format(number(item.approved_amount))}</td><td>{money.format(number(item.remaining_amount))}</td><td><Badge status={item.status} /></td>{admin && <td>{item.status === "submitted" && <><button className="btn btn-sm btn-success me-1" disabled={busy} onClick={() => void onReview(item.id, "approved", item.requested_amount)}>Approve</button><button className="btn btn-sm btn-outline-danger" disabled={busy} onClick={() => void onReview(item.id, "rejected", 0)}>Reject</button></>}</td>}</tr>)}</tbody></table></div></section></>; }

function ReportsTab({ report }) {
  const totals = report?.totals || {};
  const rows = report?.results || [];
  return <>
    <section className="row g-3 mb-4">{[["Monthly payroll", totals.payroll], ["Payroll records", rows.length], ["Reimbursements", totals.reimbursements], ["LOP deductions", totals.lopDeductions], ["Overtime", totals.overtime]].map(([label, value]) => <Metric key={label} label={label} value={label === "Payroll records" ? number(value) : money.format(number(value))} />)}</section>
    <section className="panel"><h2 className="h5">Employee-wise payroll report</h2><p className="text-secondary small">{rows.length} payroll record{rows.length === 1 ? "" : "s"} in {report?.month || "the selected month"}.</p><div className="table-responsive"><table className="table table-hover align-middle"><thead className="table-light"><tr><th>Employee</th><th>Month</th><th>Basic</th><th>Reimbursements</th><th>OT</th><th>LOP</th><th>Net payable</th><th>Status</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id}><td><strong>{item.employee_name || "Employee"}</strong>{item.employee_code && <div className="small text-secondary">{item.employee_code}</div>}</td><td>{String(item.payroll_month).slice(0, 7)}</td><td>{money.format(number(item.basic_salary))}</td><td>{money.format(number(item.reimbursement_amount))}</td><td>{money.format(number(item.overtime_amount))}</td><td>{money.format(number(item.lop_deduction))}</td><td><strong>{money.format(number(item.net_amount))}</strong></td><td><Badge status={item.status} /></td></tr>)}{!rows.length && <tr><td colSpan="8" className="text-center text-secondary py-4">No payroll records for this month.</td></tr>}</tbody></table></div></section>
  </>;
}
function SettingsTab({ settings, busy, readOnly = false, onSave }) {
  const [draft, setDraft] = useState(settings || {});
  useEffect(() => setDraft(settings || {}), [settings]);
  const change = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  return <section className="panel">
    <h2 className="h5">Payroll settings</h2>
    <p className="text-secondary small">These store defaults are fetched automatically when monthly payroll is processed. Authorized Admins can still make a month-specific correction before finalizing payroll.</p>
    {readOnly && <div className="alert alert-info">You can view the active payroll rules but cannot change them.</div>}
    <form className="row g-3" onSubmit={(event) => { event.preventDefault(); if (!readOnly) void onSave(draft); }}>
      <Field label="Payroll days per month"><input className="form-control" type="number" min="1" max="31" disabled={readOnly} value={draft.payroll_days_per_month ?? ""} onChange={change("payroll_days_per_month")} required /></Field>
      <Field label="Paid leave allowance (days)"><input className="form-control" type="number" min="0" step="0.5" disabled={readOnly} value={draft.paid_leave_allowance ?? ""} onChange={change("paid_leave_allowance")} /></Field>
      <Field label="Default allowance amount"><input className="form-control" type="number" min="0" step="0.01" disabled={readOnly} value={draft.default_allowance_amount ?? ""} onChange={change("default_allowance_amount")} /></Field>
      <Field label="OT rate per hour"><input className="form-control" type="number" min="0" step="0.01" disabled={readOnly} value={draft.default_overtime_rate ?? ""} onChange={change("default_overtime_rate")} /></Field>
      {!readOnly && <div className="col-12"><FormButton busy={busy}>Save settings</FormButton></div>}
    </form>
  </section>;
}
function Metric({ label, value }) { return <div className="col-6 col-md-4"><div className="border rounded p-3 bg-white"><div className="text-secondary small">{label}</div><strong>{value}</strong></div></div>; }
