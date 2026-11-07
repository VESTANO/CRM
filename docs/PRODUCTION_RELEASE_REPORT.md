# VESTANO CRM — production release report

Date: 7 November 2026, Asia/Kolkata. Decision: **CONDITIONALLY READY — local candidate only; production deployment on hold.**

This report reviews Phases 1–5 without treating local tests as hosted verification. No staging Supabase project is available, as previously confirmed by the user. No production database, provider account, employee device, production infrastructure or deployment was changed. Synthetic local tests are identified explicitly. No security certification or production operating capacity is asserted.

## Candidate and evidence boundary

The review includes all 112 reachable Git commits, dated 1 October–6 November 2026, including the merge and reverted native-notifier work. Current HEAD is `62a251cbad5ce1ce8ae01e3c19689224b6d72fbe` on `main`. Phases 1–5 are uncommitted working-tree changes; HEAD alone does not identify the tested candidate. A clean release commit/tag and artifact identity remain release prerequisites. Nothing was committed, pushed or deployed by this validation.

`scripts/phase5-release-manifest.py` inventories every reachable commit's changed paths and SHA-256 hashes for allowlisted candidate source, configuration, test and migration files. It excludes dotenv files, credentials, database/backup content, node_modules and generated application data. The final manifest is `tmp/phase5/release-manifest.json`; regenerate it after any change. A source hash does not establish the state of a deployed project.

Evidence layers:

- **Local SQL/handlers:** actual PostgreSQL functions, triggers, RLS, grants and transactions, through native PostgreSQL or PGlite; Auth/Storage-owned catalogs are disposable local prerequisites.
- **Browser:** actual React/router/providers and production JavaScript, with explicit loopback-only transport fixtures. These verify client behavior and asset/render cost, not live database state or provider performance.
- **Hosted/provider/physical:** unavailable and marked BLOCKED. No local result is substituted for these requirements.
- **Historical results:** labeled by phase and retained in [ENGINEERING_QA_AUDIT.md](ENGINEERING_QA_AUDIT.md); counts from different phases overlap and must not be added together.

## Phase summary

| Phase | Implemented and reviewed | Verification boundary |
|---|---|---|
| 1 | Mobile scroll lifecycle, confirmations/rejection feedback, shared dialogs and reduced unnecessary polling | Source/build/Node and focused Django; early browser automation was blocked |
| 2 | Atomic staged XLSX imports, preserved source fields, SQL customer/dashboard/callback/count paths and local browser/CI harness | 25k synthetic import/query measurements, local RLS and emulated Chromium; full Django 152-pass result was historical until rerun in Phase 5 |
| 3 | Customer/history, financial/client/image metadata, task/timesheet/OT decisions, reset cooldown and administrator rollback integrity | Real local SQL/handler business paths and fixtures; remote cross-service delivery/rollback remained unverified |
| 4 | Legacy credential revocation, immutable store binding, revisioned customer/visit edits, restrictive Storage policy, bounded histories, report grouping and cache/session/resource fixes | Native 15-scenario/56-operation concurrency; 25k-module query plans; Chromium resource/navigation measurements |
| 5 | Independent regression, existing-record migration rehearsal, backup/recovery rehearsal, production asset/base checks and release evidence/rollback planning | New compatibility corrections and final results recorded below; hosted and physical gates remain open |

## Issue register and independent QA disposition

“PASSED locally” means the reproduced failure is resolved in the tested candidate at the stated layer. It does not mean the hosted equivalent passed. No Critical issue has been confirmed by this local review; all confirmed High issues must retain their protections during rollout/rollback.

