# VestaTrack CRM — QA Audit

**Audit date:** 11 November 2026 (Asia/Kolkata)
**Scope:** source architecture review, existing automated tests, isolated PostgreSQL/PGlite database tests, safe local build checks, and test-environment inspection.
**Safety:** no production configuration, production business record, or live database row was created, changed, or deleted during this audit.

## Production readiness decision

**BLOCKED – INSUFFICIENT TESTING EVIDENCE**

There is no proven critical live-data breach in the executed evidence, but the release cannot be called production-ready because financial payroll workflows are not covered by automated tests, seven regression tests fail, Django integration tests cannot start, and the complete browser E2E suite could not be started in the current local environment.

## Architecture observed

| Area | Implementation |
|---|---|
| Web client | React 19 / Vite SPA, Bootstrap UI, route-based pages |
| Primary CRM API | Supabase Edge Function: `supabase/functions/crm-api/index.ts` |
| Identity/data | Supabase Auth, profiles, RLS-enabled CRM schema and migrations |
| Attendance | Unified Supabase attendance records/RPCs plus attendance Edge-function helpers |
| Legacy application | Django application/templates, imports, reminder support and Django tests remain in repository |
| Financial features | Salary structures, payroll payments, expense reimbursement links, advances, OT, payments and payslips |

The active React CRM uses the Edge Function as the primary business API. Django is present and must be tested/released as a maintained compatibility path only after its PostgreSQL test environment is restored.

## Executed test evidence

| ID | Test / command | Result | Evidence |
|---|---|---|---|
| QA-T-001 | `npm run build` | PASS | Vite production build completed successfully. |
| QA-T-002 | Node Edge-function/shared tests | FAIL | 117 executed: 110 passed, 7 failed. See QA-001. |
| QA-T-003 | `npm run test:db` | PASS | 31 isolated PGlite/PostgreSQL workflow subtests passed: import atomicity, store isolation, timesheets, customers/callbacks and overtime. |
| QA-T-004 | Django `manage.py check` | PASS | “System check identified no issues.” |
| QA-T-005 | Django `manage.py test` | BLOCKED | 152 tests discovered; local PostgreSQL at port 55432 unavailable/denied connection. No test ran. |
| QA-T-006 | Full Playwright browser suite | BLOCKED | Port 5182 was already occupied and the configured Playwright web server uses `reuseExistingServer:false`; no current full-suite result was produced. |
| QA-T-007 | Static permission/API review | REVIEWED | Source uses store-scoped context, role guards, RLS migrations and service-role-only CRM tables. Not a substitute for deployed RLS verification. |

### Test statistics

Only executed automated tests are included in the calculation.

| Metric | Count |
|---|---:|
| Total executed | 148 |
| Passed | 141 |
| Failed | 7 |
| Blocked suites | 2 |
| Not tested / unverified scenarios | Significant; see coverage gaps |
| Pass percentage | **95.27%** |

`Pass percentage = 141 / (141 + 7) × 100`.

## Functional and authorization assessment

| Module | Status | Evidence / limitation |
|---|---|---|
| Authentication and role boundaries | PARTIALLY VERIFIED | Existing tests passed for inactive accounts, role synchronization, store-scoped administration and password-reset controls. Real token expiration, multiple sessions and hosted reset delivery were not run. |
| Stores/users/designations | PARTIALLY VERIFIED | Isolated store-boundary/admin-user tests passed. Store-creation regression test has one expectation failure after account-limit fields were added. |
| Customers/imports/callbacks | VERIFIED IN ISOLATION | Atomic import, retry, cross-store denial, history and callback tests passed against isolated PGlite. Large import evidence includes 25,000 rows. |
| Sales/targets/visits | PARTIALLY VERIFIED | Core source/business tests ran, but the sales business suite has failing scenarios. Target policy now requires the Sales designation; tests must be updated or a regression confirmed. |
| Tasks/images/reminders | PARTIALLY VERIFIED | Image validation, photo cleanup, review conflicts, reminder ownership and delivery tests passed. Hosted push delivery was not exercised. |
| Attendance/timesheets | PARTIALLY VERIFIED | Timesheet approval/rejection/store-boundary tests passed in isolation. Device ingestion, real eSSL punches, holidays and live store data were not tested. |
| Overtime | PARTIALLY VERIFIED | Isolated requests, punch validation, scoped review, notification rollback and approved-minute tests passed. Payroll inclusion was not automatically tested. |
| Expenses/advances | NOT ADEQUATELY TESTED | No dedicated automated expense/advance approval, duplicate or payroll-recovery suite was found. |
| Payroll/payslips/payments | NOT ADEQUATELY TESTED | No dedicated automated payroll calculation, approval, payment, payslip, rounding or concurrency suite was found. |
| Reports/UI/mobile | PARTIALLY VERIFIED | Build passed; existing browser test configuration contains responsive fixtures, but the full suite was blocked in this audit. |

