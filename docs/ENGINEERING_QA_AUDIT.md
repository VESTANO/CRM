# VESTANO CRM Engineering & QA Audit

Audit date: 7 November 2026 (Asia/Kolkata)  
Scope: local source review, static build, existing automated tests, and non-destructive configuration inspection. No production database, customer data, device, or deployment was changed.

The earlier findings and results below are retained as history. The **Phase 5** section and `PRODUCTION_RELEASE_REPORT.md` contain the current verification and release assessment.

## Runtime architecture

The browser application is a React 19/Vite single-page application. It authenticates through Supabase Auth and calls the `crm-api` Supabase Edge Function for CRM data. That function uses the server-only Supabase client and applies role/store checks before operating on CRM tables. CRM data tables have RLS enabled and direct `anon`/`authenticated` table access revoked; the browser only reads its own CRM profile directly.

The repository also contains Django templates, REST endpoints, reminder worker support, and an attendance import backup. Its Docker/Render configuration can serve the compiled React assets, but the active React screens do not use Django as their primary CRM data API. Django must therefore be treated as a legacy/backup deployment path, not silently made authoritative.

The active frontend unifies Attendance and CRM through the same `crmSupabase` client, identity and session. Attendance reads use scoped RLS/RPCs in that project. Server-issued attendance-session code remains a compatibility path; it is not evidence of a separately verified live project.

## Baseline measurements and checks

| Check | Result |
|---|---|
| Working tree before audit | Clean on `main` |
| Frontend production build | Passed (`vite build --mode pages`, 283 modules) |
| Initial focused Node regression suite | 114 passed, 0 failed |
| Initial shell bundle | 75.29 kB / 23.37 kB gzip |
| React runtime chunk | 261.51 kB / 83.18 kB gzip |
| Supabase chunk | 223.73 kB / 58.62 kB gzip |
| XLSX chunk | 429.19 kB / 142.94 kB gzip; deferred until import/export |
| Django default test command | Blocked by unavailable local PostgreSQL on port 55432 |
| Django SQLite suite | 152 tests discovered; full local run needs to be split because the execution harness stops a command at ~30 seconds |

## Findings

| Issue ID | Module | Severity | Description | Root cause | Reproduction | Expected result | Fix strategy | Test scenario |
|---|---|---|---|---|---|---|---|---|
| AUD-001 | Mobile navigation / scrolling | High | A page can retain an inconsistent Bootstrap scroll-lock/backdrop state after mobile navigation. | `AppLayout` manually removes all offcanvas backdrops and removes `body.modal-open` after Bootstrap's `hidden.bs.offcanvas` event. This competes with Bootstrap's own lifecycle and can affect a later dialog/backdrop. | On a narrow viewport, open the menu, navigate repeatedly, then open/close a dialog and try to scroll. | Navigation and dialogs never leave the document locked or an orphan backdrop behind. | Remove manual Bootstrap DOM cleanup; add a scoped, reference-counted scroll lock for CRM-owned dialogs. | Repeated menu navigation and modal open/close at mobile widths; verify scrolling after each transition. |
| AUD-002 | Task review | High | Approve/reject actions are issued immediately from the inline review controls. | The task review form invokes the mutation directly on button click. | Open a submitted task and click Approve or Reject. | A reviewer sees the record context and explicitly confirms; rejection requires feedback. | Use a shared accessible confirmation/rejection dialog and retain entered feedback on errors. | Approve, reject-without-reason, reject-with-reason, and double-click scenarios. |
| AUD-003 | Overtime approval | High | Rejection uses `window.prompt`; approval executes without confirmation. | Review logic combines browser prompt and mutation. | Open an administrator OT queue and click either action. | A professional modal captures the action and reason, blocks duplicates, and reports success/error. | Replace the prompt/direct action with the shared confirmation dialog. | Approve/reject pending and already-reviewed requests; verify error state preserves reason. |
| AUD-004 | Timesheet approvals | High | Timesheet approval/rejection can execute immediately from an inline review panel and rejection feedback is optional. | The review API is invoked directly and has no client-side rejection requirement. | Open Attendance Approvals, review a submitted entry, choose Reject with an empty comment. | Approval needs confirmation and rejection requires a reason. | Use the shared dialog and validate reason before calling the existing RPC. | Approve/reject with keyboard, Escape, error and mobile viewport coverage. |
| AUD-005 | Background refresh | Medium | Several screens poll or rerender more frequently than their UI requires. | Reminders rerender every second and refetch every 30 seconds even in the background; the shell also warms many unrelated sidebar endpoints shortly after every app mount. | Sign in and inspect network activity while remaining on a single page. | Fetch only data needed for the viewed/next-likely screen; background tabs should not churn. | Remove broad shell warm-up in favor of existing hover/focus route prefetch; reduce reminder cadence and pause it while hidden. Keep task/attendance live mechanisms intact. | Count initial requests, background-tab requests, focus refresh, mutation refresh. |
| AUD-006 | Dataset import | High | An import is a sequence of client-orchestrated batches; a failed network/cleanup can leave a partial dataset. | Dataset creation and batches are separate requests; cleanup is best-effort from the browser. | Interrupt the client after one or more 250-row batch uploads. | The import is atomic, or a clearly marked recoverable draft is never exposed as complete. | Move completion/batch bookkeeping to an Edge Function transaction/RPC or add import status + server-side cleanup. Requires a Supabase test environment before migration. | Interrupted upload, retry, duplicate workbook, and concurrent import tests. |
| AUD-007 | CRM query performance | High | Some server paths load all accessible records before filtering/aggregating, and dataset serialization issues one count query per dataset. | Arbitrary JSON-field customer search and dashboard/callback aggregations are computed in Edge Function memory; record-count gathering is an N+1 pattern. | Use a store with a large dataset, search customers, load callbacks/dashboard. | Database should paginate/filter/aggregate close to the data with bounded payloads. | Add an indexed normalized search/display field or SQL RPCs for aggregation, then measure query plans and API timings. Requires representative non-production data. | 10k+ record store: dashboard, search, callbacks, reports, dataset list. |
| AUD-008 | Automated QA | Medium | CI has focused Node tests but no browser E2E viewport suite; Django tests are not included in the Pages workflow. | No Playwright/browser harness or Django test job is configured. | Review `.github/workflows/pages.yml`. | Release checks should cover browser workflows and the maintained backend path. | Add E2E fixtures and CI jobs after a test Supabase project/account fixture is available. | Auth, store isolation, scrolling, dialogs, file upload, network error and mobile viewport scenarios. |
| AUD-009 | Live-data verification | Medium | Security and business logic have strong source/tests, but live database/device verification cannot be completed from this workspace. | No test Supabase credentials, representative fixtures, or eSSL device are configured locally. | Attempt non-destructive database/device verification. | RLS, storage policy, queue delivery and biometric data must be verified in an isolated test project. | Run provided Edge-function tests and database migrations against a dedicated Supabase test project; never point these tests at production. | Negative Store A/Store B API/storage tests, reminder receipts, real attendance record reconciliation. |

## Control assessment

- Store isolation is enforced in the Edge Function (`requireStoreContext`/business scope) and exercised by the existing store-boundary tests. The migration set enables RLS and revokes direct browser access to CRM data tables. This is a positive source-level finding, not a substitute for a deployed test-project check.
- Financial fields use PostgreSQL `numeric` columns and validation checks. The reviewed UI computes pending amount as `max(total - paid, 0)`. Cross-screen validation with real data remains pending under AUD-009.
- The frontend is already route-split and defers XLSX. Performance work should focus on request volume and server aggregation rather than adding indiscriminate memoization.
- No production secrets were printed or modified during this audit.

## Implementation order

1. Fix scroll lifecycle and consequential approval/rejection controls (AUD-001 through AUD-004).
2. Reduce unnecessary shell/reminder background work without removing task or attendance live updates (AUD-005).
3. Build and run the existing automated suites; perform local browser viewport checks.
4. Treat import atomicity and server-side aggregation as the next database-backed phase; do not create unverified migrations without a test Supabase project and query-plan measurements.

## Changes applied in this audit pass

| Finding | Status | Evidence |
|---|---|---|
| AUD-001 | Fixed in source; browser verification blocked | Removed manual Offcanvas backdrop/body cleanup. CRM dialogs now have a reference-counted scroll lock that always restores the original document styles during cleanup. |
| AUD-002 | Fixed in source | Task approval/rejection now opens a confirmation dialog; rejection requires feedback and failed submissions retain it. |
| AUD-003 | Fixed in source | Overtime no longer uses `window.prompt`; approve/reject are confirmed in the shared dialog and rejection feedback is required. |
| AUD-004 | Fixed in source | Timesheet approve/reject actions now use the shared confirmation dialog with required rejection feedback. Timesheet and inactive employee deletion also moved from browser confirmations into that dialog. |
| AUD-005 | Partially fixed | Removed broad shell prefetching of unrelated pages. Reminder redraw/poll cadence changed from 1/30 seconds to 60 seconds and pauses while the tab is hidden; focus/visibility restores fresh data. Task and attendance live mechanisms were preserved. |
| AUD-006 through AUD-009 | Open | Require a dedicated Supabase test project, representative non-production data, query-plan measurements, and browser E2E fixtures before a safe implementation can be verified. |

