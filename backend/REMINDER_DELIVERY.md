# Production reminder notifications

The published CRM uses GitHub Pages and Supabase. The Django reminder worker does
not read Supabase's `crm_reminders` table. Production delivery is handled by the
`reminder-dispatch` Edge Function and the named `crm-reminder-dispatch` database
cron job, polling every ten seconds. Only due work starts an Edge Function.
Delivery normally begins within ten seconds, with additional provider/network delay.

Keep the existing `WEBPUSH_VAPID_PUBLIC_KEY`, `WEBPUSH_VAPID_PRIVATE_KEY`, and
`WEBPUSH_VAPID_SUBJECT` in Supabase secrets. Do not generate replacement keys on
deploy: existing browser subscriptions are tied to the public key.

Vault secrets `crm_reminder_project_url`, `crm_reminder_service_key`, and
`crm_reminder_dispatch_token` supply the cron URL, gateway credential, and scoped
dispatch token. The last token must also be configured as `REMINDER_DISPATCH_TOKEN`
in Edge Function secrets. JWT verification remains enabled; the dispatch token is
additionally required. Browser sessions cannot claim or dispatch reminders.
The authenticated `POST` body `{"mode":"health"}` checks configuration without
sending any notifications or claiming reminders.

The Pages build must include `/CRM/service-worker.js` and its notification icon.
The worker handles push events independently of an open page. The Reminders page
re-saves an existing browser subscription on load and reports success only after
the API has saved it. Setting or updating a reminder connects notifications
automatically and requests browser permission if needed, directly from the submit
click. There is no separate enable or disable button. If permission is blocked or
connection fails, the reminder is saved with a visible warning, and setting another
reminder retries the connection. Browser permission remains under user control.

Database leases prevent concurrent workers claiming the same reminder. Accepted
devices are skipped during retries. Expired subscriptions are removed, transient
failures retry with backoff, and reminders with no registered device wait for one.
The notification tag remains stable across retries.

Each scheduled occurrence has its own revision and delivery records. Rescheduling
does not reuse old accepted records. Device-side IndexedDB deduplicates an
occurrence across worker restarts and notification dismissal. Push messages have
a seven-day TTL so a temporarily offline device can receive them after reconnecting.
After that retention window, the overdue reminder remains visible for rescheduling.

Delivery records distinguish provider acceptance, browser receipt, browser API
notification creation, and notification click. `sent_at` is retained for compatibility
and means provider acceptance, not proof that a person saw a banner. A successful
showNotification call also cannot override Windows Do Not Disturb or blocked banners.
Receipts use random 256-bit tokens, stored only as hashes server-side, restricted to
one occurrence, and expire after eight days. The receipt Edge Function has no user
session requirement; these scoped tokens authorize acknowledgement only. It cannot
read reminders, alter scheduling, or send notifications. Its backing RPC is restricted
to the service role. Late receipts for rescheduled reminders are rejected.

Worker account binding is persisted before registration is saved. Account switching
and logout clear that binding and old visible notifications. Push payloads for a
different account are discarded. Relative notification links work on both localhost
and /CRM/, and are restricted to the app's origin and scope.

Browser-closed support is platform-dependent. A fully terminated desktop Chrome
process cannot run JavaScript; pending pushes wait until it runs again. Supported
OS background delivery may continue after windows close, depending on browser and
system settings. A powered-off/offline device cannot display a new network push
at the original scheduled instant. See the Chromium explanation:
https://groups.google.com/a/chromium.org/g/chromium-dev/c/jqrtJCPMb-k/m/hYM1WE7mAAAJ

On the initial repair, the user requested upcoming reminders only. Existing
overdue reminders must be left unsent with a clear delivery error; do not replay
them while enabling the scheduler. Rescheduling them explicitly clears failure
state through the existing reminder update endpoint.

The Pages workflow runs regression tests and verifies the worker assets so later
screen changes cannot silently omit the notification worker. The cron job and
server secrets survive frontend deployments.

Validation: reminderPush.test.mjs covers permission, registration and save errors;
reminderWorker.test.mjs covers open/closed page contexts, worker restarts, simulated
browser shutdown and provider queueing, offline receipt persistence, account isolation,
and links. These use an isolated worker harness and do not prove physical desktop
banner delivery. SQL tests run in rolled-back transactions for claims, privileges,
receipt authorization and rescheduling. Physical Chrome/Windows testing must separately
record browser receipt and visible notification results; never substitute HTTP 201
from a push provider for that evidence.