## Defect and risk list

### QA-001 — Failing regression suite

- **Severity:** High
- **Module:** Edge-function regression coverage / sales / user recovery / store creation
- **Environment:** Local Node 22 test execution
- **Evidence:** 7 failures out of 117 executed tests.
- **Failures observed:**
  - `phase3-security.test.mjs`: expected authentication-account cleanup/restore calls were not observed in two error-path tests.
  - `sales-business.test.mjs`: one visit/report path returned a guarded database error; two target scenarios now fail because targets require active users with the Sales designation; suite parent therefore fails.
  - `store-creation.test.mjs`: expected insert payload does not account for newly supplied `admin_limit` and `user_limit` null fields.
- **Expected:** Every committed regression suite passes or has an approved, documented expectation update.
- **Actual:** The suite exits non-zero.
- **Root cause:** Not established for the authentication and database-error paths. Some sales/store failures may be stale test fixtures after business-rule changes, but this must be proven—not assumed.
- **Recommended fix:** Triage each failure against the current specification; correct either code or test fixture, then rerun the complete suite with zero failures.
- **Regression required:** Full Node suite and isolated database suite.

### QA-002 — Payroll financial workflow has no dedicated automated coverage

- **Severity:** High
- **Module:** Payroll, expenses, advances, OT and payments
- **Precondition:** Payroll is available to an Admin/Super Admin.
- **Evidence:** Repository search found no payroll-specific test file in frontend, Edge Function, scripts, or backend test directories.
- **Risk:** Salary, LOP, salary revision, reimbursements, sales expenses, partial payments, advance recovery, status locking, duplicate monthly payroll and payslip correctness can regress without detection.
- **Recommended fix:** Add an isolated database/API suite that manually verifies expected gross and net values, current-month future-date exclusion, rejected/pending exclusions, multi-advance recovery, duplicate prevention, partial-payment limits, approved/paid/rejected locks and employee-only payslip access.
- **Regression required:** Run on every payroll release and before any live payroll processing.

### QA-003 — Payroll creation/edit flow is not transactionally proven

- **Severity:** High
- **Module:** Payroll financial integrity
- **Evidence:** Source review of `createAutomaticPayrollPayment` and `updatePayrollPayment` shows sequential inserts/updates for payroll, expense reimbursement links and advance repayment/balance records. No executed test covers a failure after a partial write.
- **Expected:** A failed payroll create/edit leaves no partial payment, reimbursement link, advance balance or audit mutation.
- **Actual:** Atomic rollback was not demonstrated; sequential writes create a risk of partial financial state when a later request fails.
- **Recommended fix:** Use a database RPC/transaction for create, edit, reject and payment-state reconciliation. Add injected-failure tests at every write boundary.
- **Regression required:** Failure after payment insert, after reimbursement link, after advance balance update, duplicate concurrent creation and concurrent approval.

### QA-004 — Mid-month salary revision behavior is not specified or tested

- **Severity:** Medium
- **Module:** Payroll calculation
- **Evidence:** Calculation selects the latest salary structure effective before the end of the month. No test demonstrates prorating when a salary changes during the payroll month.
- **Expected:** A documented business rule: either prorate salary by effective date or deliberately apply the latest/earliest structure for the whole month.
- **Actual:** Behavior is not covered by a test or documented rule.
- **Recommended fix:** Obtain a business decision, implement it explicitly, and add examples covering a revision on day 1, mid-month and after month end.