## Post-change verification

| Check | Result |
|---|---|
| Pages-mode Vite production build | Passed |
| All discovered Node `.mjs` suites | 158 passed, 0 failed |
| Django attendance, optional visit, and reminder asset tests under isolated SQLite | 18 passed, 0 failed |
| Static scan for browser prompts/confirmations | No `window.prompt`, `window.confirm`, or `window.alert` usage in `frontend/src` |
| Mobile browser viewport test | Blocked: the Computer Use browser sandbox timed out connecting to the locally bound Vite preview, then the Windows browser URL safety check stopped further UI automation. No application behavior was inferred from that failed test attempt. |

The current classification is **CONDITIONALLY READY**: the implemented frontend fixes are built and covered by the existing automated suites, but data-atomic import work, database-scale performance measurements, live Supabase/storage verification, and browser E2E/mobile viewport testing remain release blockers for a production-ready declaration.

## Phase 2 — production readiness and advanced QA

Date: 7 November 2026. Status: **CONDITIONAL READY**. Source changes are local and migrations have not been applied to a hosted project. The user confirmed that no staging project is available and authorized isolated local verification. No existing customer records were used, deleted, or overwritten in tests.

### Excel import integrity (AUD-006)

Implemented private `crm_import_jobs`/`crm_import_rows` staging tables and the service-only `crm_import` RPC. Starting or batching an upload creates no dataset or customer records. Commit locks the job, verifies every sheet count, and creates the dataset, column definitions, customer rows and completion receipt in one PostgreSQL transaction. A failed commit rolls all of these changes back. Owner/store are supplied by the authenticated Edge handler, revalidated in SQL, and recorded on the committed dataset. Browser roles have no staging-table or RPC access.

The same workbook SHA-256 fingerprint is deduplicated per owner and store. Duplicate batch delivery accepts only identical row content; changed retry content is rejected. Lost commit responses and reinspection return the existing dataset. There is no cross-store/global deduplication or merging by customer name/phone: repeated spreadsheet rows are retained and reported, since no unique-customer business key was specified. The legacy direct batch writer is disabled. A 24-hour expiry and service-only cleanup function support abandoned uploads; a scheduler still needs staging configuration.

Validation covers column and sheet limits, row counts, missing/unknown/nested fields, empty rows, and duplicate source row identifiers. The workbook inspector preserves formatted cell values, original nonblank headings, leading zeroes, Unicode, blank/duplicate headers with unique keys, source row numbers after leading blank rows, and cells extending beyond the header width. Uncached formulas are reported with their cell address and must be recalculated/saved before import. Formula text, workbook formatting and Excel macros are not CRM fields. Limits are 20 MB compressed file size, 50 sheets, 500 columns and 100,000 nonblank rows; mobile memory limits below that maximum still need device testing.

Executed evidence:

- Interruption before completion: zero published datasets/customers; incomplete commit rejected.
- Invalid row after a valid row in the same batch: the complete batch rolled back, with sheet/row error context.
- Injected PostgreSQL failure during customer insertion: dataset, columns and completion receipt rolled back; staged rows retained for retry.
- Identical retries and lost commit response: one dataset, no duplicate customers.
- Foreign account/store, forged store context, and direct authenticated-table/RPC access: denied.
- 25,000 rows staged in 250-row batches, committed, counted and checked: passed; local staging + commit took **2,318.81 ms** in the final recorded run. An actual 25,000-row XLSX encode/read/inspection test also passed.
- Concurrent calls issued against the local engine returned one job for an identical fingerprint. PGlite serializes one connection; genuine multi-session lock contention/deadlock/load tests remain blocked on staging. The database unique key and row lock are implemented but that is not a hosted-concurrency test result.

### Large-data performance (AUD-007)

Customer-name search now uses a maintained `search_name` field with a trigram index. Changes to source fields or dataset columns refresh it. Literal `%`, `_` and `!` searches are escaped and tested. Dataset-field search executes in SQL, and only a 20-row dataset page or 50-row directory page reaches Edge. Counts retain existing search/status semantics. Dataset/user/admin summaries use one grouped dataset-count RPC instead of per-dataset count requests or transporting every customer ID. Dashboard visit/payment totals aggregate in SQL. Callback queues now return 50 rows with database sorting, counts and URL pagination; callback column/reviewer lookups are batched.

Measured in isolated PGlite PostgreSQL/WASM on this machine, with synthetic customer fields (~900 bytes/row). Three runs per size, median; the old approach fetches all rows and filters in JavaScript, while the new approach returns a matching page. IDs and counts are compared on every run. These are local database/serialization measurements, not hosted API latency, mobile render times or a production capacity guarantee.

| Customers | Before (ms) | After (ms) | Before JSON bytes | After JSON bytes |
|---|---:|---:|---:|---:|
| 1,000 | 21.05 | 3.57 | 958,076 | 48,369 |
| 5,000 | 88.26 | 6.77 | 4,809,183 | 48,431 |
| 10,000 | 175.44 | 7.09 | 9,627,688 | 48,535 |
| 25,000 | 429.62 | 27.94 | 24,129,187 | 48,585 |

The first SQL implementation recalculated display names per row and was slower (2,278 ms at 25k). That regression was measured, replaced with the maintained/indexed field, and retested. It was not accepted as an optimization merely because its response was smaller.

Scale coverage remains incomplete for sales/visit-history/target reports, task histories, large dataset directories and live timesheet reports. Some of those paths still use full reads or Supabase's default response cap. Dataset-field substring searches can still scan large JSON values in PostgreSQL. Deep offset pages, much larger stores, SQL query plans/locks under load, collation behavior, and realistic network/Edge resource limits require staging measurement before AUD-007 can be closed.

### Supabase, RLS and multi-store verification (AUD-009)

No hosted staging environment exists. Authentication-provider behavior, complete migration replay on Supabase, Edge deployment, PostgREST schema cache, storage policies, real image persistence, realtime subscriptions, notification/push delivery, and actual attendance integration are **BLOCKED / NOT VERIFIED LIVE**.

Local PostgreSQL tests executed the original CRM core migration, durable business-store migration and all three new migrations. They tested service-role updates, private import access, grouped counts, paginated search/callback data, and exact financial sums. The existing PostgreSQL store-isolation suite also executed store ownership guards, Store A/B profile/timesheet/attendance RLS, foreign-store approval denial and biometric mapping boundaries. Existing Edge handler tests covered role/store checks. The local schemas stub Supabase-owned auth/storage catalogs; this does not verify hosted Auth or Storage services.

### Browser and mobile verification (AUD-001 / AUD-008)

Playwright is configured against the actual React/Vite application with a loopback-only Supabase URL and local network fixtures. Remote calls are blocked. **17 Chromium browser tests passed**, with zero uncaught JavaScript errors. Results and failure artifacts are generated under `tmp/phase2/`; fixtures verify UI requests, not database writes or delivery to external services.

All requested viewport widths passed: **320, 360, 375, 390, 414, 768, 1024 and 1440 px**. Each checks approval/rejection controls, required feedback, cancellation, single confirmed mutation, unlocked scrolling and page-width overflow. Narrow widths also navigate through the mobile drawer and browser history. An additional 390px touch/mobile context repeats drawer and dialog transitions three times. These are Chromium emulation tests; physical phones/tablets, iOS Safari, Android Chrome and biometric devices were not tested.

The browser run reproduced a real high-priority scroll failure: `main.jsx` loaded Bootstrap's prebundled runtime while `AppLayout` imported the module runtime. Both registered Offcanvas handlers and saved conflicting scroll state. Both now use the same module instance; the exact previously failing navigation/dialog sequence passes at all eight widths. The Bootstrap chunk also fell from 48.67 to 24.52 kB gzip. Earlier source-only scroll findings should not be treated as browser evidence; this Phase 2 run supplies that evidence.

Additional browser checks passed workbook file selection/inspection/staged submission, overtime rejection, login/logout, server-401 UI session expiry, timesheet rejection through the attendance RPC, customer search/status filters/edit submission, callback completion and pagination, dataset switching/back-forward history, and employee photo preparation/multipart task evidence submission. Real push receipt and database state after these browser interactions remain unverified.

### Business regression and failed scenarios

