from django.db import models
from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver
from django.conf import settings
import uuid
from django.utils import timezone


class Dataset(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="datasets",
    )
    name = models.CharField(max_length=255)
    original_filename = models.CharField(max_length=255)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-uploaded_at"]

    def __str__(self):
        return self.name


class DatasetColumn(models.Model):
    dataset = models.ForeignKey(
        Dataset,
        on_delete=models.CASCADE,
        related_name="columns",
    )
    sheet_name = models.CharField(max_length=255)
    original_name = models.CharField(max_length=255)
    field_key = models.CharField(max_length=255)
    order = models.PositiveIntegerField()

    class Meta:
        ordering = ["sheet_name", "order"]
        constraints = [
            models.UniqueConstraint(
                fields=["dataset", "sheet_name", "field_key"],
                name="unique_dataset_sheet_column_key",
            )
        ]

    def __str__(self):
        return f"{self.dataset.name} - {self.original_name}"


class CustomerRecord(models.Model):
    RESPONSE_NO_RESPONSE = "no_response"
    RESPONSE_INTERESTED = "interested"
    RESPONSE_NOT_INTERESTED = "not_interested"
    RESPONSE_CALLBACK = "callback"
    RESPONSE_CONVERTED = "converted"

    RESPONSE_CHOICES = [
        (RESPONSE_NO_RESPONSE, "No Response"),
        (RESPONSE_INTERESTED, "Interested"),
        (RESPONSE_NOT_INTERESTED, "Not Interested"),
        (RESPONSE_CALLBACK, "Callback"),
        (RESPONSE_CONVERTED, "Converted"),
    ]

    dataset = models.ForeignKey(
        Dataset,
        on_delete=models.CASCADE,
        related_name="records",
    )
    sheet_name = models.CharField(max_length=255)
    row_number = models.PositiveIntegerField()
    original_data = models.JSONField()
    response = models.CharField(
        max_length=32,
        choices=RESPONSE_CHOICES,
        default=RESPONSE_NO_RESPONSE,
    )
    note = models.TextField(blank=True)
    callback_date = models.DateField(blank=True, null=True)
    callback_completed_at = models.DateTimeField(blank=True, null=True)
    callback_completed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="completed_callbacks",
        blank=True,
        null=True,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["dataset_id", "sheet_name", "row_number"]
        constraints = [
            models.UniqueConstraint(
                fields=["dataset", "sheet_name", "row_number"],
                name="unique_dataset_sheet_row",
            )
        ]

    def __str__(self):
        return f"{self.dataset.name} row {self.row_number}"

    @property
    def display_name(self):
        preferred_keys = (
            "customer_name",
            "customer",
            "client_name",
            "client",
            "full_name",
            "name",
            "contact_name",
            "company_name",
            "company",
        )
        for key in preferred_keys:
            value = self.original_data.get(key)
            if value not in ("", None):
                return str(value)

        column_keys = self.dataset.columns.filter(
            sheet_name=self.sheet_name,
        ).values_list("field_key", flat=True)
        for key in column_keys:
            value = self.original_data.get(key)
            if value not in ("", None):
                return str(value)

        for value in self.original_data.values():
            if value not in ("", None):
                return str(value)
        return f"{self.dataset.name} row {self.row_number}"


class CustomerRecordChange(models.Model):
    record = models.ForeignKey(
        CustomerRecord,
        on_delete=models.CASCADE,
        related_name="change_history",
    )
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="customer_record_changes",
        blank=True,
        null=True,
    )
    previous_values = models.JSONField()
    updated_values = models.JSONField()
    changed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-changed_at", "-id"]

    def __str__(self):
        return f"Change to customer record {self.record_id} at {self.changed_at}"


