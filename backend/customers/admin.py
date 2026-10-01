from django.contrib import admin

from .models import CustomerRecord, Dataset, DatasetColumn, ManualClient, Visit


class DatasetColumnInline(admin.TabularInline):
    model = DatasetColumn
    extra = 0
    readonly_fields = ["sheet_name", "original_name", "field_key", "order"]
    can_delete = False


@admin.register(Dataset)
class DatasetAdmin(admin.ModelAdmin):
    list_display = ["name", "owner", "original_filename", "uploaded_at", "updated_at"]
    search_fields = ["name", "original_filename", "owner__username"]
    list_filter = ["owner"]
    inlines = [DatasetColumnInline]


@admin.register(CustomerRecord)
class CustomerRecordAdmin(admin.ModelAdmin):
    list_display = ["dataset", "sheet_name", "row_number", "response", "created_at"]
    list_filter = ["dataset", "sheet_name", "response"]
    search_fields = ["dataset__name", "original_data"]


@admin.register(DatasetColumn)
class DatasetColumnAdmin(admin.ModelAdmin):
    list_display = ["dataset", "sheet_name", "original_name", "field_key", "order"]
    list_filter = ["dataset", "sheet_name"]
    search_fields = ["dataset__name", "original_name", "field_key"]


@admin.register(ManualClient)
class ManualClientAdmin(admin.ModelAdmin):
    list_display = ["client_name", "owner", "phone", "email", "company", "location", "created_at"]
    list_filter = ["owner"]
    search_fields = ["client_name", "phone", "email", "company", "location", "owner__username"]


@admin.register(Visit)
class VisitAdmin(admin.ModelAdmin):
    list_display = ["client_name", "client_source", "dataset_name", "visit_date", "meeting_time", "status", "expense"]
    list_filter = ["status", "visit_date", "customer__dataset", "manual_client__owner"]
    search_fields = [
        "customer__dataset__name",
        "customer__original_data",
        "manual_client__client_name",
        "manual_client__phone",
        "manual_client__email",
        "location",
        "note",
    ]

    def dataset_name(self, obj):
        return obj.customer.dataset.name if obj.customer_id else "Manual Client"

    def client_name(self, obj):
        return obj.client_display_name

    def client_source(self, obj):
        return obj.client_source_label
