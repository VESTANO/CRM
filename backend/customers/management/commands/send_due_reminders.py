import json
import time

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from customers.models import PushSubscription, Reminder


class Command(BaseCommand):
    help = "Send web push notifications for due reminders."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true", help="Keep checking for due reminders.")
        parser.add_argument("--interval", type=int, default=5, help="Seconds between checks in loop mode.")

    def handle(self, *args, **options):
        if not settings.WEBPUSH_VAPID_PUBLIC_KEY or not settings.WEBPUSH_VAPID_PRIVATE_KEY:
            raise CommandError("Generate VAPID keys and restart Django before starting this command.")
        if options["interval"] < 5:
            raise CommandError("The polling interval must be at least 5 seconds.")

        if options["loop"]:
            self.stdout.write("Reminder push worker running. Press Ctrl+C to stop.")
            try:
                while True:
                    self.send_due()
                    time.sleep(options["interval"])
            except KeyboardInterrupt:
                self.stdout.write("Reminder push worker stopped.")
        else:
            self.send_due()

    def send_due(self):
        from pywebpush import webpush

        due_reminders = Reminder.objects.filter(
            sent_at__isnull=True,
            reminder_at__lte=timezone.now(),
        ).select_related("owner")
        for reminder in due_reminders.iterator():
            delivered = False
            subscriptions = PushSubscription.objects.filter(owner=reminder.owner)
            reminder_time = timezone.localtime(reminder.reminder_at).strftime("%d %b %Y, %H:%M")
            payload = json.dumps({
                "title": "Customer CRM | Reminder",
                "body": f"{reminder.text} ({reminder_time})",
                "url": f"/notifications/?reminder={reminder.pk}#reminder-{reminder.pk}",
                "tag": f"crm-reminder-{reminder.pk}",
                "reminderId": reminder.pk,
            })
            for subscription in subscriptions.iterator():
                try:
                    webpush(
                        subscription_info={
                            "endpoint": subscription.endpoint,
                            "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth},
                        },
                        data=payload,
                        vapid_private_key=settings.WEBPUSH_VAPID_PRIVATE_KEY,
                        vapid_claims={"sub": settings.WEBPUSH_VAPID_SUBJECT},
                        ttl=86400,
                    )
                    delivered = True
                except Exception as error:
                    response = getattr(error, "response", None)
                    if response is not None and response.status_code in (404, 410):
                        subscription.delete()
                    self.stderr.write(f"Push delivery failed for subscription {subscription.pk}: {error}")
            if delivered:
                Reminder.objects.filter(pk=reminder.pk, sent_at__isnull=True).update(sent_at=timezone.now())
                self.stdout.write(f"Sent reminder {reminder.pk} to {reminder.owner.username}.")