class ManualClient(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.PROTECT,
        related_name="manual_clients",
    )
    client_name = models.CharField(max_length=255)
    phone = models.CharField(max_length=50, blank=True)
    email = models.EmailField(blank=True)
    company = models.CharField(max_length=255, blank=True)
    location = models.CharField(max_length=255, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["client_name", "-created_at"]

    def __str__(self):
        return self.client_name

    @property
    def display_name(self):
        return self.client_name


class Visit(models.Model):
    STATUS_HEALTHY = "healthy"
    STATUS_FOLLOW_UP = "follow_up_required"
    STATUS_INTERESTED = "interested"
    STATUS_NOT_INTERESTED = "not_interested"
    STATUS_CONVERTED = "converted"

    STATUS_CHOICES = [
        (STATUS_HEALTHY, "Healthy"),
        (STATUS_FOLLOW_UP, "Follow-up Required"),
        (STATUS_INTERESTED, "Interested"),
        (STATUS_NOT_INTERESTED, "Not Interested"),
        (STATUS_CONVERTED, "Converted"),
    ]

    PAYMENT_NOT_PAID = "not_paid"
    PAYMENT_PARTIAL = "partially_paid"
    PAYMENT_COMPLETED = "completed"
    PAYMENT_ONE_TIME = "one_time"

    PAYMENT_STATUS_CHOICES = [
        (PAYMENT_NOT_PAID, "Not Paid"),
        (PAYMENT_PARTIAL, "Partially Paid"),
        (PAYMENT_COMPLETED, "Completed"),
        (PAYMENT_ONE_TIME, "One-time Payment"),
    ]

    customer = models.ForeignKey(
        CustomerRecord,
        on_delete=models.CASCADE,
        related_name="visits",
        blank=True,
        null=True,
    )
    manual_client = models.ForeignKey(
        ManualClient,
        on_delete=models.CASCADE,
        related_name="visits",
        blank=True,
        null=True,
    )
    visit_date = models.DateField()
    meeting_time = models.TimeField()
    location = models.CharField(max_length=255)
    expense = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    status = models.CharField(max_length=32, choices=STATUS_CHOICES, default=STATUS_HEALTHY)
    payment_status = models.CharField(
        max_length=32,
        choices=PAYMENT_STATUS_CHOICES,
        default=PAYMENT_NOT_PAID,
    )
    total_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    paid_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    payment_description = models.TextField(blank=True)
    note = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-visit_date", "-meeting_time", "-created_at"]
        constraints = [
            models.CheckConstraint(
                condition=(
                    models.Q(customer__isnull=False, manual_client__isnull=True)
                    | models.Q(customer__isnull=True, manual_client__isnull=False)
                ),
                name="visit_has_one_client_source",
            )
        ]

    def __str__(self):
        return f"{self.client_display_name} visit on {self.visit_date}"

    @property
    def dataset(self):
        if self.customer_id:
            return self.customer.dataset
        return None

    @property
    def client_display_name(self):
        if self.customer_id:
            return self.customer.display_name
        return self.manual_client.display_name

    @property
    def client_source_label(self):
        return "Excel Customer" if self.customer_id else "Manual Client"

    @property
    def pending_amount(self):
        return max(self.total_amount - self.paid_amount, 0)


def visit_image_upload_path(instance, filename):
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return f"visit-images/{instance.visit_id}/{uuid.uuid4().hex}.{extension}"


class VisitImage(models.Model):
    visit = models.ForeignKey(Visit, on_delete=models.CASCADE, related_name="images")
    image = models.FileField(upload_to=visit_image_upload_path)
    original_name = models.CharField(max_length=255)
    uploaded_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["uploaded_at", "id"]

    def __str__(self):
        return self.original_name


class Reminder(models.Model):
    DELIVERY_PENDING = "pending"
    DELIVERY_PROCESSING = "processing"
    DELIVERY_RETRYING = "retrying"
    DELIVERY_SENT = "sent"
    DELIVERY_FAILED = "failed"
    DELIVERY_NO_SUBSCRIPTIONS = "no_subscriptions"

    DELIVERY_STATUS_CHOICES = [
        (DELIVERY_PENDING, "Pending"),
        (DELIVERY_PROCESSING, "Processing"),
        (DELIVERY_RETRYING, "Retrying"),
        (DELIVERY_SENT, "Sent"),
        (DELIVERY_FAILED, "Failed"),
        (DELIVERY_NO_SUBSCRIPTIONS, "No subscriptions"),
    ]

    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="reminders",
    )
    text = models.CharField(max_length=500)
    reminder_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(blank=True, null=True)
    delivery_status = models.CharField(
        max_length=32,
        choices=DELIVERY_STATUS_CHOICES,
        default=DELIVERY_PENDING,
    )
    delivery_attempt_count = models.PositiveIntegerField(default=0)
    last_delivery_attempt_at = models.DateTimeField(blank=True, null=True)
    next_delivery_attempt_at = models.DateTimeField(blank=True, null=True)
    delivery_locked_at = models.DateTimeField(blank=True, null=True)
    last_delivery_error = models.TextField(blank=True)

    class Meta:
        ordering = ["reminder_at", "id"]
        indexes = [
            models.Index(
                fields=["sent_at", "reminder_at", "next_delivery_attempt_at"],
                name="reminder_due_delivery_idx",
            ),
            models.Index(fields=["delivery_status", "delivery_locked_at"], name="reminder_delivery_lock_idx"),
        ]

    def __str__(self):
        return self.text

    @property
    def is_due(self):
        return self.reminder_at <= timezone.now()


