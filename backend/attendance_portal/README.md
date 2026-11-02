# Attendance in the CRM

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