### QA-005 — Complete browser and Django regression evidence unavailable

- **Severity:** Medium
- **Module:** Legacy Django path, UI/UX, responsiveness and route protection
- **Evidence:** Django test DB is unreachable at localhost:55432. Playwright cannot create its server because port 5182 is already in use.
- **Expected:** A clean disposable PostgreSQL test database and a managed, isolated browser test server.
- **Actual:** Full suites were blocked.
- **Recommended fix:** Provide a disposable test PostgreSQL instance, configure Playwright to use an allocated port or reuse a known test server, and archive current JSON/trace results.

### QA-006 — Static coverage is not deployed authorization evidence

- **Severity:** Medium
- **Module:** Security/RLS/storage
- **Evidence:** Store/role guard source and isolated tests are positive, but no dedicated Supabase test project credentials were available for deployed RLS, storage and direct API negative tests.
- **Expected:** Actual deployed test project rejects cross-store/cross-employee reads and mutations.
- **Actual:** BLOCKED to safe local/isolated review.
- **Recommended fix:** Create a separate Supabase QA project with Store A/Store B fixtures and execute authenticated negative tests. Never use production records for these checks.

## Positive controls observed

- Store-boundary, admin-user and user-role tests cover many direct cross-store override attempts.
- CRM migrations enable RLS and restrict CRM-table browser grants to the service role.
- Image validation and cleanup paths passed, including invalid formats, size limits and transactional cleanup cases.
- Isolated import tests demonstrate atomic commit/retry behavior and direct browser-table/RPC denial.
- Attendance/timesheet, OT and reminder isolated workflow tests passed.
- Production frontend build and Django configuration checks passed.

## Mandatory release gate before production

1. Resolve QA-001: complete Node suite with zero unexpected failures.
2. Implement and pass payroll financial/integrity tests for QA-002 and QA-003.
3. Restore the disposable PostgreSQL environment and run all 152 Django tests.
4. Run the full Playwright desktop/tablet/mobile suite on a clean allocated port; retain results and screenshots/traces for failures.
5. Execute RLS, storage and direct API authorization tests against a dedicated Supabase QA project.
6. Define the business rules for salary revisions, holidays, weekends, joining/leaving dates and current-day attendance/LOP.
7. Repeat this audit after fixes. Do not process real payroll until the payroll gate passes.

## Untested / blocked scenarios

- Full live-auth session expiry, concurrent sessions and browser back-button behavior.
- Real password-reset delivery and mail-provider failure paths.
- Hosted Supabase RLS/storage policy enforcement and live Edge Function authorization.
- eSSL device ingestion, hardware/clock behavior and device-to-attendance reconciliation.
- Payroll calculations/payslips/payment history with isolated fixtures.
- Full responsive coverage at 320, 375, 390, 768, 1024, 1366 and 1920 pixels.
- Network interruption, concurrent payroll approval/payment and database rollback behavior.
- Real large-data query plans and hosted API latency.

## Conclusion

The CRM has meaningful automated coverage for imports, store boundaries, tasks, attendance/timesheets, overtime, image handling and reminders. However, the unresolved regression failures and the absence of payroll-specific test evidence make the current state unsuitable for a production-ready sign-off. The appropriate decision is **BLOCKED – INSUFFICIENT TESTING EVIDENCE**.

---

## Remediation update — 11 November 2026

### Completed fixes