| Workflow | Executed coverage | Remaining integration gap |
|---|---|---|
| XLSX → dataset → customers | XLSX 25k test, PostgreSQL staged commit, browser import navigation | Hosted Edge/PostgREST import plus actual client retry/timeout behavior |
| Lead edit → callback completion | Real browser forms/dropdowns, SQL queue counts/paging, scoped handler tests | Single hosted workflow through sales visit and resulting dashboard |
| Task evidence → review | Real browser image preparation/multipart submission and review UI; existing transactional image/review unit tests | Real storage objects, notifications, cross-account review workflow |
| Timesheet → admin decision | Browser RPC request; SQL store-boundary approval denial/authorized approval | Employee creation/submission and hosted totals/realtime update |
| Overtime → decision | Verified-punch calculation tests and browser reason/decision UI | Real eSSL punch sequence, hosted request and final calculation |
| Store/user/permissions | Edge account-role/store tests and local RLS/ownership guards | Real Super Admin → store/admin/user creation with hosted identities |

Failed/blocked checks were retained and investigated: sandboxed Playwright could not start its local server (rerun with approved process access); its new Chromium executable was initially missing (installed matching browser); duplicate Bootstrap controllers caused mobile scroll locks (fixed/retested); the old import adapter test expected direct table writes (updated to assert trusted RPC actor/store); a local service-role fixture initially lacked Supabase's BYPASSRLS property (corrected and actual update verified); new strict row validation required the changed-retry fixture to retain all columns (corrected); leading blank header rows exposed an inspector row-number bug (fixed/retested); and a dataset-navigation test targeted a text label instead of its Open link (corrected). No known assertion remains failing in the executed suites. Hosted integration and the scale gaps above remain open release risks.

### Reproducible checks and CI

From `frontend`: `npm test`, `npm run test:db`, `npm run test:e2e`, and `npm run build -- --mode pages`. Playwright first needs `npx playwright install chromium` (CI installs Linux system dependencies too). Full Django: set `DB_ENGINE=sqlite`, then `python manage.py test customers --verbosity 1`.

- `npm test`: **177 passed** (163 `.mjs` cases and 14 existing pure attendance TypeScript cases through a Node registration adapter). The shared-module cases do not require, or simulate, the Edge runtime.
- Isolated PostgreSQL suites: **20 passed**, zero skipped.
- Full Django SQLite suite: **152 passed**, 185.068 seconds; test database destroyed after completion.
- Playwright Chromium: **17 passed**, 47.8 seconds.
- Pages production build: passed, 282 modules.
- Dependency audit after compatible Vite/redirect updates and upgrading SheetJS to 0.20.3: **0 reported npm vulnerabilities**. SheetJS uses its [maintainer-documented distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), with integrity recorded in the lockfile.
- `git diff --check`: passed (Windows line-ending notices only).

The new reusable QA workflow covers Node, embedded PostgreSQL, Chromium and the full Django SQLite suite. The Pages workflow now waits for it, so deployment cannot proceed after a failed QA job. Workflow configuration was reviewed locally; no GitHub Actions run was triggered or claimed as passed.

### Remaining risks and deployment recommendations

1. Provision an isolated Supabase staging project. Apply the existing migration chain, then `202611070001`, `202611070002` and `202611070003`; confirm all service-only grants and negative browser-role access. Test schema reload, Auth, RLS, Storage and realtime against actual users in two stores.
2. Deploy the matching Edge Function and frontend together in staging. The new frontend requires the new RPCs; the old import batch protocol is intentionally blocked. Verify interrupted uploads, lost commit replies, multiple database sessions, cleanup scheduling and full import-to-sale workflows there.
3. Measure backfill/index locks and resource use with representative staging data before any production migration. New indexes/backfill run in a transaction and need a planned maintenance window on a large existing database. The source does not enable a hosted cleanup job automatically; schedule `crm_cleanup_imports()` under service authority after staging verification.
4. Complete the unresolved sales/task/timesheet/dataset-directory scale tests, mobile memory tests and physical-device checks. Large XLSX parsing remains in the browser main thread; the deferred safer SheetJS version adds about 20 kB gzip to the XLSX chunk.
5. Keep production on hold until required staging integration, concurrency and scale checks pass. Take a production backup before approved rollout. Deploy migrations → Edge → frontend, check smoke tests and monitoring. On failure, disable imports and restore a compatible release through the deployment system; do not delete committed customer records or blindly reverse schema migrations.

AUD-006 is implemented and locally verified, pending hosted validation. AUD-007 is partially resolved with measured customer-search improvements and bounded dashboard/callback/count paths. AUD-008 has reproducible browser/CI coverage but not a complete live integration suite. AUD-009 is blocked by the confirmed lack of staging. **PRODUCTION READY is not declared.**

## Phase 3 — complete business module validation

7 November 2026, Asia/Kolkata. Release status: **CONDITIONAL READY**. The Phase 1/2 changes were inspected and preserved. Separate QA reviews covered sales/reports, attendance/timesheets, and customer/admin/reminder behavior; the primary reviewer integrated their fixes and added combined-schema, task and overtime transactions and browser checks. No hosted migration, deployment, production data mutation, real email, push delivery or hardware action was performed.

The evidence below distinguishes real local SQL/handler execution from browser fixtures and provider integration. PGlite runs PostgreSQL with the repository's actual business tables, functions, triggers, constraints and relevant migrations; Supabase-owned Auth/Storage catalogs are local prerequisites. Tests that execute Edge handlers use adapters for the database transport and external provider boundaries. Production functionality was not replaced with mocks. Chromium exercises the actual React app with explicit loopback-only test responses and blocks remote calls. These layers do not prove a complete hosted deployment.

### Module-wise results

Every module remains conditional pending the listed integration checks. A passing unit test alone is not classified as a fully verified module.

| Business module | Executed successful, failure and security scenarios | Database/consistency evidence | Still blocked or incomplete |
|---|---|---|---|
| Customers and datasets | Import/retry regression including 25k XLSX; dataset creation/rename/delete; all five lead states; customer delete; immutable spreadsheet fields; invalid dates; foreign-store denial; search/filter/paging browser checks | Actual handlers → PostgreSQL mutations, change-history counts, failed-history rollback, safe deletion cascades and preserved Store B records. Rename preserves filename/provenance. Standalone imported-customer creation is the workbook path; manual customers belong to Sales | Hosted upload/timeout/concurrency, real Storage cleanup; deep-page and mobile memory scale |
| Leads and callbacks | Schedule, complete once, all final outcomes, reschedule completed callback, reject absent/impossible dates, today/tomorrow/custom/date sorting/pagination regressions, browser note/status edit and completion | Customer CRM mutation/history now one transaction; rescheduling clears old completion fields; SQL queues and combined workflow agree with completion history | Hosted multi-tab races and a live sales/dashboard workflow across accounts |
| Sales visits and finance | Imported/manual clients; all five outcomes and four payment labels; create/edit/delete; image metadata; invalid amounts/precision/range/calendar dates; foreign/store/owner denial; failed DB/upload boundaries; replay after lost reply | Real handlers → PostgreSQL validate before writes. Manual client, visit and image metadata commit together; injected failures preserve prior client/finance records. Pending = max(total−paid,0), rounded to cents; totals checked against SQL | Real Storage uploads/cleanup and cross-service failures; retries from old clients or a reloaded/new form lack the old request key |
| Sales targets and reports | Create/edit month target; actual conversion counts without a target; percentages/remaining count; 1,005 targets; historical warning thresholds; six-month India-calendar trends; 25,001 visits | Target outcomes and SQL financial/count aggregates compared against underlying synthetic records and an independent reference calculation; foreign-store report empty | Hosted timings/query plans; very large full-history sales selection/list still transports whole histories |
| Reminders/notifications | Create/edit, timezone instant, due/upcoming; actual Chromium notification denial saves with warning; scheduler claim/lock, stale/expired revisions, duplicate receipt, offline/retry worker regressions | Actual claim and receipt functions retain first receipt timestamps, reject old revisions and deny browser-role execution. Rescheduling resets delivery state/revision | Actual pg_cron/pg_net scheduling, push provider receipt, closed-browser/OS behavior and physical delivery |
| Tasks | Assignment → evidence submission → rejection/feedback → exact resubmission → approval → durable final notification; overdue regression; stale/duplicate decisions; inactive/employee/cross-store restrictions | Actual task/photo/submission/notification SQL transactions. Injected notification failures roll back assignment, evidence and decisions. Fallback reviewers restricted to store admins/global Super Admins; private internal functions cannot be called by service_role directly | Real object storage, realtime notification transport, real admin/employee browser sessions and hosted contention |
| Attendance | Unified-session and identity regressions; existing ingest-route tests; pairing/break/net hours and grace rules; IST UTC/offset/backup formats; employee/date scope; complete employee pages; browser XLSX read-back | Existing store-boundary SQL checks plus timestamp/calculation tests; 1,201 employees and failure on later-page reads; original 5-minute grace/7-hour classification and punch pairing preserved | Physical eSSL records/mapping, actual SSO provider, device-vs-backup reconciliation, very large export memory |
| Timesheets and overtime | Daily entry and XLSX browser workflow; submit → reject → rework → approve; required feedback; duplicate/stale decision; missing/odd punch pairs; captured shift; exact OT minutes; long feedback; wrong working day; invalid/global request | Actual timesheet and overtime SQL functions, scope/role denials, immutable reviewed timestamps; overtime decision + alert atomic. Failed alert rolls back request/decision; requested and verified minutes stay distinct | Physical final punches, provider notifications, real multi-session approvals and overnight business-shift requirements |
| Administration | Role/user creation/edit, inactive auth, immutable ordinary-store membership, global promotion/demotion with required store, Auth/profile rollback; password reset equality, literal/case-insensitive identity and cooldown; browser demotion form | Handler tests plus private reset resolver/CAS cooldown in PostgreSQL. Promotion/demotion leaves business records in original stores. Failed new-profile creation removes only new Auth account; email/store validation occurs before Auth changes | Actual Supabase Auth account lifecycle/recovery links, email delivery, timing-side-channel/rate-limit behavior and provider rollback failure |
| Multi-store workflows | Admin/employee/Super Admin paths, empty store, customer/dataset/visit/task/report isolation, header/body overrides, negative direct-RPC/table reads, inactive access, attendance mappings | Actual RLS/ownership/task wrappers/customer/visit/OT functions, scoped handlers and combined-schema replay. Private import/history/report/reset functions not browser-executable | Hosted Store → admin → users lifecycle and actual Storage/realtime policies; selected-store Super Admin checks against deployed services |