| IDs | Final severity | Disposition and related regression |
|---|---|---|
| AUD-001 | High | PASSED locally: drawer/dialog navigation and scroll restoration; duplicate Bootstrap controller cause removed |
| AUD-002 / AUD-003 / AUD-004 | High | PASSED locally: task/OT/timesheet confirmations, required rejection feedback, preserved drafts and duplicate/stale decision rejection |
| AUD-005 | Medium | PASSED for corrected polling/hidden-tab paths; full provider/resource capacity remains conditional |
| AUD-006 | High | PASSED locally: staging/commit transaction, interrupted imports, exact retry/lost reply and retained original cells; hosted import BLOCKED |
| AUD-007 | High | PASSED for measured bounded local paths; BLOCKED for hosted capacity; full-history/export capacity limits remain open |
| AUD-008 | Medium | PASSED locally for repeatable suites/workflow configuration; actual GitHub Actions execution NOT TESTED |
| AUD-009 | Medium | BLOCKED: live Supabase, delivery and physical verification |
| P3-001 / P3-002 | High | PASSED locally: customer mutation/history atomicity, callback reschedule/completion, rollback and stale completion |
| P3-003 / P3-004 | High | PASSED locally: visit/client/image metadata atomicity and request replay; real Storage boundaries BLOCKED |
| P3-005 | Medium | PASSED locally: date/cents/range and overpayment validation, rounded per-visit pending amount; legacy aggregate correction is P5-002 |
| P3-006 / P3-007 | Medium | PASSED locally: no-target conversions, historical target warnings, grouped customer counts and six-month SQL reports |
| P3-008 | High | PASSED locally: task store/role checks, evidence/review transaction, scoped notifications and private internal functions |
| P3-009 | High | PASSED locally: locked timesheet decision, feedback, correction/resubmission and immutable reviewed audit |
| P3-010 / P3-011 | High | PASSED locally: OT identity/serialization, store employee requirement, verified punches and atomic decision/alert |
| P3-012 | Medium | PASSED locally: captured shift, India working day and separation of requested versus verified minutes |
| P3-013 | High | PASSED locally for completeness and later-page failure rejection; complete-history transfer still has capacity risk |
| P3-014 / P3-015 | High | PASSED locally: validate before Auth side effects, new-account cleanup, email/profile rollback and global role changes; cross-store demotion is now intentionally restricted by P4-002 |
| P3-016 | High | PASSED locally: exact current identity, response equality, active/ambiguous aliases and exclusive reset cooldown; delivery/timing/provider behavior BLOCKED |
| P3-017 | High | PASSED locally: delete metadata transaction before object cleanup; failed DB deletion preserves evidence; remote eventual cleanup BLOCKED |
| P4-001 | High | PASSED locally: old legacy credential cannot replace a reset password, including real concurrent DB operations; Auth trigger/provider compatibility BLOCKED |
| P4-002 | High | PASSED locally: promotion/demotion cannot move historical store access; same-store demotion/new global first assignment remain allowed |
| P4-003 | High | PASSED locally: one-time legacy authorization claimed before side effects; a failed import remains consumed for reconciliation |
| P4-004 | High | PASSED locally: captured customer/visit revision, one winning update, no stale history/financial overwrite and retained browser draft |
| P4-005 / P4-006 / P4-007 | Medium | PASSED locally: cache collisions/late publication/size, session refresh races, disposed/hidden probes and offline draft preservation |
| P4-008 | Medium | PASSED locally: bounded sales/client/history navigation, batched authors, stale response guards and aggregate report prefetch |
| P4-009 / P4-010 | Medium | PASSED locally: keyboard/labels/focus and understandable sanitized database failure recovery |
| P4-011 | Medium, deployment-dependent | PASSED in local Storage catalogs: restrictive policy overrides broad browser grants; deployed policies/HTTP behavior BLOCKED |
| P5-001 | High | PASSED locally: historical customer timestamps survive the search backfill; injected failure restores trigger/data exactly |
| P5-002 | High | PASSED locally: historical overpayment does not offset another visit's receivable; original financial rows unchanged |
| P5-003 | Medium | PASSED in local production builds: Pages metadata/assets resolve independently of Django; hosted CDN/install behavior BLOCKED |
| P5-004 | Medium | PASSED locally: worker registration follows the configured Pages prefix; actual provider/OS notification delivery BLOCKED |

The independent narrow security rerun passed 18 security and 8 password-reset cases, zero failures/skips. It specifically rechecked P4-001/002/003/011 and P3-016 and did not claim other business fixes had been tested by that narrow subtask. The broader business regressions below provide their separate evidence.

## Migration compatibility and recovery

Migration ordering, duplicate IDs, dependencies, foreign keys, indexes, constraints, grants, RLS and record preservation were reviewed against both a fresh local schema and a populated synthetic reconstruction of the existing business schema. This is not a copy of the live production schema: actual deployed migration ledger, extension versions, custom policies/triggers, Auth/Storage ownership and existing data distribution remain BLOCKED until staging exists.

The prepared migrations are one-time ledger migrations, not rerunnable maintenance scripts. Reapplying an already applied migration is expected to fail; a failed transaction must leave no partial schema/trigger changes. Never solve this by dropping existing objects or skipping a mismatched ledger without investigation.

Required preflight in staging:

