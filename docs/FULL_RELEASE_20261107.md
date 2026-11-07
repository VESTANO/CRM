# Full engineering release — 7 November 2026

Status: **CONDITIONAL READY**. This record accompanies the user's explicitly authorized deployment of all pending Phase 1–5 work and the published store/mobile corrections. Physical-device, notification-provider and sustained hosted-load verification remain incomplete.

## Scope and compatibility

The release integrates the complete engineering candidate with published main, preserving the five-field store popup, eight store feature switches, store-scoped Admin Panel, single active navigation item, click/touch password visibility, silent attendance updates, timesheet review popup and separate Admin feedback column.

Eighteen pending migrations were applied: `202611060006`, `202611060007`, `202611070001` through `202611070013`, and `202611070103` through `202611070105`. Already deployed migrations `202611070100`–`202611070102` were not replayed. The first sixteen ran in one transaction with lock/statement limits; the two login compatibility migrations ran after focused verification. The matching `crm-api` and `password-reset` functions were deployed with their existing JWT settings. No device-ingestion, reminder-dispatch, reminder-receipt or admin-users function source changed in this release.

Release compatibility fixes:

- Preserve existing Auth passwords and retained Django credentials. Sign-in/metadata timestamps do not establish that a password changed; the proposed retrospective revocation was removed. Actual future password changes revoke the retained legacy hash atomically. Historical reset provenance without an original password fingerprint remains unproven.
- Resolve native store accounts through the existing login endpoint as well as legacy imports, preserving old browser compatibility, active-account checks, literal identity matching, ambiguity rejection and uniform authentication failures.
- Prefer a current account email over historical import aliases, retaining username precedence and rejecting equally ranked ambiguous identities. A hosted read-only sweep reproduced one real reused-email collision; all 26 active native accounts now resolve by both username and email. No account field or password was changed.
- Permit the ordinary password fallback after a rejected legacy probe. A credential-probe 401 no longer signs out the browser or invalidates AuthProvider's pending successful login.
- Preserve the published no-argument attendance totals RPC, while adding the selected-store interface and enforcing disabled attendance access.
- Preserve historical business edit timestamps during derived store ownership backfill.
- Update existing browser/SQL transport fixtures for the published Review popup, report summary route and store-feature gates. Correct mobile test discovery in an isolated checkout under a `tmp` parent directory.

## Executed evidence

| Check | Result |
|---|---|
| Unit/handler tests | 246 passed |
| Final broad isolated database suite | 84 passed, including the final email-alias correction |
| Focused ownership/totals compatibility | 8 passed, overlapping the broad suite |
| Focused security/native-login SQL and actual handlers | 19 passed, overlapping the broad suite |
| Desktop/critical browser cases | 46 passed across the full run and corrected-fixture reruns; one additional real-form native-login fallback test passed |
| Mobile browser cases | 94 passed across the full run and corrected-popup rerun |
| Django, isolated SQLite | 152 passed; disposable database destroyed |
| Production build | Passed |
| Minified production bundles and browser checks | 4 passed for `/CRM/`, `/review-crm/` and `/`, including bounded rendering/navigation measurements |
| PostgreSQL 17 schema rehearsal | Hosted schema-only restore succeeded; the exact first sixteen migrations passed together, followed by migrations 104 and 105; no production Auth/business rows restored into QA |
| Backup | PostgreSQL 17 custom archive, 841,676 bytes, 642 catalog entries; all archive entries decoded successfully; Auth, Storage, public and migration schemas included |
| Hosted roles | Super Admin, Admin and Employee reads passed; old/selected-store attendance totals agree with baseline; customer and financial summaries agree with SQL |
| Hosted permissions | Disabled store modules and employee administrative access denied |

Backup SHA-256: `e8ea451030e5bb1e432d4599eee4eb9df2bd3f29064dd03b6b829e49583d2d33`. Backup files and credentials are excluded from Git. The archive covers database metadata/data, not Storage object bytes or provider-managed point-in-time recovery certification.

## Data preservation

The immediate post-migration comparison found **zero missing or changed existing rows** across all 26 existing public tables and the stable Auth credential fingerprints. Only newly added derived columns (`store_id` on business records, profile store binding, customer search name and revision counters) were excluded from comparison.

The preserved baseline contains 37 accounts/profiles, four stores, 7,331 attendance punches, 31 timesheet entries, 96 customers, ten datasets, ten sales visits and six assigned tasks. All existing role totals, passwords, legacy credentials, role/store assignments, uploaded work, financial fields, attachment metadata, attendance devices/mappings and store feature settings were preserved. This is a point-in-time comparison; ordinary new live activity can add records afterwards.

Later monitoring recorded a new physical-device feed punch, bringing the count to 7,332 with all original punches unchanged. A column-level comparison with the backup identified only normal `attendance_last_sync`, device `last_seen`, and six reminders' delivery-attempt/retry timestamps/counters. Reminder content, schedules, accounts, work and financial values were unchanged. The deployed `iclock` remains version 5 with its original bundle hash; other unchanged function versions are reminder-dispatch 8, reminder-receipt 3 and admin-users 4. Changed functions are crm-api 49 and password-reset 4.

No destructive production workflow tests, test account creation, password resets, device configuration changes or attendance rule changes were used for verification. Temporary existing-account verification sessions were individually revoked without signing out users' other sessions.

## Publication and remaining boundaries

Frontend release `2e9a741fc137946c155e6bbc5c997123771356e9` is published at **https://vestano.online**. [GitHub Pages run 42368382879](https://github.com/VESTANO/CRM/actions/runs/42368382879) passed every QA, build and deployment job, including unit, SQL, Django, mobile, desktop and minified-bundle checks.

The live entry, Attendance, AdminStores, Login and Reports bundles match the reviewed production build byte for byte. Notification worker, worker core, manifest and icon match the canonical committed public assets (Windows worktree CRLF differences were excluded by comparing Git blobs). Actual published login checks passed at 320, 360, 375, 390, 414, 430, 768 and 1440 px: no horizontal overflow, body scrolling available, password visibility persists after click, and no uncaught JavaScript errors. No live credentials were submitted in those browser checks.

The database-only follow-up containing migration 105, its regression and this final report does not alter the published frontend/API bundles. Its final isolated database suite passed all 84 cases; its focused security suite passed 19 cases; native PostgreSQL replay and the hosted sweep of all 26 active native account identities passed. The already published frontend is retained; an identical frontend rebuild is unnecessary for that follow-up.

Evidence remains in the local ignored `tmp/full-release-evidence` and isolated release `tmp` folders: migration manifests/ledger responses, native rehearsal, baseline and final row fingerprints, function versions, hosted role/financial checks and browser traces. Existing phase reports retain their historical local-only statements; this addendum supersedes those statements only for the release operations explicitly listed here.

Real iOS/Android keyboard, Safari gestures, actual browser/OS notification delivery, email delivery, a fresh physical biometric punch across every device, provider disaster recovery and sustained concurrent hosted load remain **not fully verified**. Passing isolated tests does not certify every production business workflow. Retain **CONDITIONAL READY**.
