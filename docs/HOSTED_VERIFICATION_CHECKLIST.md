# VESTANO CRM — hosted verification gate after Phase 5

Status: **CONDITIONAL READY**. No non-production Supabase project was available on 7 November 2026. This is an execution checklist, not evidence that these checks passed. Use a dedicated disposable project with synthetic accounts/data; do not use production data or deploy the prepared migrations to production as part of QA.

## Prepare the reviewable staging environment

- [ ] Record project reference, region, PostgreSQL/Auth/Storage versions, configured JWT lifetime, connection limits and test account roles. Configure credentials securely outside source/logs.
- [ ] Name release/recovery owners and approve operational RPO/RTO. Restore an actual provider backup/PITR point into an isolated project, reconcile Auth/Storage objects/configuration and test the compatible application rollback sequence. Local SQL archives do not establish this provider recovery gate.
- [ ] Review the complete hosted migration chain, including scheduler/HTTP/Vault migrations excluded from the local replay. Apply it only to the authorized staging project; capture errors, grants, policies and schema cache refresh.
- [ ] Apply the matched frontend, CRM Edge and password-reset source with migrations `202611070001`–`202611070013`. Preserve Phase 3 migrations `004`–`009`. Review the Phase 5 correction to prepared migration002: its search backfill must preserve historical updated_at. Never rerun it against an already applied ledger entry. Verify old browser clients receive explicit reload errors rather than silently overwriting records.
- [ ] Run the read-only `scripts/phase5-migration-preflight.sql` against an authorized staging/backup restore, investigate drift and compare the final migration hashes. Verify historical overpayments cannot offset another visit's pending balance after migration013; original financial rows must stay unchanged.
- [ ] Review migration010 account impact before applying: stale retained Django hashes are revoked; original store bindings survive promotion; globals with unresolved historical ownership require reconciliation. Confirm real Auth permits the password trigger and removes the service-only upgrade marker before tokens/storage.
- [ ] Use at least Store A/B administrators, employees, an inactive user, a new global Super Admin, a promoted account and a global account with unresolved history. Record cleanup IDs; retain evidence without passwords/tokens or private data.

## Auth and independent authorization

- [ ] Exercise password/employee-ID login, legacy upgrade, recovery link, administrator reset, email/OTP flow where configured, expired access token and refresh token rotation in actual GoTrue/Edge.
- [ ] Race legacy upgrade against password reset in both orders. The reset password must remain authoritative and the old credential must never return. Inspect only sanitized trigger/provider results.
- [ ] Reuse an already issued token after deactivation and role changes. Check Edge, direct PostgREST, attendance RPCs, realtime, Storage and other open tabs. Confirm global-device signout/refresh revocation according to the intended session policy.
- [ ] Check account-dependent reset response equality, response timing, cooldown, abuse controls and real mail delivery. Test provider failures without revealing account existence.
- [ ] Attempt direct table/RPC requests as anon, employee, Store Admin and selected-store Super Admin. Verify customers, datasets/columns, customer history/callbacks, visits/images/expenses, targets, tasks/evidence/submissions/alerts, reminders/deliveries, attendance/mappings/timesheets/OT, profiles and reports.
- [ ] Repeat with foreign IDs, modified headers/body/query parameters and deleted/deactivated users. Confirm private/internal functions cannot be invoked, including by exposed browser roles; enumerate deployed grants to detect drift.
- [ ] Promote a store-bound account, attempt another-store demotion and direct binding modification; both must fail before Auth side effects. Same-store demotion and a new global account's first store assignment must succeed.

## Storage and cross-service recovery

- [ ] Verify both CRM buckets are private, direct anon/authenticated access is denied even with any preexisting broad policies, and authorized Edge operations retain access. Confirm ownership and RLS on the actual Supabase-owned storage catalog.
- [ ] Upload real JPEG/PNG/WebP and task/visit evidence. Reject mismatched MIME/signature, SVG/script, invalid dimensions, >256 KiB compressed image, >20 KiB thumbnail, mismatched thumbnail and >10 images. Verify other buckets are unaffected.
- [ ] Test authorized/foreign-store signed URL issuance, one-hour expiration, deactivation/logout with a previously issued URL and browser/CDN cache behavior. Decide whether the current one-hour bearer capability and long object cache lifetime meet the access-revocation policy.
- [ ] Interrupt object upload, metadata commit, record deletion and object cleanup separately. Reconcile orphan objects without removing referenced evidence. Verify operational alerts and recovery ownership.
- [ ] Interrupt Auth creation/email update and profile writes; confirm rollback/reconciliation in the real provider. A failed one-time legacy migration stays consumed: inspect partial effects and deliberately reissue authorization only after reconciliation.

## Concurrent hosted business workflows

- [ ] Use independent signed-in browsers/API connections, not one sequential connection. Repeat the 15 local PostgreSQL scenarios against the deployed API: stale customer/visit edits, callback completion, import start/commit, visit request replay, two task reviewers, OT approval, reset and migration claims, first-store assignment, reset-versus-upgrade and reminder workers.
- [ ] Inject delayed/lost replies, expired sessions, DB timeout, network loss and failed uploads. Verify no duplicate/partial records or approvals, no cross-store effects, conflict messages preserve drafts, and totals/history/notifications reconcile with SQL.
- [ ] Exercise concurrent account/target/reminder edits explicitly. These ordinary edits do not all have the customer/visit version protocol; agree and implement conflict semantics before claiming universal protection from lost updates.
- [ ] Run sustained representative traffic with multiple stores/employees and hosted pool/Edge limits. Capture p50/p95/p99, error rate, lock waits, deadlocks and resource usage; local warm query times are not hosted SLOs.

## Scale, browsers and physical devices

- [ ] Use at least 25,000 customers, callbacks, changes, visits, tasks and attendance rows. Verify exact SQL counts/totals, filtered/deep pages, new rows inserted between pages, history navigation, six-month/year-boundary reports and failure on later reads.
- [ ] Measure real PostgREST response caps, JSON/HTTP sizes, transfer and rendering time. Task/OT/reminder/target full histories and XLSX exports still require capacity limits or bounded UX; client search over arbitrary original fields and deep offset pages still scan data.
- [ ] Capture real session memory/DOM/listener/subscription counts over repeated cross-module navigation, large exports and image views. Check hidden-tab work, reconnect, cache invalidation and logout/account/store switching.
- [ ] Test keyboard and screen-reader names, focus trap/restore, visible focus, validation announcements and mobile touch controls across real supported browsers. Local Chromium emulation is insufficient for Safari/iOS/Android proof.
- [ ] Reconcile actual eSSL device punches, employee mappings, backup/import and XLSX results; test missing/odd/final punches and OT decisions. Preserve the existing pairing, grace and net-hour rules unless a business owner authorizes a change.
- [ ] Verify actual cron/net worker dispatch, push receipt/retry, denied permissions, closed-browser/OS delivery and offline return. A scheduler claim or mocked notification response is insufficient.

## Release decision

- [ ] Attach module results, SQL reconciliation, query plans, concurrent-session evidence, failed scenarios and retests to `ENGINEERING_QA_AUDIT.md` and `PRODUCTION_RELEASE_REPORT.md`.
- [ ] Resolve critical/high failures and define owners/limits for remaining risks. Keep **CONDITIONAL READY** while hosted, provider, physical-device or capacity proof remains incomplete. Obtain deployment approval separately; this checklist authorizes no production changes.
