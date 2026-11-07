# Store access and creation: local verification

Status: **CONDITIONAL READY** for physical device and complete hosted workflow verification. The user approved the store-only production deployment on 7 November 2026, explicitly requiring existing Attendance and CRM behavior to be preserved. Production schema and CRM API updates have been applied; frontend release follows through GitHub Pages.

## Scope

- Add store opens a scrollable modal for exactly five fields: store name, email and phone (required), contact person and address (optional). The same modal includes switches for Dashboard, Customers and import, Sales and targets, Attendance and timesheets, Callbacks, Reminders, Reports, and Tasks and notifications.
- Super Admin's **Stores & access** navigation opens the store list. **Manage access** opens a second modal to edit the feature switches for an existing store. Store Admins see neither control.
- Existing stores default to all modules enabled. Disabling a module preserves its data and suppresses its navigation and direct page access. The CRM API rejects direct requests to disabled modules. Attendance's direct Supabase reads and timesheet writes are covered by database policy and trigger; paused reminders cannot be claimed for delivery.
- The browser checks for changed access every 30 seconds while visible and on window focus, updating navigation without a page reload.

## Verification

| Check | Result |
| --- | --- |
| Frontend production build | Passed |
| Edge Function Node handler tests | 29 passed |
| Existing Attendance/reminder regression checks | 39 passed |
| Store feature API route guard tests | Passed |
| Browser: creation modal at 390px and 1440px | Passed with synthetic local API responses |
| Browser: disabled Sales and Attendance direct routes | Passed with synthetic local API responses |
| Browser: Super Admin edit, Store Admin restriction | Passed with synthetic local API responses |
| Browser: changed feature refreshes navigation without a page reload | Passed with synthetic local API responses |
| SQL migration compatibility | Two isolated real-SQL tests passed for the live and newer selected-store Attendance interfaces |
| Production preservation | All six role/store Attendance checks unchanged; all original data-row and credential hashes unchanged |
| Physical device and hosted multi-session permission change | Blocked until staging/production release validation |

## Deployment dependency

Applied only `202611070100_store_contact_details.sql`, `202611070101_store_features.sql` and the forward correction `202611070102_preserve_unmapped_attendance_access.sql`. Existing stores retain all eight features. The earlier prohibition on production migrations was explicitly superseded by the user's deployment approval for this feature. Other Phase 1–5 migrations remain excluded.

Production verification found that the first feature-aware Attendance policy hid 23 unmapped biometric punches from Super Admin. No records changed. Migration 102 restores the original visibility for unmapped punches while continuing to enforce module access for mapped employees. All six role/store checks then matched the pre-deployment baseline exactly. The existing no-argument Attendance totals RPC retains its original interface and totals.

Verified preserved original rows: 7,325 Attendance records, 30 timesheets, 37 profiles and credential records, 3 stores, 96 customers, 10 datasets, 6 tasks and 10 sales visits. API deployment uses the downloaded live shared Attendance/CORS modules unchanged. No passwords, login IDs, hardware integration configuration or existing feature selections were changed.

## Latest local integration

The active root application at port 5173 contains the same five-field popup and eight switches, including Dashboard. The isolated branch is a store-only release based on published frontend commit `964b0bc`; it excludes the root workspace's unrelated Phase 1–5 changes. The popup rechecks server capability when retried, retaining entered details across the server update.
