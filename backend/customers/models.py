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
        for value in self.original_data.values():
            if value not in ("", None):
                return str(value)
        return f"{self.dataset.name} row {self.row_number}"


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
    owner = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.CASCADE,
        related_name="reminders",
    )
    text = models.CharField(max_length=500)
    reminder_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)
    sent_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        ordering = ["reminder_at", "id"]

    def __str__(self):
        return self.text

    @property
    def is_due(self):
        return self.reminder_at <= timezone.now()


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


@receiver(post_delete, sender=VisitImage)
def delete_visit_image_file(sender, instance, **kwargs):
    if instance.image:
        storage = instance.image.storage
        image_name = instance.image.name
        transaction.on_commit(lambda: storage.delete(image_name))
