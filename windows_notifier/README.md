# Windows desktop reminder companion

This is a Windows background program, independent of Chrome and the CRM tab. It
polls the authenticated account's reminder feed every 15 seconds and schedules
cached reminders locally. The PC must be powered on and the Windows user signed
in. Windows notification permissions and Do Not Disturb still control visible
banners; this program does not bypass or change those settings.

## Installation footprint

No installation or startup activation occurs by importing or testing these files.
After approval, run `powershell -NoProfile -File windows_notifier/install.ps1` from
the CRM checkout. `-CrmUrl http://localhost:5173/` can be used for this development
CRM; otherwise the verification link and notification clicks use the live Pages CRM.

Installation copies `notifier.py` and `engine.py` to
`%LOCALAPPDATA%\VestanoCRM\Reminders`. It registers the current-user app identity
`Vestano.CRM.Reminders`, and the scheduled task `Vestano CRM Windows Reminders`,
running the checkout's `.venv\Scripts\pythonw.exe` at Windows sign-in. It runs as
the signed-in user, without elevation or a system service. Keep the CRM Python
environment installed. It does not change browser, attendance, or Windows security
settings. The task can be stopped or removed using `uninstall.ps1`.

## One-time account connection

On first launch, the program generates a private device capability and opens a
CRM verification link. The user signs in normally if necessary, then approves
**Connect this PC**. The server derives the owner from that existing CRM session;
it never accepts a client-supplied owner. Codes expire after ten minutes, and a
claimed code cannot be assigned to a different account. This approval happens
once, not every time a reminder is set.

The device token permits only reading reminders for its approved owner and recording
its notification receipts. It cannot access attendance, customers, administration,
or a CRM login session. Only a hash is stored server-side. The local token, reminder
cache, receipts, and duplicate history are encrypted together with Windows DPAPI,
bound to the current Windows user. No browser credentials or administrator keys
are read. Tokens and reminder text are never written to the log.

The approving browser's push binding is detached and a user-specific preference
is stored to prevent a duplicate browser banner on this PC. Browser push remains
available for other devices. Disconnect in CRM revokes the Windows credential;
the notifier stops when the server reports revocation.

## Offline behavior and limits

Upcoming reminders are cached for the next 30 days. A cached reminder is shown at
its scheduled time even if Chrome and the network are unavailable. A process restart
uses the encrypted shown-history to avoid repeating an alert. Receipts retry after
reconnection. Reminders missed while the notifier was stopped can be shown within
seven days of their scheduled time.

Only reminders scheduled after this device's approval are eligible, preserving the
user's request not to replay the old overdue reminders. Deletions and reschedules
replace the cache on the next successful poll. Changes made on another device
cannot be learned while this PC is offline. A powered-off or sleeping PC cannot
display a notification at the original instant; it catches up after resuming.

## Validation

`python -m unittest discover -s windows_notifier -p test_engine.py -v` covers offline
scheduling, process-restart deduplication, rescheduling, links, XML escaping, and
real Windows DPAPI round trips. Pairing tests validate account isolation and
revocation scopes. These tests do not claim an actual Windows banner was seen.
After installation and approval, a real reminder must be tested with Chrome open,
all Chrome windows closed, and the network temporarily disconnected. Record the
native device receipt and user-visible result separately.
