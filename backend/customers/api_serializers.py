from django.contrib.auth import get_user_model
from django.urls import reverse
from django.utils import timezone
from rest_framework import serializers

from .models import AssignedTask, CustomerRecord, Dataset, ManualClient, Reminder, SalesTarget, Visit, VisitImage


class UserSerializer(serializers.ModelSerializer):
    is_admin = serializers.SerializerMethodField()

    class Meta:
        model = get_user_model()
        fields = ["id", "username", "email", "is_staff", "is_superuser", "is_admin"]

    def get_is_admin(self, obj):
        return obj.is_staff or obj.is_superuser


class DatasetListSerializer(serializers.ModelSerializer):
    owner_username = serializers.CharField(source="owner.username", read_only=True)
    customer_count = serializers.IntegerField(read_only=True)
    target = serializers.SerializerMethodField()
    converted_count = serializers.SerializerMethodField()
    remaining_target = serializers.SerializerMethodField()

    class Meta:
        model = Dataset
        fields = [
            "id",
            "name",
            "original_filename",
            "owner_username",
            "customer_count",
            "target",
            "converted_count",
            "remaining_target",
            "uploaded_at",
            "updated_at",
        ]

    def get_target_obj(self, obj):
        if hasattr(obj, "_sales_target_cache"):
            return obj._sales_target_cache
        current_month = timezone.localdate().replace(day=1)
        obj._sales_target_cache = SalesTarget.objects.filter(
            user=obj.owner,
            month=current_month,
        ).first()
        return obj._sales_target_cache

    def get_target(self, obj):
        target = self.get_target_obj(obj)
        return target.target if target else None

    def get_converted_count(self, obj):
        if hasattr(obj, "_converted_count_cache"):
            return obj._converted_count_cache
        current_month = timezone.localdate().replace(day=1)
        if current_month.month == 12:
            next_month = current_month.replace(year=current_month.year + 1, month=1, day=1)
        else:
            next_month = current_month.replace(month=current_month.month + 1, day=1)
        obj._converted_count_cache = Visit.objects.filter(
            customer__dataset__owner=obj.owner,
            status=Visit.STATUS_CONVERTED,
            visit_date__gte=current_month,
            visit_date__lt=next_month,
        ).count()
        return obj._converted_count_cache

    def get_remaining_target(self, obj):
        target = self.get_target_obj(obj)
        if not target:
            return None
        return max(target.target - self.get_converted_count(obj), 0)


class CustomerRecordSerializer(serializers.ModelSerializer):
    display_name = serializers.CharField(read_only=True)
    response_label = serializers.CharField(source="get_response_display", read_only=True)

    class Meta:
        model = CustomerRecord
        fields = [
            "id",
            "display_name",
            "sheet_name",
            "row_number",
            "original_data",
            "response",
            "response_label",
            "note",
            "created_at",
            "updated_at",
        ]


class ReminderSerializer(serializers.ModelSerializer):
    is_due = serializers.BooleanField(read_only=True)

    class Meta:
        model = Reminder
        fields = ["id", "text", "reminder_at", "is_due", "created_at"]
        read_only_fields = ["id", "is_due", "created_at"]

    def validate_text(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter a reminder.")
        return value

    def validate_reminder_at(self, value):
        if value <= timezone.now():
            raise serializers.ValidationError("Choose a future date and time.")
        return value


class AssignedTaskSerializer(serializers.ModelSerializer):
    assignee_username = serializers.CharField(source="assignee.username", read_only=True)
    assigned_by_username = serializers.CharField(source="assigned_by.username", read_only=True, allow_null=True)
    status_label = serializers.CharField(source="get_status_display", read_only=True)

    class Meta:
        model = AssignedTask
        fields = [
            "id",
            "assignee",
            "assignee_username",
            "assigned_by_username",
            "title",
            "note",
            "due_at",
            "status",
            "status_label",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "assignee_username",
            "assigned_by_username",
            "status_label",
            "created_at",
            "updated_at",
        ]

    def validate_title(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError("Enter a task.")
        return value


class ManualClientSerializer(serializers.ModelSerializer):
    owner_username = serializers.CharField(source="owner.username", read_only=True)

    class Meta:
        model = ManualClient
        fields = [
            "id",
            "owner_username",
            "client_name",
            "phone",
            "email",
            "company",
            "location",
            "created_at",
            "updated_at",
        ]


class VisitImageSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = VisitImage
        fields = ["id", "url", "original_name", "uploaded_at"]

    def get_url(self, obj):
        return reverse("customers_api:visit_image", args=[obj.visit_id, obj.id])


class VisitSerializer(serializers.ModelSerializer):
    client_name = serializers.CharField(source="client_display_name", read_only=True)
    client_source = serializers.CharField(source="client_source_label", read_only=True)
    dataset_id = serializers.SerializerMethodField()
    dataset_name = serializers.SerializerMethodField()
    status_label = serializers.CharField(source="get_status_display", read_only=True)
    manual_client = ManualClientSerializer(read_only=True)
    client_record_id = serializers.IntegerField(source="customer_id", read_only=True)
    customer_note = serializers.CharField(source="customer.note", read_only=True, allow_null=True)
    images = VisitImageSerializer(many=True, read_only=True)

    class Meta:
        model = Visit
        fields = [
            "id",
            "client_name",
            "client_source",
            "dataset_id",
            "dataset_name",
            "manual_client",
            "client_record_id",
            "customer_note",
            "images",
            "visit_date",
            "meeting_time",
            "location",
            "expense",
            "status",
            "status_label",
            "note",
            "created_at",
            "updated_at",
        ]

    def get_dataset_id(self, obj):
        return obj.customer.dataset_id if obj.customer_id else None

    def get_dataset_name(self, obj):
        return obj.customer.dataset.name if obj.customer_id else None