1. Compare the deployed migration ledger and reviewed file hashes; inspect schema drift and privileged function owners/grants.
2. Inventory actual Auth columns/permissions and Storage ownership, pg_trgm/pgcrypto, pg_cron/pg_net/Vault and realtime publication requirements. Local substitutes do not prove provider-owned catalog compatibility.
3. Check historical store ownership, orphan foreign keys, financial anomalies, current profile/store roles and retained legacy credentials. Do not silently rewrite source/customer/financial data to make a migration pass.
4. Rehearse backfill/index locks and timing with representative scale, select a maintenance window/write fence, and verify timeouts, migration failure rollback and exact pre/post data reconciliation.
5. Confirm the matched Edge/frontend can use the new private functions and captured revision protocol before reopening writes.

Important data/security transitions: migration 010 revokes stale retained Django hashes and preserves original store bindings. Affected accounts use current credentials or recovery; unresolved historical global ownership requires explicit reconciliation. Migration 012 requires customer/visit update revisions; older writers must reload or remain fenced. A coordinated compatible release is required.

Native PostgreSQL 16.12 final rehearsal: **12 PASSED, 0 FAILED, 1 BLOCKED**. All 39 migration IDs are unique. A fresh database executes 23 original business migrations plus all 13 prepared migrations; three scheduler/HTTP/Vault migrations remain BLOCKED because actual pg_cron, pg_net and supabase_vault are unavailable. These dependencies were probed, not replaced with mocks. All prepared files have transactional boundaries. Index/constraint validation, grants/RLS, private Storage policy, store bindings, duplicate replay and failure rollback pass locally.

The representative pre-upgrade fixture contains 30 tables with old dates, original fields/history, store accounts/global roles, retained legacy credentials, attendance/timesheets/tasks/targets, image metadata and an historically permitted overpaid visit. The 27 tables outside explicit security backfills retain exact row fingerprints. Fresh legacy hashes stay; two stale hashes revoke; store bindings and private buckets change only as intended. This fixture is deliberately small for exact comparison; its migration time is not a large-production lock-duration estimate.

P5-001 baseline: migration 002 changed a customer `updated_at` from `2026-09-02T08:34:05+05:30` to migration time. Only its existing timestamp trigger is now suspended around the derived search backfill, within the same transaction, then reenabled. Injecting a backfill failure restores the trigger, historical data and catalog exactly. This is a documented correction to an unapplied Phase 2 file; Phase 3 files 004–009 remain unchanged. Original SHA-256: `2746d2b33a2876d499c582f874490220444bce7c4a101f9bffe932060ff2c42e`; corrected: `46c212672fe8487909a98581ab3bc3d8b43c66a547dcd0b43210f576434dc65b`. If an earlier version was applied elsewhere, do not rerun it or invent timestamps: only a verified backup/history can recover those values.

P5-002 baseline: the prior aggregate clamped only the sum of balances, allowing an old credit to reduce another visit's pending amount from ₹70.15 to ₹20.15. New `202611070013_historical_receivable_summary.sql` sums each visit's clamped pending value, matching existing visit displays. Total/paid values and historical rows are not rewritten. Store/owner scope and service-only execution remain enforced.

Pre/post-upgrade custom pg_dump archives were restored into new databases with exact data and eight catalog categories: tables/RLS, constraints, indexes, policies, grants, functions, triggers and sequences. The post-restore comparison includes 32 tables, 151 constraints, 89 indexes, 10 policies, 435 grants, 122 functions, 24 triggers and 16 sequences. Pre-upgrade archive: 167,617 bytes / 808.567 ms; post-upgrade: 251,712 bytes / 480.672 ms; post restore: 3,354.067 ms. These small local timings are not provider RTO/RPO evidence. Injected migration 005 drift rolls back renamed functions/grants; duplicate migration 001 fails atomically rather than drifting schema. The read-only preflight script leaves data/catalog unchanged.

Evidence: `tmp/phase5/migration-results.json`, `migration-baseline.json` and their run directories; scripts: `scripts/phase5-migration-rehearsal.py` and `scripts/phase5-migration-preflight.sql`. Provider backups/PITR, actual Auth identities, Storage object bytes, Vault secrets and operational RPO/RTO remain unverified by a local PostgreSQL dump.

## Complete business workflow evidence