### Confirmed bugs and fixes

| ID | Severity | Reproduced root cause | Fix and retest evidence |
|---|---|---|---|
| P3-001 | High | Customer update committed before a separate history insert; audit failure left unlogged state | Migration006 row-locks and saves mutation/history together; injected history failure leaves the previous record intact |
| P3-002 | High | Reopened callback retained completion metadata; missing callback dates and concurrent/stale completion were not consistently rejected | Migration006 clears completion on reschedule and validates pending state/date under lock; history, final outcome and queue counts verified |
| P3-003 | High | Financial validation ran after manual-client writes; visit and attachments used separate mutations | Migration007 validates first and commits client/visit/image metadata atomically; invalid input and injected metadata/write failures leave no partial financial/client rows |
| P3-004 | High | Lost create reply followed by retry could create a second visit | Per-form UUID and private SHA-256 receipt, serialized by advisory transaction lock; exact replay returns same visit, changed fields/evidence conflict, deletion tombstone prevents resurrection; fresh form allows legitimate repeat visits |
| P3-005 | Medium | Overpayment was rejected only for converted visits; imprecise/out-of-range money and regex-only dates/months could reach DB or inconsistent pending displays | Validate every outcome, exact calendar values and cents/ranges before writes; round serialized pending to cents. Four payment labels remain user-selected as in Django; labels are not automatically rewritten from balances |
| P3-006 | Medium | No-target serialization hid real conversions; initial target read capped at 1,000; current/future targets contributed to already-failed warnings | Count conversions independently, fetch bounded pages, use batch target counts, and apply historical warnings only to finished months. Original ≤30% rule remains |
| P3-007 | Medium | Admin summary counted grouped dataset rows as customers; Reports downloaded all visits and could use host-local month boundaries | Sum grouped counts; service-only sales report RPC aggregates SQL totals/trends in the India calendar. 25,001-row reference checks and browser report test pass |
| P3-008 | High | Task SQL relied on API-only store checks; notification fallback could notify unrelated-store admins | Migration005 store wrappers around existing transactions; restrict fallback recipients; negative SQL access, private-function grants and notification-recipient checks pass |
| P3-009 | High | Timesheet server accepted empty rejection and overwrote an already reviewed decision/audit | Migration004 locks Submitted rows, validates Approved/Rejected and feedback, and rejects repeat decisions; employee correction/resubmission path preserved |
| P3-010 | High | OT serialization referenced undefined `ctx`, breaking nonempty lists/create/review; unassigned global accounts could create unreviewable requests | Explicit serializer context and actual-store requirement for request creation; global review rights preserved; direct regression and SQL tests pass |
| P3-011 | High | OT decision/request and alert were separate writes; repeated review could overwrite decisions; long text exceeded reminder limit | Migration008 row-locks decisions, verifies final closed punch pair and commits the alert together; bounded alert text retains full feedback. Failure injection and duplicate-decision checks pass |
| P3-012 | Medium | OT defaults combined UTC day/local clock; pending verification used new employee shift instead of captured shift; modal called requested minutes “verified” | IST inputs/serialization, captured shift/cutoff and separate actual verified minutes; UTC-boundary, shift-edit and missing-punch tests pass |
| P3-013 | High | Single PostgREST reads silently omitted later employees, timesheets, tasks and overtime; aggregates/exports were incomplete | Fresh bounded queries and stable ID order; 2,501 task/timesheet/OT and 1,201 employee tests; later-page failures reject partial reports |
| P3-014 | High | Forbidden store edit could change Auth email before returning an error; profile-write failure could orphan new Auth or leave mismatched email | Validate before Auth mutation, clean only new account on create failure, restore email/profile on failures; fault-injection handler tests pass |
| P3-015 | High | Super Admin role changes retained stale membership or could not demote a global user | Detach profile membership on promotion; demotion requires a valid explicit store; ordinary store transfers remain denied. Rollback restores role/store; business rows unchanged; browser required-store test passes |
| P3-016 | High | Password-reset body/status exposed known accounts; identity case/aliases and old inactive flags were inconsistent; cooldown read/write raced | Uniform account-dependent response, private exact case-insensitive resolver, current active alias check and atomic 60s claim before Auth/mail. Wildcards literal; ambiguous identities fail closed. No email was sent in tests |
| P3-017 | High | Dataset/visit deletion removed image objects before a potentially failing DB deletion; customer deletion omitted object cleanup | Delete DB rows first, then clean referenced objects after success; failed DB deletes preserve rows/metadata/objects. Successful cleanup is tested at the adapter boundary; remote cleanup remains best effort |

### Database integrity, security and combined workflow

The combined-schema test replays relevant original core/legacy/task/photo/attendance/store migrations followed by all nine prepared 7 November business migrations. It excludes hosted scheduler/HTTP infrastructure migrations, and therefore is not a claim that the complete Supabase deployment chain was replayed. This test then runs actual SQL for workbook staging/commit → callback schedule → final converted outcome/history → imported-customer visit → financial summary and six-month report, checking the original fields, exact 70.15 pending balance, 2.75 expense, record counts and callback completion.

Separate tests exercise user/store isolation and direct denied access as `authenticated`/`anon`, with service-role-only RPCs. Task tests deliberately fail notification triggers at assignment, evidence submission and review and verify rollback. Sales/customer/OT tests inject record/history/alert failures and verify prior state or zero partial records. No existing customer or device record was used. Local single-connection promises exercise uniqueness/CAS and row-lock logic, but do not constitute real multi-session concurrency proof.

### Performance and regression evidence

Latest integrated local sales measurement: **25,001 visits**, full-history serialization **14,714,516 bytes / 547.40 ms**, aggregate report **405 bytes / 171.36 ms**. This is one PGlite/JavaScript run under concurrent local checks; it measures the changed report path and is not a hosted response-time SLO. Database totals, status counts, six-month bins, owner scope and empty foreign-store result were asserted. Customer 25k regression also remained correct (531.79 ms full rows versus 32.95 ms paginated SQL median in that run). Timings vary with local load; Phase 2 measurements remain historical.

The active sales list/client selector, complete task/OT histories, long target histories and very large XLSX rendering still need bounded UI/payload capacity tests in staging. This pass fixes omission at response caps; fetching every page alone is not claimed to solve unbounded response size.

Final commands/results are recorded below. Counts include named parent tests where Node reports them; the SQL-backed cases are not all unit tests.

- `npm test`: **221 passed**, zero failures/skips in the final consolidated run (including SQL-backed sales/reset cases and the verified-OT regression).
- `npm run test:db`: **56 passed**, zero failures/skips, including Phase 2 integrity/scale regression and new combined workflows. Sales-handler and reset-SQL suites also execute within `npm test`.
- Chromium: **22 passed**, 46.8 seconds; the final OT display change also passed a targeted Chromium rerun. All eight prior viewport widths plus touch emulation remain covered. New checks include denied real browser notification permission, timesheet form/XLSX read-back, role demotion/store selection, aggregate report requests and manual-visit retry key/pending balance. Network responses are test fixtures; these do not prove hosted database or delivery integration.
- Pages production build: **passed**, 283 modules. `git diff --check` passed with line-ending notices only.
- The legacy/backend Django source was unchanged in Phase 3; its Phase 2 full SQLite result (152 passed) is retained as historical evidence rather than claimed as a new run.
- No CI workflow was triggered and no hosted or physical test is marked passed.

### Remaining issues and blocked tests

