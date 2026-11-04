# Unified CRM and Attendance

CRM and Attendance now share `qdtgrddhpbwrutvojpes` and the same CRM auth session.
The migration preserves existing CRM account IDs and credentials. Attendance
accounts match by normalized employee ID or email; contradictory matches abort.
Unmatched employees receive new CRM accounts and password setup links.

The initial transfer copied 7,123 punches, 8 timesheet entries, 19 punch mappings,
3 device registrations, company settings, and 23 attendance profiles (3 existing
CRM matches and 20 new accounts). The destination has 28 profiles in total.
Attendance user IDs are remapped to their destination CRM identities.

`202611040001_unified_attendance.sql` installs the tables, shift fields, RPCs and
row policies. Existing CRM auth triggers, roles, and login resolver are retained.
Employees read their own punches; managers/admins retain timesheet visibility;
admins approve/reject, and the super admin can delete approved entries.

The device receiver is deployed at:

`https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock/iclock/cdata`

It accepts the registered device serials in `ATTENDANCE_ALLOWED_SERIALS` and
requires a successful database write before acknowledging an upload. Devices
use their existing protocol, so this function does not require browser JWTs.

The old project's `iclock` function temporarily forwards requests to that new
receiver. It stores no new attendance data in the old database. When the
physical relay/device can be reconfigured, point it directly at the new URL.
Keep the old project intact until the device URL has been updated and incoming
real punches have been verified. `scripts/attendance-device-bridge` contains the
compatibility deployment source.

## Completing the device cutover

The active on-site relay is `192.168.1.40`; its existing application listens on
ports 3000 and 8081. Configure that running application's environment with:

```text
LIVE_ATTENDANCE_FORWARD_URL=https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock/iclock/cdata
```

Restart the relay from the same project folder so it loads the new environment.
The machine can keep its existing Server Address `192.168.1.40` and port 8081.
The updated standalone portal source also uses the new CRM project directly.
If replacing the on-site relay instead, `node scripts/attendance-relay.mjs`
runs a small CRM-only receiver on port 8081 with no API keys. Its `/health`
endpoint identifies the destination project. It accepts `.aspx` paths used by
older K90 firmware and passes cloud errors back so the device retries uploads.

Verify a real new punch in CRM after restarting the relay. Only then remove the
old project's forwarding function. Network access to the relay's website does
not grant permission to its files: changing its environment requires access to
its project folder or an operator on that computer.

Pending OT requests read fresh punch data each time they are listed. Approval
requires an even completed punch sequence with the last punch after the
employee's official end time plus five minutes.

Migration tooling:

- `scripts/migrate-attendance.mjs`: read-only backup/audit by default; `--apply`
  copies data idempotently and maps IDs. It never replaces existing credentials.
- `scripts/verify-unified-attendance.mjs`: checks real employee/admin sessions;
  optional flags configure registered serials, check device forwarding/recovery,
  and send reset emails to newly migrated active accounts.
- Set `SUPABASE_CLI_BIN` to the installed Supabase CLI binary. Keys are obtained
  in memory and are never printed or saved. Backups and migration bookkeeping
  are stored in ignored `tmp/attendance-migration/`; protect these local files.
- `supabase/tests/unified_attendance.sql` exercises authorization and RPC flows
  inside a transaction and rolls all test data back.

Password setup links open the CRM's recovery form. Delivery depends on the
project's Supabase email provider. Existing CRM passwords remain valid.