| ID | Root cause | Permanent correction | Regression evidence |
|---|---|---|---|
| QA-001 | Three security/store tests supplied invalid employee fixtures after designation and store account-limit fields became required; sales tests did not install the metric/designation migrations used by the handler. | Updated only the affected isolated fixtures to model the current API and migration contract. The role restriction itself was not relaxed. | Full Node suite: **251 passed, 0 failed**. |
| PAY-001 | Payroll converted a UTC punch timestamp to a date by string slicing. A late-evening UTC punch can be the next India workday, causing an incorrect absence/LOP deduction. | Payroll now converts each punch with the CRM India calendar before attendance/LOP comparison. | `payroll-calculation.test.mjs` uses a UTC-to-India boundary punch and manually checks present days, paid/unpaid leave, LOP, OT, approved claims and once-only sales-visit expenses. |
| QA-002 | Payroll calculation and financial persistence had no dedicated regression suite. | Added calculation and isolated PostgreSQL/PGlite atomic-write suites. | Six new payroll tests pass: calculation eligibility/future-date exclusion/manual totals (3) and atomic creation/rollback/duplicate payroll protection (3). |
| QA-003 (creation path) | Payroll creation performed multiple financial writes in the Edge function. A later failure could leave a payment, claim reservation, advance balance or audit entry partially changed. | Added `202611110004_atomic_payroll_creation.sql`, an all-or-nothing RPC that locks and validates source claims, visits and advances, creates the payment/link records, and records its audit entry in one database transaction. The Edge handler uses it when installed and falls back only when the RPC is genuinely absent, keeping already-running environments compatible before an approved migration deployment. | An injected failure after the payment and first claim write rolls back the payment, reimbursement links, advance recovery, audit row and source claim. A duplicate monthly request also leaves source balances intact. |

### Files changed during remediation

- `supabase/functions/crm-api/index.ts`
- `supabase/functions/crm-api/phase3-security.test.mjs`
- `supabase/functions/crm-api/sales-business.test.mjs`
- `supabase/functions/crm-api/store-creation.test.mjs`
- `supabase/functions/crm-api/payroll-calculation.test.mjs` *(new)*
- `supabase/functions/crm-api/payroll-atomic-db.test.mjs` *(new)*
- `supabase/migrations/202611110004_atomic_payroll_creation.sql` *(new, not deployed)*
- `frontend/playwright.qa.config.js` *(new isolated browser-test configuration)*

### Retest evidence

| Command | Result |
|---|---|
| `npm run build` | PASS — Vite production build completed. |
| `npm test` | PASS — **251 passed, 0 failed**. |
| `npm run test:db` | PASS — isolated database regression command exited successfully. |
| `node --test ../supabase/functions/crm-api/payroll-atomic-db.test.mjs` | PASS — 3/3. |
| `node --test ../supabase/functions/crm-api/payroll-calculation.test.mjs` | PASS — 3/3. |
| `manage.py check` | PASS — no Django configuration errors. |

### Remaining release blockers

1. **Salary revision decision required.** The product owner must specify whether a salary revision effective mid-month is prorated by day, applies from the following month, or applies to the whole month. No code was changed for this undefined financial rule.
2. **Complete financial atomicity still requires the same treatment for payroll edit, reject and salary-payment recording.** Creation is now covered by the prepared atomic RPC. The existing edit/reject/payment flows remain sequential until their corresponding transactional functions are implemented and tested; do not process live payroll on the basis of the creation-path fix alone.
3. **Django integration tests remain blocked** because the disposable PostgreSQL endpoint at `127.0.0.1:55432` is unavailable/denied. No production database was touched.
4. **Browser E2E remains blocked by local infrastructure.** A separate QA configuration uses port 5190, but this environment denies binding/reusing that port. The test suite is discovered (99 browser tests), but no browser result is claimed.
5. **Hosted RLS/storage verification remains blocked** until credentials for a separate Supabase QA project are supplied. Production records were not used.
6. **No migration or Edge-function deployment was performed.** The atomic migration is prepared and tested locally only; deployment requires explicit approval and a migration rehearsal.

### Current production-readiness decision

**BLOCKED – EXTERNAL DEPENDENCY OR BUSINESS DECISION REQUIRED.**

The original seven Node regressions are resolved and the payroll calculation/creation path now has concrete regression and rollback coverage. The release remains blocked because the mid-month salary rule is undecided, the remaining financial write paths need transactional coverage, and the required disposable PostgreSQL, browser-server and hosted Supabase QA environments are unavailable.