1. No staging Supabase project is available. Hosted Auth, PostgREST policies/cache/limits, full hosted migration replay, real Storage authorization/uploads/signed URLs, realtime and edge-runtime behavior remain blocked. External SMTP/push/OS delivery and physical eSSL attendance/reconciliation remain blocked. No module is declared fully verified.
2. Browser tests use local transport fixtures. Cross-account browser sessions against actual RLS, complete Store → admin → employee provisioning, provider password recovery and live notification delivery must still pass in staging.
3. Storage and Auth are separate services from PostgreSQL. Post-delete/upload-failure object cleanup and Auth rollback can fail remotely; local transactions and adapter checks do not prove eventual cleanup. Durable orphan reconciliation and operational monitoring need staging verification. No background infrastructure was installed by this pass.
4. Visit idempotency is scoped to the retained form request UUID. An old client omitting it or a new form after reload cannot reuse the former receipt automatically. Real multi-session lock contention/deadlock and externally lost-response tests remain open.
5. Password-reset response equality is verified, not constant-time behavior or real provider abuse resistance. The atomic cooldown retains a 60-second claim after provider failure; this intentionally prevents an immediate retry flood. Hosted delivery/limits still need testing.
6. Physical-device/browser coverage remains emulated Chromium; iOS Safari/Android hardware, actual background push, overnight shift requirements and maximum-memory exports are not verified. Existing attendance pairing, grace and net-hour business rules were preserved.
7. Prepared Phase 3 migrations are `202611070004`–`202611070009`. They were applied only to disposable local engines. The matching CRM Edge Function, password-reset function and frontend require these schema changes. Keep production rollout on hold; verify them together in staging before seeking deployment approval.

Current release decision: **CONDITIONAL READY**. Local business integrity and negative-security coverage is substantially stronger; complete hosted and physical workflow proof remains outstanding. **PRODUCTION READY is not declared.**

## Phase 4 — advanced security, concurrency and performance engineering

7 November 2026, Asia/Kolkata. Status: **CONDITIONAL READY**. Phase 1–3 source, tests, migration changes and this audit were inspected before making these changes. Existing working-tree changes were preserved; the six Phase 3 migrations `202611070004`–`202611070009` were not rewritten. This section supersedes the corresponding open local checks above while retaining their historical evidence. No deployment, hosted migration, production connection, real account email, device operation or production-data test was performed.

### Confirmed failures and corrections

| ID | Severity | Reproduction and root cause | Minimal correction and evidence |
|---|---|---|---|
| P4-001 | High | A retained Django hash could be used after an administrator/provider password reset to replace the new Supabase password. An upgrade already in flight could also arrive after the reset | Migration 010 revokes the retained hash in the Auth password transaction; a service-only upgrade marker is rechecked under the Auth row lock and removed before persistence. Actual handler/SQL cases cover both operation orders, rollback and provider identity mismatch; native concurrent sessions leave the reset authoritative |
| P4-002 | High | Store A employee → global Super Admin → Store B account made Store A attendance visible to Store B through policies deriving scope from current profile membership. Direct SQL reproduced the exposure with the old guard disabled | Immutable `store_binding_id` survives promotion; both API validation before Auth writes and a DB trigger reject another-store reassignment. Original-store demotion and a new global account's first store assignment remain valid. Ambiguous historical globals fail closed |
| P4-003 | High | One-time legacy migration consumed its token after cross-service writes; parallel requests could both create/update data before one lost the final token update | Service-only conditional claim occurs before the first side effect. Native eight-session claim returns exactly one true. An interrupted claimed import requires reconciliation and deliberate reauthorization, rather than automatic replay |
| P4-004 | High | Transaction locks protected each customer/visit write but did not compare the version originally loaded by the browser. Two stale customer drafts both saved and produced two history entries | Migration 012 adds monotonic revisions and authorized row-locked compare-and-save wrappers around the existing customer/history and visit/client/image transactions. Customer, callback and visit UI send the captured revision. Missing token returns 428; stale token 409. Native customer and financial races accept one update and reject the stale one; browser 409 keeps the draft editable |
| P4-005 | Medium | A pending GET could repopulate invalidated cache with an old response; an old failed request could delete a fresh response. Unescaped query separators collided; 1,000 distinct searches retained 1,000 entries | Request-identity/generation checks, encoded keys, expiry cleanup and a bound of 200 entries. Four pre-fix failures were reproduced; regression cases now pass |
| P4-006 | Medium | An older session refresh could restore user state after expiry/logout/unmount; Promise.race auth timers were left pending | Session generations, mounted checks and cleared timeout handles. Actual Chromium pending refresh cannot undo session expiry |
| P4-007 | Medium | Health probes could overlap, continue in hidden tabs or publish after disposal; offline status unmounted the workspace and discarded drafts | A coalesced, abortable visibility-aware monitor clears listeners/timers on disposal; ConnectionGuard preserves the mounted workspace while offline. 100 disposal cycles retain zero monitor resources; Chromium offline/online recovery preserves unsaved notes |
| P4-008 | Medium | Sales list/client selection transferred whole histories; customer history lacked navigation past the response cap and fetched one author profile per entry. Report hover prefetched complete visit history | Migration 011 returns 5 visits/page, 50 client options/page and 50 audit entries/keyset page; authors are loaded in one batch. Matching React navigation/load-more UI and aggregate report prefetch are implemented. 25k-row correctness, payload and query-plan measurements are below |
| P4-009 | Medium | Confirmation focus could escape or include hidden controls; daily timesheet modal lacked full keyboard containment and associated labels; employee administration labels were unassociated | Shared dialog focus containment/restore and explicit form labels; keyboard/Tab/Shift+Tab/Escape and password visibility checks pass in Chromium |
| P4-010 | Medium | Database/provider failures exposed raw diagnostics and treated timeouts as ordinary invalid input | Safe 503 recovery messages for connection/timeout/deadlock/provider failures, 403 authorization, 409 conflicts and sanitized type/constraint errors. Explicit business validation messages are retained. Later-page failures still reject the entire report rather than silently returning partial data |
| P4-011 | Medium, deployment-dependent | Repository buckets were private but no explicit Storage object policy constrained an accidentally broad deployed permissive policy. The local catalog test demonstrated direct access under such a policy; no hosted exposure was asserted | Migration 010 adds a restrictive anon/authenticated policy for the two CRM image buckets and forces private flags. Local SQL proves denial despite a broad permissive policy, retained service access and unaffected other-bucket behavior |

Initial regression failures caused by tests expecting raw DB diagnostics were updated to assert the new sanitized 503 contract while retaining the failure/partial-response assertions. A new employee-form browser fixture initially used a Store Admin account, which correctly lacked global employee creation; the fixture was corrected to a global account and retested. Unprivileged local server/browser process attempts were interrupted when sandbox restrictions prevented progress; authorized isolated runs succeeded. These attempts are not represented as application defects.

### Database and multi-store security

The expanded combined replay applies the actual core, legacy, task, attendance and store business schema plus all twelve prepared 7 November migrations. Auth/Storage-owned catalogs are minimal disposable prerequisites, not substitutes for the hosted services. Scheduler/HTTP/Vault provisioning is excluded. Actual `authenticated`/`anon` permission checks and the grant inventory find no browser-role INSERT/UPDATE/DELETE privilege on any public business table. Authenticated SELECT is restricted to the seven intended profile/attendance/notification/settings tables; privileged business mutations remain behind service-only authorized Edge/RPC operations. The allowlist covers the intended login/attendance helpers; private import/reset/history/report and task/customer/visit internal transactions are not browser executable, and internal wrappers are revoked even from service_role.

| Boundary | Local evidence | Qualification |
|---|---|---|
| Datasets, columns, customers, history and callbacks | Handler store/owner checks, immutable original spreadsheet fields, direct browser write/RPC denial, foreign-store mutation denial and atomic history rollback | Service-role query functions trust Edge-supplied scope; deployment must keep service credentials private and use the matched authorization code |
| Visits, clients, images, expenses and reports | Owner/store denial, atomic related records, foreign report/page scope and SQL totals; version check occurs only after authorization | Storage HTTP/signed URL behavior remains separate |
| Tasks, evidence, submissions, alerts and targets | Store-aware SQL wrappers and recipient RLS, private internal grants, promotion/demotion binding guard; duplicate final decision creates one alert | Complete task/target histories remain an API capacity concern |
| Reminders, deliveries and subscriptions | Owner/store handlers, private delivery functions, revision/receipt tests and disjoint concurrent worker claims | Real cron/push and external endpoint behavior are not provider-verified |
| Attendance, mappings, timesheets and overtime | Actual RLS and review RPC denials, inactive identity loses access, punch-code scope, immutable account binding, transactional approvals | Existing pairing/grace/net-hour business rules unchanged; physical source reconciliation blocked |
| User administration and global views | Active profile read on protected requests; store binding validated before Auth mutation; new global first assignment versus previously bound demotion tested separately | Concurrent Auth/profile changes span services; provider rollback/revocation and sustained administration races require staging |

SQL functions use explicit search paths, browser grants were inventoried, and unrelated-store records remain intact after negative tests. Tests are an authorization audit of the repository schema and paths, not security certification or proof that deployed policies match it.

