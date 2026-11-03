# Production reminder notifications

The published CRM uses GitHub Pages and Supabase. The Django reminder worker does
not read Supabase's `crm_reminders` table. Production delivery is handled by the
`reminder-dispatch` Edge Function and the named `crm-reminder-dispatch` database
cron job, running once a minute. Delivery may arrive up to a minute after its time.

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

On the initial repair, the user requested upcoming reminders only. Existing
overdue reminders must be left unsent with a clear delivery error; do not replay
them while enabling the scheduler. Rescheduling them explicitly clears failure
state through the existing reminder update endpoint.

The Pages workflow runs regression tests and verifies the worker assets so later
screen changes cannot silently omit the notification worker. The cron job and
server secrets survive frontend deployments.
