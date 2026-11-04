# Attendance cutover

The supported attendance website is the CRM. Its only Supabase project is
`qdtgrddhpbwrutvojpes`.

The biometric device sends to the office relay at `192.168.1.40:8081`. The relay
forwards punches directly to:

`https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock/iclock/cdata`

On 4 November 2026, real punches at 14:28:03 and 14:28:08 IST were stored in CRM
with `attendance_devices.last_ingest_route = 'direct'`. The route marker is an
operational diagnostic, not an authentication control.

Before retirement, all six migrated tables were compared with the old project.
Every old punch, timesheet, mapping and profile identity was present in CRM.
The source had not changed since the migration snapshot. Fresh source and target
row backups and an aggregate comparison report are stored locally under the
ignored `tmp/attendance-migration/` directory; do not commit those files.

The user chose to retire the standalone attendance website and use only CRM.
The legacy project `lorrfeyiqgdfxdjqnpmn` was confirmed `INACTIVE` at 14:33:14 IST
on 4 November 2026 after direct delivery was verified. Its former receiver
returns HTTP 540 (`Project paused`), while the CRM receiver remains available.
Do not restore it or redeploy the historical compatibility bridge as
part of routine CRM or relay deployment. The old GitHub Pages files may remain
online, but that site is no longer a supported login or attendance destination.

`retire-old-attendance-project.ps1` defaults to a read-only status check and is
fixed to the legacy project. Pause requires the explicit `DirectPunchVerified`
switch and a healthy CRM. Restore is available only as an intentional rollback.
The script uses the existing Supabase CLI credential in memory and never stores
the credential in the repository.

Pausing preserves project data, but the provider limits the normal restore
window. Retain the migrated CRM data and offline archive independently of that
window. See the official [pause API](https://supabase.com/docs/reference/api/v1-pause-a-project)
and [free project pausing documentation](https://supabase.com/docs/guides/platform/free-project-pausing).