class AssignedTask(models.Model):
    STATUS_PENDING = "pending"
    STATUS_DONE = "done"

    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_DONE, "Done"),
    ]

    assignee = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="assigned_tasks",
    )
    assigned_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        related_name="created_tasks",
        blank=True,
        null=True,
    )
    title = models.CharField(max_length=255)
    note = models.TextField(blank=True)
    due_at = models.DateTimeField(blank=True, null=True)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    completed_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status", "due_at", "-created_at"]

    def __str__(self):
        return f"{self.title} -> {self.assignee}"


class PushSubscription(models.Model):
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="push_subscriptions",
    )
    endpoint = models.URLField(max_length=2048, unique=True)
    p256dh = models.CharField(max_length=255)
    auth = models.CharField(max_length=255)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"Push subscription for {self.owner}"


class ReminderDelivery(models.Model):
    STATUS_PENDING = "pending"
    STATUS_ACCEPTED = "accepted"
    STATUS_FAILED = "failed"
    STATUS_EXPIRED = "expired"

    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_ACCEPTED, "Accepted by push service"),
        (STATUS_FAILED, "Failed"),
        (STATUS_EXPIRED, "Expired subscription"),
    ]

    reminder = models.ForeignKey(
        Reminder,
        on_delete=models.CASCADE,
        related_name="deliveries",
    )
    subscription = models.ForeignKey(
        PushSubscription,
        on_delete=models.SET_NULL,
        related_name="reminder_deliveries",
        blank=True,
        null=True,
    )
    endpoint_hash = models.CharField(max_length=64)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    attempt_count = models.PositiveIntegerField(default=0)
    last_attempt_at = models.DateTimeField(blank=True, null=True)
    last_error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["reminder", "subscription"],
                name="unique_reminder_subscription_delivery",
            ),
        ]
        indexes = [
            models.Index(fields=["reminder", "status"], name="reminder_delivery_status_idx"),
        ]

    def __str__(self):
        return f"Reminder {self.reminder_id} delivery {self.status}"


@receiver(post_delete, sender=VisitImage)
def delete_visit_image_file(sender, instance, **kwargs):
    if instance.image:
        storage = instance.image.storage
        image_name = instance.image.name
        transaction.on_commit(lambda: storage.delete(image_name))
class SalesTarget(models.Model):
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="sales_targets",
    )
    dataset = models.ForeignKey(
        Dataset,
        on_delete=models.CASCADE,
        related_name="sales_targets",
        blank=True,
        null=True,
    )
    month = models.DateField()
    target = models.PositiveIntegerField()

    class Meta:
        ordering = ["-month", "user__username"]
        constraints = [
            models.UniqueConstraint(
                fields=["user", "month"],
                name="unique_sales_target_user_month",
            )
        ]

    def __str__(self):
        return f"{self.user.username} - {self.month:%B %Y} - {self.target}"


class OvertimeRequest(models.Model):
    STATUS_PENDING = "pending"
    STATUS_APPROVED = "approved"
    STATUS_REJECTED = "rejected"
    STATUS_CHOICES = [
        (STATUS_PENDING, "Pending"),
        (STATUS_APPROVED, "Approved"),
        (STATUS_REJECTED, "Rejected"),
    ]

    employee = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="overtime_requests")
    work_date = models.DateField()
    assigned_start_time = models.TimeField()
    assigned_end_time = models.TimeField()
    official_end_time = models.TimeField()
    declared_leave_time = models.DateTimeField()
    actual_punch_out = models.DateTimeField(blank=True, null=True)
    requested_minutes = models.PositiveIntegerField(default=0)
    approved_minutes = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=16, choices=STATUS_CHOICES, default=STATUS_PENDING)
    rejection_message = models.TextField(blank=True)
    reviewed_by = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET_NULL, related_name="reviewed_overtime_requests", blank=True, null=True)
    reviewed_at = models.DateTimeField(blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-work_date", "-created_at"]
        constraints = [models.UniqueConstraint(fields=["employee", "work_date"], name="unique_overtime_employee_date")]

    def __str__(self):
        return f"OT {self.employee} on {self.work_date}"