### Authentication, sessions and Storage

The legacy resolver now uses exact case-insensitive comparisons against current active profiles/current email rather than a capped global read and stale imported flags. Password-reset response equality/cooldown regressions remain passing. Local tests verify immediate profile-based authorization changes for the same issued UID, logout/expiry UI races, retained credential revocation and failed password-write rollback. Actual GoTrue token expiration/rotation/global-device signout, recovery/OTP delivery and Auth trigger compatibility are **blocked** without staging.

Migration 010 deliberately revokes legacy hashes for accounts with a later Auth update or a successful sign-in: they must use their current password or recovery/admin reset. It requires the actual Auth password/metadata/timestamp columns and Storage catalog privileges. Store bindings are backfilled from current membership or one unambiguous persisted historical business store. Globals with unresolved derived history cannot be assigned a store until ownership is reviewed. This is a justified correction to Phase 3's unrestricted global demotion behavior because a cross-store RLS exposure was reproduced.

Both CRM image buckets stay private with a262,144-byte object limit. Existing upload validation checks JPEG/PNG/WebP signatures as well as MIME, maximum 1280 px edge,256 KiB image/20 KiB thumbnail limits, matching thumbnail dimensions and at most 10 photos/stage. UUID object paths use the authenticated actor, uploads do not overwrite existing objects, and partial uploads are cleaned at the adapter boundary. Profile-image validation/ownership and the existing photo regressions remain in scope; no arbitrary public bucket was introduced.

Signed URLs remain one-hour bearer capabilities, with a45-minute server cache and long object cache-control. A previously issued URL/client cache is not immediately revoked by logout or deactivation. Actual URL expiry, cache, HTTP policies, Auth metadata handling, upload/metadata interruption and eventual orphan cleanup are hosted-blocked. The new restrictive object policy prevents direct browser-role object access; authorized URL issuance still depends on the Edge store/owner checks. No real objects or provider credentials were accessed.

### Real multi-session PostgreSQL concurrency

An installed PostgreSQL 16.12 binary was used to initialize a new cluster under `tmp/phase4-pg-20261107-b2`, bound only to 127.0.0.1:55483. The scripts have fixed loopback/QA-user settings, create new randomly named QA databases and do not read application credentials, connect to an existing CRM database or drop existing databases. Actual business migrations/functions/triggers executed through psycopg connections. Each race starts independent backend PIDs at a barrier with transaction and statement/lock timeouts. These are database sessions with explicit synthetic actors, not hosted JWT/Edge/Storage sessions.

`python scripts/phase4-concurrency.py`: **15 scenarios,56 independent operations passed**. A preliminary baseline accepts both stale drafts; after migration 012 the same race accepts one. The final run verifies:

- Customer and financial stale edits: one success/one 409-equivalent SQL conflict; failed customer draft creates no history; pending money reconciles with SQL.
- Simultaneous callback completion, two task reviewers and two OT reviewers: one final transition, one decision notification, verified 35 OT minutes.
- Six identical visit requests: one visit and one receipt identity; four same-file import starts/commits: one import/dataset.
- Eight password-reset claims and eight one-time migration claims: exactly one true claim in each group.
- Two first-store account assignments: one immutable binding; reset versus in-flight legacy upgrade: reset password remains authoritative and upgrade metadata is removed.
- Eight reminder workers: disjoint claimed IDs with no duplicate claim; foreign-store customer/visit writes both denied without changing financial/history data.

The report records backend PIDs, outcomes, SQLSTATEs, durations, schema names and integrity assertions in `tmp/phase4-concurrency-results.json`. This closes the prior absence of genuine local multi-session evidence. It does **not** prove sustained multi-store load, deployed Edge contention, connection pooling, global-device session behavior or universal conflict protection: ordinary reminder/target/account edits do not all use the customer/visit revision protocol. Those limitations remain explicit release risks.

### Query plans and large-data results

`scripts/phase4-performance-native.py` creates a separate new QA database and uses real `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` with 25,000 rows each for customers/callbacks, customer changes, visits, tasks and attendance. Measurements below are warm local medians, in milliseconds; no hosted latency/SLO claim is made. The two focused indexes match the actual store/date visit order and per-record history cursor. Existing attendance/callback indexes were measured rather than adding speculative indexes.

| Query / payload | Before | After / current |
|---|---:|---:|
| History ordered first 50, underlying query |8.971 ms, scan/sort |0.030 ms, history page index |
| Sales ordered first 5, underlying query |0.261 ms |0.026 ms, store page index |
| History JSON |25,000 rows /17,366,683 bytes |50 rows /34,874 bytes |
| Sales JSON |25,000 rows /24,197,789 bytes |5 rows /4,915 bytes |
| Sales page RPC, including exact count |— |7.440 ms; employee 6.292 ms; filtered 12.475 ms; page 5000 18.973 ms |
| History RPC / client first page |— |1.270 ms /0.529 ms; client 50 rows /4,183 bytes |
| Arbitrary-field client search / deep page |— |53.017 ms /4.234 ms |
| Callback page RPC / underlying first page |— |18.418 ms /0.069 ms |
| SQL sales summary |— |21.510 ms |
| Six-month/all-time sales report |133.351 ms, repeated history scans |14.615 ms, monthly/status grouping |
| Existing complete task list SQL |— |14.809 ms; full response still unbounded |
| Attendance employee-month / store-month / full-store read |— |1.617 ms /3.287 ms /14.977 ms |

Raw plans, buffer counts, payloads and assertions are in `tmp/phase4/performance-native.json`. Raw JSON measurements exclude hosted HTTP, signing and React rendering. The performance SQL/handler suite also traverses all 500 history pages without duplicates, validates tied timestamps, compares sales filters/counts to an independent full-row calculation, preserves manually entered clients/selected edit clients, treats wildcard characters literally, denies browser RPC access and checks one batched profile read for 50 history authors. API inputs, negative scope and final-page behavior are covered.

The sales report initially materialized the full visit history and rescanned it for each month/status/total. Migration 011 aggregates monthly/status groups in one base-table pass. Native before/after report JSON is identical across six store/owner combinations, with independent financial and six-month reconciliation. The original Phase 3 migration 007 is preserved. Timing differences from earlier local runs reflect load/cache variation; this table records the final native run.

Existing 25k XLSX/customer regressions,2,501-row task/OT/target completeness and six-month India-calendar financial reference tests also remain passing. Counts/aggregates and arbitrary-original-field search remain scan work; deep sales/client offset pages still grow with depth and can shift during concurrent insertions. Complete task/OT/reminder/target histories and very large XLSX/export memory are **not solved** by these two indexes. Pagination/capacity and sustained hosted-load work remain before an enterprise-scale claim.

### Frontend, recovery and accessibility

The cache is bounded at 200 entries with encoded keys and mutation/session/store-aware invalidation. Response request identity prevents late stale publication or deletion of a newer entry. Auth timeout handles clear after settlement. Health checks coalesce, abort/dispose and stop while hidden; offline UI keeps forms mounted. Report hover requests the SQL aggregate rather than the complete visit history. Customer/visit/detail effects ignore stale responses after navigation/unmount, and customer save errors retain the editable draft.

Actual Chromium tests cover delayed session refresh after expiry, captured customer revision 7/conflict/draft/reload,20 simulated hidden seconds without extra health probes, offline/online recovery, focus containment/restore, hidden controls, all daily-work labels and global employee form labels/password visibility. Existing mobile/touch widths and notification-denial regressions remain passing. A shared monitor's100 setup/dispose cycles leave zero timers/listeners/intervals. After 100 isolated dialog mount/open/close cycles with CDP GC: documents 2→2, DOM nodes 45→45, listeners 181→181, JS heap 3,785,096→3,999,512 bytes (+214,416). This is a bounded development-Chromium component measurement, not a whole-app or device memory certification. Stable evidence is `tmp/phase4/frontend-resource-evidence.json`.

Pages build remains split/lazy by route. The measured build has 286 modules; app entry 77.25 kB (24.19 kB gzip), React 261.51 kB (83.18 kB gzip), Supabase 223.73 kB (58.62 kB gzip), Bootstrap 81.44 kB (24.52 kB gzip), Axios 51.44 kB (19.49 kB gzip), lazy XLSX 499.55 kB (162.96 kB gzip), Attendance 57.81 kB (13.82 kB gzip). These are build chunk sizes, not initial transferred bytes or user-device interaction timings. Broad screen-reader and physical Safari/Android testing remains blocked.

### Regression, failed/blocked checks and release gate

