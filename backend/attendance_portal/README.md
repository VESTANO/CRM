# Attendance in the CRM

## Supabase frontend: Attendance single login

Attendance opens automatically for the signed-in CRM user, including employees,
admins, and super admins. No separate username or password is requested.
The server validates the existing CRM token and matches the authenticated
CRM profile's `employee_id` (its username) to the attendance profile's
`employee_id` (its login username), ignoring case. Emails and display names do
not need to match. Duplicate matches, inactive accounts, and missing matches
are denied with a visible error and retry button. Attendance sessions are held in
memory for the current CRM user and restored automatically after page reload.
CRM logout or switching CRM users clears Attendance access.

The two Supabase projects require a trusted server connection. Set
`ATTENDANCE_SUPABASE_SERVICE_ROLE_KEY` in the CRM project's Edge Function
secrets to the attendance project's service-role key, then deploy `crm-api`.
Never expose that key in frontend variables. `ATTENDANCE_SUPABASE_URL` defaults
to `https://lorrfeyiqgdfxdjqnpmn.supabase.co`. Deploy the updated frontend after
the function. No new database migration is required.

`POST /api/auth/attendance-session/` requires a valid CRM token. It derives the
employee ID from the active CRM account, ignores client-supplied identities,
looks up the unique attendance username, and issues a session for that
existing attendance user. CRM Admin and Super Admin accounts are also provisioned
in Attendance with their corresponding admin role during CRM account creation.
Existing CRM admins are synchronized when they next open Attendance. An existing
Attendance Super Admin is never downgraded by login synchronization. Explicit role
changes in CRM Edit User update the matching Attendance role, including demotions.
If Attendance synchronization fails, the CRM edit is restored. Matching accounts keep their passwords,
personal details, and attendance history; inactive or ambiguous matches are denied.
Missing admin accounts receive a new Attendance identity for CRM single login.
Employee accounts continue to require an existing matching Attendance account.
No passwords are copied, changed, or requested a second time.

## Django attendance backup

Attendance is a native React page at `/attendance`, available in the existing
CRM sidebar on desktop and mobile. `/api/attendance/` uses the CRM session;
there is no separate attendance login or Supabase dependency.

The attendance calculations are adapted from the supplied Time sheet archive.
The page supports date and employee filters, daily punches, breaks, net working
time, attendance status, periodic refresh, CSV exports, and admin punch mapping.
Times use Asia/Kolkata. The imported shift rules and five-minute grace period
are retained.

CRM administrators can see all attendance and map punch codes to CRM accounts.
Regular users see only their own linked records. Unique matching employee IDs
(CRM username) or email addresses link automatically; ambiguous matches remain
unlinked until an administrator assigns the punch code. CRM logout immediately
removes attendance access.

Import saved punches with:

    python manage.py import_attendance_zip "C:\path\to\Time sheet (3).zip"

Reimporting adds new punches without replacing mappings. Source passwords,
password hashes, login sessions, and timesheets are not imported. Attendance is
stored transactionally in `media/attendance/attendance.sqlite3`; include that
file in backups. The existing CRM database and authentication are unchanged.
No additional packages or CRM migrations are required.

This imports the ZIP's saved data. It does not connect to the source Supabase
service or automatically redirect its physical attendance device. New saved
records can be reimported; live device sync requires a separate receiver setup.