| Requested workflow | Local result and reconciliation | Complete hosted end-to-end result |
|---|---|---|
| Workbook → dataset → lead → callback → sale → dashboard | PASSED: actual staged import/customer/callback/visit/report SQL; preserved original JSON/history, exact financial sums and queue counts; browser forms/navigation separately | BLOCKED: no staging Edge/PostgREST/Auth/Storage |
| Task assignment → submission → evidence → decision → notification | PASSED locally: actual transactional task/photo/submission/alert metadata, rollback injection, feedback, exact resubmission and one final decision | BLOCKED: real objects, account-to-account browser/transport and delivery |
| Attendance → daily timesheet → approval | PASSED locally: original punch calculations/date scope, SQL submission/rejection/rework/approval and browser XLSX read-back | BLOCKED: physical records, hosted identity/realtime and final export comparison |
| OT request → punch verification → decision | PASSED locally: captured shift, missing/odd/final punches, exact verified minutes, transactional decision/alert and concurrent review | BLOCKED: physical final punch and live notification |
| Store → administrator/user assignment → scoped operations | PASSED for isolated handler/RLS/store-binding/foreign-ID cases; synthetic identity/profile creation is fixture setup | BLOCKED: actual complete Supabase store/user lifecycle and cross-account browser journey |

## Hosted, physical and delivery status

| Gate | Status | Evidence / missing prerequisite |
|---|---|---|
| Hosted Supabase Auth, sessions, reset and OTP | BLOCKED | No separate staging project or controlled provider accounts configured |
| Hosted database, policies, functions/triggers and Edge runtime | BLOCKED | No staging migration/application deployment or deployed ledger comparison |
| Storage uploads, authorization, one-hour URL expiry/cache and cleanup | BLOCKED | No real staging objects/HTTP results; local catalogs are insufficient |
| Realtime and cross-account notification transport | BLOCKED | No hosted channels/session workflow |
| Real reset/OTP/task/reminder/review delivery | BLOCKED | Provider configuration/delivery logs and controlled recipients unavailable; no messages sent |
| Android Chrome / physical iOS / keyboard-camera behavior | BLOCKED | No connected physical device or device account available; Chromium emulation is separate |
| Physical eSSL and backup/import reconciliation | BLOCKED | No actual device/punch dataset; original attendance rules preserved |
| Sustained staging load/capacity and failure injection | BLOCKED | No isolated infrastructure; no user-count/SLO/capacity claim |
| Actual CI run, protected environment and deployment rehearsal | NOT TESTED | Workflow source reviewed; no remote workflow or deployment triggered |