- `npm test`: **232 passed**, zero failures/skips; includes source handlers and SQL-backed finance/reset regressions.
- `npm run test:db`: **82 passed**, zero failures/skips; includes the combined schema replay and Phase 4 security/performance SQL/handler suites. Test totals include parent cases reported by Node.
- Final consolidated Chromium run: **35 passed**, 1.4 minutes, zero failures/skips. This includes all earlier scenarios, employee administration labels, 64 cross-module navigations, bounded sales/history/client workflows and stale navigation responses. Actual React/router/providers execute against explicit loopback transport fixtures; hosted integration is not inferred.
- Native concurrency: **15 scenarios / 56 independent operations passed** with separate PostgreSQL backend PIDs; native performance SQL/plan assertions passed. The owned loopback PostgreSQL QA cluster was stopped gracefully after measurements; synthetic database files and evidence were retained.
- Pages production build and `git diff --check`: passed. No CI run or hosted rollout was triggered. Legacy Django/attendance business rules were not changed; the Phase 2 Django 152-pass result remains historical, not a new Phase 4 run.

Prepared Phase 4 migrations are `202611070010_phase4_security.sql`, `202611070011_phase4_performance.sql` and `202611070012_optimistic_concurrency.sql`. They were applied only to new local disposable engines. The Auth trigger, immutable store-binding correction, service-only functions and versioned client protocol require coordinated staging review with the matching Edge/frontend. Existing clients that omit update revisions must reload; the database fails closed rather than accepting an unsafe edit.

There is still no staging Supabase project. Hosted Auth/PostgREST/Edge/Storage/realtime/provider behavior, full infrastructure migration replay, sustained concurrent account/API load, actual push/mail, physical biometric records and real mobile/browser-device coverage remain blocked. Auth/Storage/DB rollback and orphan reconciliation span services. Previously issued signed URLs retain their capability lifetime. Whole-history API/export capacity and ordinary account/target/reminder edit conflict semantics remain risks. These are not marked passed based on unit tests, local catalogs or browser fixtures.

Additional whole-application resource evidence: after warming eight routes, Chromium performed 64 actual SPA navigations through sidebar links across Dashboard, Customers, Datasets, Callbacks, Reminders, Reports, Attendance and task-review notifications. After GC, DOM nodes 940→940, listeners 285→285, intervals 5→5, Supabase channels 2→2, API cache entries 11→11 and pending API requests 0→0. JS heap was 8,335,904→9,670,060 bytes (+1,334,156). A 5.5-second hidden observation produced zero additional API requests; no uncaught browser errors occurred. See `tmp/phase4/cross-module-resource-evidence.json`. This uses real routing/providers/components with synthetic empty datasets in development Chromium; large-image/export memory, actual realtime transport and physical devices remain unverified.

Five Chromium performance workflows verify server-side sales paging, client load-more and selected edit-client carryover, keyset history navigation, and stale navigation responses. They passed separately and in the final consolidated 35-test browser run.

The separate [hosted verification checklist](HOSTED_VERIFICATION_CHECKLIST.md) lists required setup, identity/store roles, negative API tests, provider recovery, scale/concurrency, storage/cache, physical-device evidence and the release decision. Current release decision remains **CONDITIONAL READY**; production readiness and security certification are not declared.

## Phase 5 — final release validation and independent QA

7 November 2026, Asia/Kolkata. Final status: **CONDITIONALLY READY** (the same conditional category used above). Production deployment is on hold. This pass read both audit/checklist, enumerated all 112 reachable Git commits and their changed paths, reviewed the prepared migration chain and independently rechecked the local candidate. HEAD is `62a251cbad5ce1ce8ae01e3c19689224b6d72fbe`; the tested Phase 1–5 changes are uncommitted, so HEAD is not a complete release identity. No commit, push, hosted migration, production data modification or provider/device message was performed.

The complete [PRODUCTION_RELEASE_REPORT.md](PRODUCTION_RELEASE_REPORT.md) includes the Phase 1–5 issue register, final severity/disposition, module/workflow evidence, remaining defects/limits, backup readiness, deployment/rollback plan and release gates. The source/commit/migration inventory is reproducible with `scripts/phase5-release-manifest.py`; `tmp/phase5/release-manifest.json` hashes the allowlisted candidate, while the initial manifest is retained separately.

### New confirmed issues and retests

| ID | Severity | Reproduced failure | Correction / final result |
|---|---|---|---|
| P5-001 | High | Prepared search backfill 002 fired the normal customer timestamp trigger; a historical edit from 2026-09-02 became migration time, changing history display/callback ordering | Suspend only that timestamp trigger around the derived-field update, inside the same transaction, and reenable. Native historical fingerprints/timestamps and injected-failure rollback pass. Original 002 SHA-256 `2746d2b33a2876d499c582f874490220444bce7c4a101f9bffe932060ff2c42e`; corrected `46c212672fe8487909a98581ab3bc3d8b43c66a547dcd0b43210f576434dc65b` |
| P5-002 | High | Existing-schema overpaid visit offset another visit's pending balance in dashboard SQL: ₹20.15 versus the sum of row pending balances ₹70.15 | New migration 013 sums each row's clamped receivable. Exact summary/per-visit total ₹70.15, unchanged original finance rows, preserved store/owner scope and service-only grants |
| P5-003 | Medium | Pages metadata referenced absent Django favicon/manifest assets; production smoke returned 404. Root-scoped worker also referenced an absent compatibility icon | Pages metadata uses configured base, relative manifest/icon is included, and root worker icon exists. Actual local builds at `/CRM/`, `/review-crm/`, `/` pass assets/metadata/worker scope. Django build and all 9 emitted asset references pass |
| P5-004 | Medium | Custom Pages prefix registered `/service-worker.js` instead of its own worker scope | Worker helper preserves configured prefix while retaining Django's root worker. Failing helper regression, real browser worker registration and click-path tests pass for all three bases |

Only prepared Phase 2 migration 002 required a documented preservation correction; the six Phase 3 files 004–009 remain intact. Migration 013 is additive SQL definition replacement, with no historical financial-row rewrite. Do not rerun 002 on an already applied ledger entry. If an earlier migration changed timestamps elsewhere, they cannot be reconstructed by guessing or by 013; use verified historical backup evidence and a separately reviewed repair.

### Migration, data preservation and recovery

Native PostgreSQL 16.12 rehearsal: **12 PASSED / 0 FAILED / 1 BLOCKED**. Inventory: 39 files, unique chronological IDs; fresh replay executes 23 original business migrations plus all 13 prepared migrations. Actual pg_cron/pg_net/Vault prerequisites are absent, so three hosted scheduler/HTTP/Vault migrations remain BLOCKED; no substitute infrastructure was installed.

A populated synthetic pre-upgrade schema has 30 original tables, historical dates/customer JSON/change history, multiple store roles/credentials, financial anomalies, attendance/timesheets/tasks/targets and image metadata. Exact fingerprints remain unchanged for 27 tables outside explicitly tested security backfills. Stale legacy credentials revoke, untouched legacy credentials remain, original store ownership is recovered only when unambiguous and CRM buckets become private. This is representative synthetic compatibility evidence, not a real production-schema/data copy or a migration lock-duration benchmark.

Pre- and post-upgrade custom pg_dump archives restored into new databases exactly. Post-restore data/catalog checks cover 32 tables, 151 constraints, 89 indexes, 10 policies, 435 grants, 122 functions, 24 triggers and 16 sequences. Final pre-backup 167,617 bytes/808.567 ms; post-backup 251,712 bytes/480.672 ms; post-restore 3,354.067 ms. These tiny local archives do not prove provider RPO/RTO. Injected 005 schema drift rolls back renamed functions/grants, injected 002 backfill failure restores its timestamp trigger/data, and duplicate 001 replay is rejected atomically. The read-only preflight leaves data/catalog unchanged.

Scripts/evidence: `scripts/phase5-migration-rehearsal.py`, `scripts/phase5-migration-preflight.sql`, `tmp/phase5/migration-baseline.json`, `migration-results.json` and corresponding run archives. Actual Supabase catalog permissions, custom schema drift/ledger, full infrastructure replay, Auth identities/sessions, Storage bytes, secrets and provider PITR/restore remain BLOCKED. No destructive down-migration is proposed; the release report defines compatible application fallback/forward correction and separately approved verified restore.

### Independent regression and complete workflow boundary

| Executed check | Phase 5 result |
|---|---|
| Full frontend/handler/SQL-backed Node suite | **234 passed**, zero failed/skipped; 9.35 s |
| Embedded PostgreSQL business suites, combined schema through 013 | **82 passed**, zero failed/skipped; 52.33 s |
| Full legacy Django isolated SQLite | **152 passed**,230.31 s; test database destroyed |
| Existing actual React Chromium workflows | **35 passed**,1.8 min; developer-server transport fixtures |
| Minified production artifact/browser checks | **4 passed**,14.8 s; three base paths, workers/assets and production render measurements |
| Independent focused security/reset rerun | **26 passed**, overlapping broader suites; not an additional overall test total |
| Actual native concurrent business sessions through 013 | **15 scenarios /56 independent operations passed** |
| Native migration/recovery | **12 passed, 0 failed, 1 blocked** |
| Installed dependency/lock validation and current npm advisory check | Installed tree valid; 0 reported npm findings; no packages changed by the check |
| Pages/Django builds and whitespace validation | Passed; actual remote CI/deployment NOT TESTED |

