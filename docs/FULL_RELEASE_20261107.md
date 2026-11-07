# Full engineering release — 7 November 2026

Status: **CONDITIONAL READY**. This record accompanies the user's explicitly authorized deployment of all pending Phase 1–5 work and the published store/mobile corrections. Physical-device, notification-provider and sustained hosted-load verification remain incomplete.

## Scope and compatibility

The release integrates the complete engineering candidate with published main, preserving the five-field store popup, eight store feature switches, store-scoped Admin Panel, single active navigation item, click/touch password visibility, silent attendance updates, timesheet review popup and separate Admin feedback column.

Seventeen pending migrations were applied: `202611060006`, `202611060007`, `202611070001` through `202611070013`, `202611070103`, and `202611070104`. Already deployed migrations `202611070100`–`202611070102` were not replayed. The first sixteen ran in one transaction with lock/statement limits; the final login compatibility migration ran after focused verification. The matching `crm-api` and `password-reset` functions were deployed with their existing JWT settings. No device-ingestion, reminder-dispatch, reminder-receipt or admin-users function source changed in this release.

Release compatibility fixes:

- Preserve existing Auth passwords and retained Django credentials. Sign-in/metadata timestamps do not establish that a password changed; the proposed retrospective revocation was removed. Actual future password changes revoke the retained legacy hash atomically. Historical reset provenance without an original password fingerprint remains unproven.
- Resolve native store accounts through the existing login endpoint as well as legacy imports, preserving old browser compatibility, active-account checks, literal identity matching, ambiguity rejection and uniform authentication failures.
- Permit the ordinary password fallback after a rejected legacy probe. A credential-probe 401 no longer signs out the browser or invalidates AuthProvider's pending successful login.
- Preserve the published no-argument attendance totals RPC, while adding the selected-store interface and enforcing disabled attendance access.
- Preserve historical business edit timestamps during derived store ownership backfill.
- Update existing browser/SQL transport fixtures for the published Review popup, report summary route and store-feature gates. Correct mobile test discovery in an isolated checkout under a `tmp` parent directory.

## Executed evidence

| Check | Result |
|---|---|
| Unit/handler tests | 246 passed |
| Broad isolated database suite | 82 passed before the additional compatibility cases |
| Focused ownership/totals compatibility | 8 passed, overlapping the broad suite |
| Focused security/native-login SQL and actual handlers | 19 passed, overlapping the broad suite |
| Desktop/critical browser cases | 46 passed across the full run and corrected-fixture reruns; one additional real-form native-login fallback test passed |
| Mobile browser cases | 94 passed across the full run and corrected-popup rerun |
| Django, isolated SQLite | 152 passed; disposable database destroyed |
| Production build | Passed |
| Minified production bundles and browser checks | 4 passed for `/CRM/`, `/review-crm/` and `/`, including bounded rendering/navigation measurements |
| PostgreSQL 17 schema rehearsal | Hosted schema-only restore succeeded; the exact first sixteen migrations passed together, followed by migration 104; no production Auth/business rows restored into QA |
| Backup | PostgreSQL 17 custom archive, 841,676 bytes, 642 catalog entries; all archive entries decoded successfully; Auth, Storage, public and migration schemas included |
| Hosted roles | Super Admin, Admin and Employee reads passed; old/selected-store attendance totals agree with baseline; customer and financial summaries agree with SQL |
| Hosted permissions | Disabled store modules and employee administrative access denied |

Backup SHA-256: `e8ea451030e5bb1e432d4599eee4eb9df2bd3f29064dd03b6b829e49583d2d33`. Backup files and credentials are excluded from Git. The archive covers database metadata/data, not Storage object bytes or provider-managed point-in-time recovery certification.

## Data preservation

The immediate post-migration comparison found **zero missing or changed existing rows** across all 26 existing public tables and the stable Auth credential fingerprints. Only newly added derived columns (`store_id` on business records, profile store binding, customer search name and revision counters) were excluded from comparison.

The preserved baseline contains 37 accounts/profiles, four stores, 7,331 attendance punches, 31 timesheet entries, 96 customers, ten datasets, ten sales visits and six assigned tasks. All existing role totals, passwords, legacy credentials, role/store assignments, uploaded work, financial fields, attachment metadata, attendance devices/mappings and store feature settings were preserved. This is a point-in-time comparison; ordinary new live activity can add records afterwards.

No destructive production workflow tests, test account creation, password resets, device configuration changes or attendance rule changes were used for verification. Temporary existing-account verification sessions were individually revoked without signing out users' other sessions.

## Publication and remaining boundaries

Frontend publication is gated by the repository's GitHub Pages workflow, including unit, SQL, Django, mobile, desktop and minified-bundle checks. The Actions run for the commit containing this report and the operator's final live artifact checks establish publication status; this report records the pre-publication evidence.

Evidence remains in the local ignored `tmp/full-release-evidence` and isolated release `tmp` folders: migration manifests/ledger responses, native rehearsal, baseline and final row fingerprints, function versions, hosted role/financial checks and browser traces. Existing phase reports retain their historical local-only statements; this addendum supersedes those statements only for the release operations explicitly listed here.

Real iOS/Android keyboard, Safari gestures, actual browser/OS notification delivery, email delivery, a fresh physical biometric punch across every device, provider disaster recovery and sustained concurrent hosted load remain **not fully verified**. Passing isolated tests does not certify every production business workflow. Retain **CONDITIONAL READY**.