The public login and worker calls require verification against staging's actual API-key/gateway mode. Supabase's current [authorization-header reference](https://supabase.com/docs/guides/functions/auth-headers) describes compatibility handling, while its [key-migration guide](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys) prescribes migration configuration. No gateway flag or key was changed from a source-only assumption. This is an integration gate, not a claimed reproduced hosted failure.

## Performance and safe operating limits

Historical Phase 4 native PostgreSQL measurements used 25,000 rows per major module: history first-page query 8.971→0.030 ms; sales ordering 0.261→0.026 ms; report 133.351→14.615 ms. History logical SQL JSON fell from 17,366,683 bytes to 34,874 bytes; sales 24,197,789→4,915 bytes. These are local warm SQL/logical JSON observations, not hosted HTTP/user latency.

Phase 4 concurrent tests used 56 independent database operations across 15 scenarios, with at most eight simultaneous sessions in a tested race. This establishes transaction-specific local evidence, not a safe limit of eight users or a sustained production throughput. Whole-application navigation retained stable DOM/listener/timer/subscription/cache counts over 64 SPA transitions in development Chromium; large images/exports and devices were not covered by that resource sample.

Phase 5 production-build browser measurements use minified/gzip assets with explicit instant local synthetic responses. These are one final unthrottled run, measured from driver action to ready UI, including driver overhead. Customer/sales counts declare 25k while returning bounded pages; no hosted 25k query is executed by those fixtures. Attendance actually supplies 4,000 synthetic punch rows for 100 employees/10 days. No comparable earlier production-browser latency baseline exists; Phase 4 SQL timings are a different layer.

| Scenario | Action → ready | Requests in measured window | JSON bytes |
|---|---:|---:|---:|
| Fresh-context dashboard |559 ms |5 |1,156 |
| Customers, 50 visible / 25k declared |183 ms |1 |21,673 |
| Customer search |161 ms |1 |846 |
| 100 dataset entries, 5 visible |108 ms |1 |9,497 |
| Sales, 5 visible / 25k declared |122 ms |2 |1,942 |
| Aggregate sales report |96 ms |1 |441 |
| Attendance, 4,000 actual synthetic punches |734 ms |27 |2,906,894 |
| Evidence thumbnail gallery |117 ms |12 |12,240 |
| Full 1280×960 synthetic JPEG decode |109 ms |2 |61 |
| Warm dashboard navigation |90 ms |0 |0 |

Recorded first contentful paint was 132 ms; cold resource timing recorded 424,710 encoded bytes / 429,510 transferred bytes. Gallery image bytes were 15,410; full-image bytes 24,733. The final run had zero failed requests, static failures or uncaught JavaScript errors. Attendance's complete history plus safe catch-up is an observed transfer bottleneck requiring staging capacity work; it was not rewritten from a single local sample.

Before fixes, Pages favicon/manifest requests returned 404. After P5-003/P5-004, production builds for `/CRM/`, `/review-crm/` and `/` resolve metadata/icons/manifest and register actual browser workers under the correct scope. Worker-core click paths stay within each configured base; Django retains its root worker. Direct deep links intentionally use the workflow's index-as-404 fallback: the response status remains 404 while the React route renders correctly. The legacy Django production build and nine emitted asset references also pass. This is not CDN, real notification delivery, physical installation or DNS verification.

Evidence: `tmp/phase5/frontend-performance-summary.json`, `frontend-production-performance.json`, `frontend-artifact-smoke.json`, `frontend-build-artifacts.json`, `frontend-production-browser-results.json` and Django build/asset evidence. Before-fix artifacts are retained. Three Pages variants and a Django-compatible build were compiled; no generic performance rewrite or new dependency was introduced.

Enforced input/payload limits remain: XLSX 20 MB compressed, 50 sheets, 500 columns and 100,000 nonblank rows; customer/directory/callback/sales/history/client pages are bounded according to their API; photos max 10/stage, 256 KiB image and 20 KiB thumbnail. Parser limits are not proven physical-mobile capacity. No production concurrent-user limit, p95/p99 target, throughput, database connection budget, RTO or RPO is approved from these local observations.

Remaining bottlenecks/known limits:

- Task, OT, reminder and target full histories can still produce unbounded transport/render work. Attendance full reads and XLSX export memory require capacity gates.
- Arbitrary original-field substring searches and exact counts scan data; deep offset pages grow in cost and can shift while new rows are inserted.
- Customer/visit revisions and review/claim locks do not provide universal conflict detection for ordinary reminder/target/account edits.
- Visit idempotency retains the original form UUID; a new/reloaded form cannot automatically replay a prior lost request identity.
- Auth/Storage/DB changes span services. Cleanup/rollback can fail remotely and need operational reconciliation.
- Previously issued signed URLs remain bearer capabilities until expiry and client/cache behavior may retain content after logout/deactivation.

## Backup, deployment and rollback plan

This is a reviewable plan, not authorization to deploy or operate production.

Before approval, the release owner must record a verified provider backup/PITR restore point, retention, RPO/RTO, tested restore destination, Storage object backup and Auth recovery procedure. Inventory policies/functions/roles/publications/extension versions, Edge/configuration and static artifact hashes. Keep secrets in secure configuration, not this report or source. A SQL metadata dump alone does not back up object bytes or prove GoTrue/PITR recovery.

Deployment sequence, only after all required gates pass and approval is explicit:

1. Freeze the reviewed working tree into a reproducible release commit/tag. Build immutable frontend/Edge artifacts; attach hashes, test reports and migration preflight output.
2. Confirm staging results and business/security sign-off, restore rehearsal and named release/on-call owners. Verify the GitHub Pages environment's actual protections; push-to-main currently triggers its deployment workflow after CI QA succeeds. Do not push this candidate as a substitute for release authorization.
3. Apply a write fence/maintenance window where required. Capture backup/reconciliation baselines and confirm recovery access independently.
4. Apply only pending reviewed migrations in ledger order with failure/time limits. Verify preserved rows/timestamps, function grants, triggers/RLS, balances and store ownership before accepting traffic.
5. Release matched Edge/configuration and frontend using the staged compatibility sequence. Old clients/writers must be refreshed or fenced while revision-required mutations are active.
6. Run role/store smoke workflows and SQL reconciliation, observe errors/locks/queues/provider delivery, then reopen traffic gradually. Retain artifacts, evidence and rollback decision time.

Rollback:

1. Stop/restrict new writes and capture the failing release state, logs and post-backup writes; do not blindly retry destructive actions or rerun an applied migration.
2. Prefer a forward correction or previously verified schema-compatible frontend/Edge artifact. Do not restore an old writer that omits required revisions or remove the fixed security/store guards.
3. If database restore is required, restore to an isolated destination first, validate rows/grants/policies/Auth/Storage references and reconcile writes after the recovery point. Switching production requires separate authorization and the rehearsed provider procedure.
4. Restore object bytes and provider configuration consistently; verify current credentials/session policy and account recovery. Do not resurrect revoked legacy passwords as an incidental rollback effect.
5. Re-run the release smoke/integrity/role checks before reopening writes. No generic destructive down-migration is supplied for security/data changes.

## Final executed validation results

| Check | Current Phase 5 result |
|---|---|
| `npm test` | **PASSED: 234**, zero failed/skipped; 9.35 seconds |
| `npm run test:db` | **PASSED: 82**, zero failed/skipped; 52.33 seconds; combined schema includes migration 013 |
| Full Django SQLite suite | **PASSED: 152**, 230.31 seconds; disposable test database destroyed; reminder output belongs to synthetic tests, not actual provider delivery |
| Existing Chromium application suite | **PASSED: 35**, 1.8 minutes; developer-server UI/fixtures |
| Phase 5 minified production browser/artifact checks | **PASSED: 4**, 14.8 seconds; Pages scopes/assets/worker registration and render/transfer measurements |
| Independent focused security/reset rerun | **PASSED: 26**, overlapping the broader suites; not added to an overall test total |
| Native migration/recovery rehearsal | **12 PASSED / 0 FAILED / 1 BLOCKED**; missing actual scheduler/HTTP/Vault dependencies |
| Native concurrent business scenarios with migration 013 | **PASSED: 15 scenarios / 56 independent operations**; separate PostgreSQL backend PIDs and exact financial/history/notification assertions |
| Current npm advisory audit | **PASSED: 0 reported findings**, current installed/lockfile public registry check; no packages installed or changed by the check |
| Pages/Django builds and whitespace check | **PASSED**; no remote CI or deployment run |

The source QA workflow now includes the two Phase 5 helper regressions and the production-artifact build/browser commands, and collects Phase 5 artifacts. Actual remote CI execution remains NOT TESTED. The initially stalled sandboxed Django attempt was interrupted; the isolated SQLite run completed with authorized process access. No abandoned test attempt is counted as a pass.

Broad screen-reader/other-browser certification, exhaustive Python dependency advisories, and operational alerting/on-call drills are NOT TESTED. Hosted, provider, physical and sustained-load checks remain BLOCKED as listed above. Local native cluster startup was loopback-only and the owned cluster was stopped gracefully after the final concurrency run; synthetic backups/data and evidence were retained under tmp.

Reproduction commands from the repository root, using the documented local-only prerequisites:

```text
npm --prefix frontend test
npm --prefix frontend run test:db
npm --prefix frontend run test:e2e
node scripts/phase5-frontend-build.mjs
node frontend/node_modules/playwright/cli.js test --config scripts/phase5-frontend-playwright.config.mjs
python scripts/phase5-release-manifest.py
python scripts/phase5-migration-rehearsal.py
python scripts/phase4-concurrency.py
```

The Python native SQL scripts require the separately initialized disposable QA cluster/user on 127.0.0.1:55483; it is currently stopped. They create new QA databases and never use application credentials. Django uses `DB_ENGINE=sqlite` with `python manage.py test customers --verbosity 1`. Do not point local scripts or these instructions at a production project. Temporary artifacts are reproducible evidence, not a replacement for retaining approved release records/backups.

## Final gates and recommendation

Final engineering recommendation: **CONDITIONALLY READY**. Executed local checks pass and the four new confirmed defects are fixed in the candidate. Production approval remains withheld until hosted migration/integration, delivery, physical-device requirements, sustained capacity, provider backup/recovery and release artifact/owner gates are satisfied. Blocked tests are not passed tests. No production deployment is authorized by this report.

Use [HOSTED_VERIFICATION_CHECKLIST.md](HOSTED_VERIFICATION_CHECKLIST.md) for the required staging/provider/device work and [ENGINEERING_QA_AUDIT.md](ENGINEERING_QA_AUDIT.md) for detailed reproductions and historical measurements. Any subsequent code/schema/configuration change invalidates the relevant evidence and requires a new candidate manifest and focused retest.
