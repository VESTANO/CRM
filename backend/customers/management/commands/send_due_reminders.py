import hashlib
import json
import logging
import signal
import time
from datetime import timedelta

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from django.db.models import Q
from django.utils import timezone

from customers.models import PushSubscription, Reminder, ReminderDelivery


logger = logging.getLogger("customers.reminders")
WORKER_LOCK_ID = 901_202_610


def endpoint_hash(endpoint):
    return hashlib.sha256(endpoint.encode("utf-8")).hexdigest()


class Command(BaseCommand):
    help = "Send web push notifications for due reminders."

    def add_arguments(self, parser):
        parser.add_argument("--loop", action="store_true", help="Keep checking for due reminders.")
        parser.add_argument("--interval", type=int, default=5, help="Seconds between checks in loop mode.")
        parser.add_argument("--batch-size", type=int, default=25, help="Maximum reminders to process per poll.")
        parser.add_argument("--max-attempts", type=int, default=10, help="Maximum delivery attempts before failing a reminder.")
        parser.add_argument("--lock-timeout", type=int, default=300, help="Seconds before an in-progress reminder can be reclaimed.")

    def handle(self, *args, **options):
        if not settings.WEBPUSH_VAPID_PUBLIC_KEY or not settings.WEBPUSH_VAPID_PRIVATE_KEY:
            raise CommandError("Generate VAPID keys and restart Django before starting this command.")
        if options["interval"] < 5:
            raise CommandError("The polling interval must be at least 5 seconds.")
        if options["batch_size"] < 1:
            raise CommandError("The batch size must be at least 1.")
        if options["max_attempts"] < 1:
            raise CommandError("The maximum attempt count must be at least 1.")

        self.stopping = False
        signal.signal(signal.SIGTERM, self.request_stop)
        signal.signal(signal.SIGINT, self.request_stop)

        if not self.acquire_worker_lock():
            message = "Another reminder worker already holds the database lock; exiting."
            logger.info(message)
            self.stdout.write(message)
            return
        try:
            if options["loop"]:
                self.stdout.write("Reminder push worker running. Press Ctrl+C to stop.")
                logger.info("Reminder push worker started.")
                while not self.stopping:
                    try:
                        self.send_due(options)
                    except Exception:
                        logger.exception("Reminder worker poll failed.")
                    self.sleep(options["interval"])
                logger.info("Reminder push worker stopped.")
                self.stdout.write("Reminder push worker stopped.")
            else:
                self.send_due(options)
        finally:
            self.release_worker_lock()

    def request_stop(self, signum, frame):
        self.stopping = True

    def sleep(self, seconds):
        deadline = time.monotonic() + seconds
        while not self.stopping and time.monotonic() < deadline:
            time.sleep(min(0.5, deadline - time.monotonic()))

    def acquire_worker_lock(self):
        if connection.vendor != "postgresql":
            return True
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s)", [WORKER_LOCK_ID])
            return cursor.fetchone()[0]

    def release_worker_lock(self):
        if connection.vendor != "postgresql":
            return
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_advisory_unlock(%s)", [WORKER_LOCK_ID])

    def send_due(self, options):
        for reminder_id in self.claim_due_reminders(options):
            self.process_reminder(reminder_id, options)

    def claim_due_reminders(self, options):
        now = timezone.now()
        stale_before = now - timedelta(seconds=options["lock_timeout"])
        due_filter = Q(next_delivery_attempt_at__isnull=True) | Q(next_delivery_attempt_at__lte=now)
        reclaim_filter = ~Q(delivery_status=Reminder.DELIVERY_PROCESSING) | Q(delivery_locked_at__lt=stale_before)

        with transaction.atomic():
            queryset = Reminder.objects.filter(
                sent_at__isnull=True,
                reminder_at__lte=now,
            ).filter(due_filter, reclaim_filter).order_by("reminder_at", "id")
            if connection.features.has_select_for_update_skip_locked:
                queryset = queryset.select_for_update(skip_locked=True)
            else:
                queryset = queryset.select_for_update()
            reminder_ids = list(queryset.values_list("id", flat=True)[: options["batch_size"]])
            if reminder_ids:
                Reminder.objects.filter(id__in=reminder_ids).update(
                    delivery_status=Reminder.DELIVERY_PROCESSING,
                    delivery_locked_at=now,
                )
        return reminder_ids

    def process_reminder(self, reminder_id, options):
        from pywebpush import webpush

        reminder = Reminder.objects.select_related("owner").get(pk=reminder_id)
        subscriptions = list(PushSubscription.objects.filter(owner=reminder.owner).order_by("id"))
        now = timezone.now()
        Reminder.objects.filter(pk=reminder.pk).update(
            delivery_attempt_count=reminder.delivery_attempt_count + 1,
            last_delivery_attempt_at=now,
        )

        if not subscriptions:
            self.finish_reminder(
                reminder,
                Reminder.DELIVERY_NO_SUBSCRIPTIONS,
                "No browser push subscriptions are registered for this user.",
                options,
            )
            logger.warning("Reminder %s has no push subscriptions.", reminder.pk)
            return

        for subscription in subscriptions:
            ReminderDelivery.objects.get_or_create(
                reminder=reminder,
                subscription=subscription,
                defaults={"endpoint_hash": endpoint_hash(subscription.endpoint)},
            )

        deliveries = list(
            ReminderDelivery.objects.select_related("subscription")
            .filter(
                reminder=reminder,
                status__in=[ReminderDelivery.STATUS_PENDING, ReminderDelivery.STATUS_FAILED],
                subscription__isnull=False,
            )
            .order_by("id")
        )
        payload = self.payload_for(reminder)
        errors = []

        for delivery in deliveries:
            subscription = delivery.subscription
            attempt_at = timezone.now()
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
                delivery.status = ReminderDelivery.STATUS_ACCEPTED
                delivery.last_error = ""
                logger.info("Reminder %s accepted by push service for subscription %s.", reminder.pk, subscription.pk)
            except Exception as error:
                response = getattr(error, "response", None)
                status_code = getattr(response, "status_code", None)
                if status_code in (404, 410):
                    expired_endpoint_hash = endpoint_hash(subscription.endpoint)
                    delivery.status = ReminderDelivery.STATUS_EXPIRED
                    delivery.last_error = f"Subscription expired with HTTP {status_code}."
                    subscription.delete()
                    delivery.subscription = None
                    delivery.endpoint_hash = expired_endpoint_hash
                    logger.info("Deleted expired push subscription %s for reminder %s.", subscription.pk, reminder.pk)
                else:
                    delivery.status = ReminderDelivery.STATUS_FAILED
                    delivery.last_error = str(error)[:2000]
                    errors.append(f"subscription {subscription.pk}: {delivery.last_error}")
                    logger.warning("Push delivery failed for reminder %s subscription %s: %s", reminder.pk, subscription.pk, error)
            finally:
                delivery.attempt_count += 1
                delivery.last_attempt_at = attempt_at
                if delivery.subscription_id:
                    delivery.endpoint_hash = endpoint_hash(subscription.endpoint)
                delivery.save(update_fields=[
                    "subscription",
                    "status",
                    "attempt_count",
                    "last_attempt_at",
                    "last_error",
                    "endpoint_hash",
                    "updated_at",
                ])

        pending_failures = ReminderDelivery.objects.filter(
            reminder=reminder,
            status__in=[ReminderDelivery.STATUS_PENDING, ReminderDelivery.STATUS_FAILED],
            subscription__isnull=False,
        ).count()
        accepted_count = ReminderDelivery.objects.filter(
            reminder=reminder,
            status=ReminderDelivery.STATUS_ACCEPTED,
        ).count()

        if pending_failures == 0 and accepted_count:
            self.finish_reminder(reminder, Reminder.DELIVERY_SENT, "", options, sent=True)
            self.stdout.write(f"Sent reminder {reminder.pk} to {reminder.owner.username}.")
            return
        if pending_failures == 0:
            self.finish_reminder(
                reminder,
                Reminder.DELIVERY_NO_SUBSCRIPTIONS,
                "No active browser push subscriptions remain for this user.",
                options,
            )
            return

        self.finish_reminder(
            reminder,
            Reminder.DELIVERY_RETRYING,
            "; ".join(errors) or "Push delivery did not complete for every subscription.",
            options,
        )

    def payload_for(self, reminder):
        reminder_time = timezone.localtime(reminder.reminder_at).strftime("%d %b %Y, %H:%M")
        return json.dumps({
            "title": "VestaTrack | Reminder",
            "body": f"{reminder.text} ({reminder_time})",
            "url": f"/reminders/?reminder={reminder.pk}#reminder-{reminder.pk}",
            "tag": f"crm-reminder-{reminder.pk}",
            "reminderId": reminder.pk,
        })

    def finish_reminder(self, reminder, status, error, options, sent=False):
        now = timezone.now()
        update = {
            "delivery_status": status,
            "delivery_locked_at": None,
            "last_delivery_error": error[:4000],
        }
        if sent:
            update["sent_at"] = now
            update["next_delivery_attempt_at"] = None
        elif status == Reminder.DELIVERY_RETRYING and reminder.delivery_attempt_count + 1 < options["max_attempts"]:
            update["next_delivery_attempt_at"] = now + self.retry_delay(reminder.delivery_attempt_count + 1)
        else:
            update["delivery_status"] = Reminder.DELIVERY_FAILED if status == Reminder.DELIVERY_RETRYING else status
            update["next_delivery_attempt_at"] = None
        Reminder.objects.filter(pk=reminder.pk).update(**update)

    def retry_delay(self, attempts):
        return timedelta(minutes=min(60, 2 ** min(attempts, 5)))