The rerun covers import→customer→callback→visit→financial/dashboard SQL consistency, task evidence/review/durable alerts, timesheet rework/approval, verified-punch OT and scoped administrator/store paths. Original failure/rollback/unauthorized cases still pass, including prior password-reset/store-history vulnerabilities. Native concurrency is repeated with all 13 prepared migrations, recording independent backend PIDs, decision counts and exact money/history assertions in `tmp/phase5/concurrency-results.json`. The owned loopback PostgreSQL cluster was stopped after the checks; synthetic artifacts remain for review.

These local layers are not a complete deployed business workflow. Every required hosted journey—including Store→Auth user provisioning, true account-to-account review/notification and actual device→attendance→OT—remains BLOCKED. The independent review did not mark provider/session revocation, real email/OTP/push, Storage HTTP/URL expiration, realtime or physical Android/iOS/eSSL verification passed. No message was sent to real employees. A sandbox-stalled Django attempt was interrupted, then the authorized isolated run passed; incomplete attempts were not counted.

### Production build performance and remaining capacity limits

Final local minified/gzip build with instant explicit fixtures (driver action→ready, not hosted latency): cold dashboard 559 ms/FCP 132 ms; 50-customer page 183 ms/21,673 JSON bytes; search 161 ms/846 bytes; 100-dataset list 108 ms/9,497 bytes; 5-visit page 122 ms/1,942 bytes; aggregate report 96 ms/441 bytes; 4,000 actual synthetic punches across 100 employees 734 ms/2,906,894 bytes over 27 requests; warm dashboard 90 ms/no API. Customer/sales 25k totals are declared fixture counts, not local hosted database queries. Evidence thumbnails 117 ms/15,410 image bytes; full 1280×960 synthetic JPEG 109 ms/24,733 image bytes. Cold resource timing encoded 424,710 bytes/transferred 429,510 bytes; zero final failed requests/static failures/uncaught errors.

Before/after Pages asset/worker failures are reproduced and retested; no comparable production-browser latency baseline was invented. Direct deep links intentionally retain Pages'404 fallback status while the app route works. The earlier native 25k query plans and local concurrency results remain separate evidence. Complete attendance catch-up, task/OT/reminder/target histories, arbitrary-field counts/search, deep offset pages and export/image/device capacity remain limits. No safe production user count, p95/p99 SLO, throughput, connection budget or recovery objective is approved.

Evidence: `tmp/phase5/frontend-performance-summary.json`, `frontend-production-performance.json`, `frontend-artifact-smoke.json`, `frontend-build-artifacts.json`, browser JSON reports and Django asset checks. Source QA now includes the new helper/production-artifact checks and Phase 5 artifact collection; no remote workflow was triggered. Broad screen-reader/other-browser validation, Python advisory inventory and operational/on-call drills are NOT TESTED.

### Final independent sign-off

**PASSED:** the executed local assertions above, all four new confirmed fixes, representative migration/data-preservation and logical SQL restore checks.

**FAILED:** no assertion remains failing in the final executed checks. Earlier reproduced defects and failed/sandbox attempts remain documented, not hidden or counted as passes.

**BLOCKED:** dedicated hosted project and deployed ledger/schema comparison; actual Auth/Edge/PostgREST/Storage/realtime; full scheduler/Vault chain; controlled provider delivery/logs; physical devices; sustained staging load and provider backup/PITR/object/Auth recovery.

**NOT TESTED:** actual CI/environment protection/deployment rehearsal; broader physical/browser/screen-reader coverage and operational recovery objectives/drills beyond local logical restore.

Final recommendation: **CONDITIONALLY READY**. Retain the release hold until required integration/device/capacity/recovery gates and a reproducible release commit/artifact are approved. The complete deployment/rollback plan and outstanding owners/prerequisites are in [PRODUCTION_RELEASE_REPORT.md](PRODUCTION_RELEASE_REPORT.md); the [hosted checklist](HOSTED_VERIFICATION_CHECKLIST.md) now includes migration 013 and the preservation preflight. Production readiness and certification are not declared.

## Store creation and feature access follow-up — 7 November 2026

The local root application now exposes the five-field store creation popup and per-store module switches, including Dashboard. Store name/email/phone are required; contact person/address are optional. Super Admin can edit access from Stores & access → Manage access. Route and sidebar gates use the stored flags; a disabled Dashboard routes to another enabled section or an empty store workspace. Reports have a separate summary endpoint so disabling Dashboard does not break allowed Reports.

Prepared migrations `202611070100_store_contact_details.sql` and `202611070101_store_features.sql` preserve original store and business rows. Feature flags default to all enabled. Attendance RLS and a timesheet write trigger enforce disabled-store restrictions. The attendance aggregate preserves selected-store scoping and historical records belonging to inactive employees. Reminder claiming pauses reminders for disabled stores. These migrations were applied only to an isolated in-memory PostgreSQL engine during this follow-up.

Results: **66 API regression tests passed**; **31 cache, navigation, store isolation and Attendance tests passed**; the new real-SQL store feature integration test passed, including RLS, RPC/write denial, malformed flags, inactive employee history and exact preservation of timesheet/credential rows. Eight Chromium scenarios passed against explicit loopback transport fixtures. Production frontend build passed. Existing API fixtures were updated to include the required store feature column and store lookup; their original business assertions remain.

The actual signed-in local `5173` tab was inspected and its popup verified without creating or modifying a hosted record. An old API's missing feature capability blocks new store submissions rather than silently discarding contact/access settings. Hosted persistence, physical device behavior and hosted multi-session propagation remain unverified. Status: **CONDITIONAL READY**. No production migrations or deployments were performed; the earlier restriction against production schema changes remains in effect.

## Authorized store deployment — 7 November 2026

The user explicitly approved deploying the store creation/access update while requiring existing Attendance and CRM behavior to remain intact. This supersedes the earlier production-migration restriction for this scoped release. Published frontend/API source is commit `7cb203f4fe123dbe7cf12116cdde818be2666998`; GitHub Pages run `42363626944` completed successfully. Live assets at `https://vestano.online` include the five-field store modal and feature access controls. Other Phase 1–5 workspace changes and migrations were excluded.

Applied migrations 100 (store contacts), 101 (store features) and 102 (unmapped Attendance visibility). The release was checked against the downloaded live API and actual production schema, retaining the existing Attendance totals interface and shared modules. Existing stores retain all eight enabled features. A first policy check hid 23 unmapped biometric punches from Super Admin; no rows changed. The tested forward correction 102 restored the original visibility before the API/frontend release was completed.

Final preservation check: every original row hash matched for 7,325 Attendance records, 30 timesheets, 37 profiles, 37 credential records, 3 stores, 96 customers, 10 datasets, 6 tasks and 10 sales visits. All six baseline role/store contexts retained the same Attendance totals and permissions. Two new punches from existing registered devices arrived normally; their addition accounts for Attendance counts increasing to 7,327. One new store was successfully created during live use with nonempty name/email/phone and its selected feature flags persisted. No test store was created by the deployment checks.

Verification: 30 isolated release API tests, 39 existing Attendance/reminder tests, eight Chromium store UI scenarios and two SQL compatibility tests passed. Hosted temporary sessions for Super Admin, Admin and Employee passed feature lookup, dashboard, sales summaries, callbacks, tasks, overtime and Attendance totals. Admin/Employee store creation was denied and invalid Super Admin creation was rejected before writes. Verification sessions were revoked individually; no emails were sent and passwords/login IDs were unchanged. Hosted checks uncovered and fixed an existing overtime HTTP 500 by passing the missing request context into serialization; calculations, shift/grace rules and stored approvals were retained.

Evidence is retained under `tmp/store-release-20261107/`: live source/schema backup, migration results, before/after row fingerprints, role checks, hosted smoke, website asset verification and artifact hashes. Current feature deployment is live; overall status remains **CONDITIONAL READY** for exhaustive physical-device, delivery and full hosted workflow certification.

## Store account creation and isolation verification — 7 November 2026

Verified the published account flow: Stores & access → store card → Add Admin, or Manage users → Add User. The form captures a unique username/email, role, password/confirmation and active status; the selected store ID accompanies the create request. Store accounts use the normal CRM login. Three isolated real-handler checks passed: Super Admin-created Admin/User accounts retain the chosen store and password; a store Admin's forged foreign store ID is ignored and Super Admin creation is denied; ordinary Users cannot create accounts and global Super Admin must choose a store for store roles.

Additional hosted checks with existing Admin and User roles passed: a foreign selected-store header did not alter effective features, direct foreign profile reads were hidden by database RLS, foreign user management was denied, and store feature edits were rejected. Temporary verification sessions were individually revoked. No new accounts, passwords, store assignments or business records were created or changed by these checks. Evidence: `tmp/store-release-20261107/account-store-isolation.json` and `tmp/verify-store-account-creation.mjs`.

