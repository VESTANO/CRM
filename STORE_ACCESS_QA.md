# Store access and creation: local verification

Status: **CONDITIONAL READY — local only**. The store contact and feature migrations and updated Edge Function have not been deployed. No production data or credentials were changed.

## Scope

- Add store opens a scrollable modal for store name, contact person, email, phone, and address. The same modal includes switches for Customers and import, Sales and targets, Attendance and timesheets, Callbacks, Reminders, Reports, and Tasks and notifications.
- Super Admin's **Stores & access** navigation opens the store list. **Manage access** opens a second modal to edit the feature switches for an existing store. Store Admins see neither control.
- Existing stores default to all modules enabled. Disabling a module preserves its data and suppresses its navigation and direct page access. The CRM API rejects direct requests to disabled modules. Attendance's direct Supabase reads and timesheet writes are covered by database policy and trigger; paused reminders cannot be claimed for delivery.
- The browser checks for changed access every 30 seconds while visible and on window focus, updating navigation without a page reload.

## Verification

| Check | Result |
| --- | --- |
| Frontend production build | Passed |
| Edge Function Node handler tests | 28 passed |
| Store feature API route guard tests | Passed |
| Browser: creation modal at 390px and 1440px | Passed with synthetic local API responses |
| Browser: disabled Sales and Attendance direct routes | Passed with synthetic local API responses |
| Browser: Super Admin edit, Store Admin restriction | Passed with synthetic local API responses |
| Browser: changed feature refreshes navigation without a page reload | Passed with synthetic local API responses |
| SQL migration and direct Supabase RLS against a live database | Blocked: no staging project or running local Postgres |
| Physical device and hosted multi-session permission change | Blocked until staging/production release validation |

## Deployment dependency

Apply `202611070100_store_contact_details.sql` and `202611070101_store_features.sql` before deploying the updated `crm-api` Edge Function or frontend. Verify migrations and RLS in a non-production database first. The user previously requested no production migration or infrastructure change; this candidate remains local pending explicit approval for that deployment step.
