import io
import json
from urllib.request import Request as UrlRequest, urlopen
import mimetypes
import zipfile
from collections import Counter
from datetime import datetime, timedelta

from django.contrib.auth import authenticate, login, logout
from django.contrib.auth import get_user_model
from django.conf import settings
from django.utils.decorators import method_decorator
from django.utils.dateparse import parse_date
from django.views.decorators.csrf import csrf_protect
from django.core.paginator import Paginator
from django.db import transaction, IntegrityError
from django.db.models import Count, F, Prefetch, Q, Sum
from django.middleware.csrf import get_token
from django.http import FileResponse, HttpResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .api_serializers import (
    AssignedTaskSerializer,
    CustomerRecordChangeSerializer,
    CustomerRecordSerializer,
    DatasetListSerializer,
    ReminderSerializer,
    UserSerializer,
    VisitSerializer,
)
from .audit import customer_crm_values, save_customer_crm_change
from .forms import (
    AdminPasswordResetForm,
    AdminUserCreateForm,
    AdminUserEditForm,
    CustomerCRMForm,
    DatasetForm,
    ExcelUploadForm,
    ManualVisitForm,
    save_visit_images,
    VisitForm,
)
from .models import AssignedTask, CustomerRecord, CustomerRecordChange, Dataset, DatasetColumn, PushSubscription, Reminder, SalesTarget, Visit, VisitImage, OvertimeRequest
from .attendance import employee_directory, record_identity
from .attendance_store import attendance_data
from .views import (
    build_records_by_sheet,
    build_dataset_export_workbook,
    create_dataset_from_inspection,
    delete_pending_upload,
    get_pending_upload,
    get_record_columns,
    build_field_rows,
    get_dataset_response_stats,
    get_accessible_datasets,
    get_accessible_visits,
    build_manual_client_rows,
    get_visit_customer_options,
    get_dataset_record,
    get_filtered_records,
    group_columns_by_sheet,
    inspect_workbook,
    safe_export_filename,
    save_pending_upload,
    mask_sensitive_value,
)

User = get_user_model()


def _ot_minutes(start, end):
    return max(0, int((end - start).total_seconds() // 60))


def _ot_context(user, work_date):
    with attendance_data() as data:
        employees, aliases = employee_directory(data)
        identity = f"crm:{user.pk}"
        employee = employees.get(identity, {})
        punches = []
        for record in data.get("attendance", []):
            if record_identity(record, data, aliases) == identity and str(record.get("timestamp", ""))[:10] == work_date.isoformat():
                punches.append(str(record.get("timestamp")))
    punches.sort()
    start_text = str(employee.get("shiftStartTime") or "09:30")[:5]
    end_text = str(employee.get("shiftEndTime") or "17:30")[:5]
    start = datetime.strptime(f"{work_date.isoformat()} {start_text}", "%Y-%m-%d %H:%M").replace(tzinfo=timezone.get_current_timezone())
    end = datetime.strptime(f"{work_date.isoformat()} {end_text}", "%Y-%m-%d %H:%M").replace(tzinfo=timezone.get_current_timezone())
    official = end + timedelta(minutes=5)
    actual = None
    if len(punches) >= 2:
        actual = datetime.strptime(punches[-1][:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.get_current_timezone())
    return employee, start, end, official, actual


def _serialize_ot(item):
    return {
        "id": item.id, "employeeId": item.employee_id, "employeeName": item.employee.get_full_name() or item.employee.username,
        "username": item.employee.username, "workDate": item.work_date.isoformat(),
        "assignedStartTime": item.assigned_start_time.strftime("%H:%M"), "assignedEndTime": item.assigned_end_time.strftime("%H:%M"),
        "officialEndTime": item.official_end_time.strftime("%H:%M"), "declaredLeaveTime": item.declared_leave_time.isoformat(),
        "actualPunchOut": item.actual_punch_out.isoformat() if item.actual_punch_out else None,
        "requestedMinutes": item.requested_minutes, "approvedMinutes": item.approved_minutes,
        "status": item.status, "rejectionMessage": item.rejection_message, "reviewedBy": item.reviewed_by.username if item.reviewed_by else None,
        "reviewedAt": item.reviewed_at.isoformat() if item.reviewed_at else None, "createdAt": item.created_at.isoformat(),
    }


def admin_only(request):
    return request.user.is_staff or request.user.is_superuser


def attendance_super_admin(request):
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer "):
        return False
    try:
        token = authorization.split(" ", 1)[1]
        base = getattr(settings, "ATTENDANCE_SUPABASE_URL", "")
        key = getattr(settings, "ATTENDANCE_SUPABASE_PUBLISHABLE_KEY", "")
        req = UrlRequest(f"{base}/auth/v1/user", headers={"apikey": key, "Authorization": f"Bearer {token}"})
        with urlopen(req, timeout=5) as response:
            auth_user = json.loads(response.read().decode("utf-8"))
        profile_req = UrlRequest(f"{base}/rest/v1/profiles?id=eq.{auth_user.get('id')}&select=role,active", headers={"apikey": key, "Authorization": f"Bearer {token}"})
        with urlopen(profile_req, timeout=5) as response:
            profiles = json.loads(response.read().decode("utf-8"))
        return bool(profiles and profiles[0].get("active") and profiles[0].get("role") == "super_admin")
    except Exception:
        return False


def visit_detail_payload(visit):
    payload = VisitSerializer(visit).data
    if visit.customer_id:
        payload["customer_fields"] = build_field_rows(
            visit.customer,
            get_record_columns(visit.customer.dataset, visit.customer),
        )
    elif visit.manual_client_id:
        payload["customer_fields"] = build_manual_client_rows(visit.manual_client)
    return payload


def serialize_form_errors(form):
    return {
        field: [str(error) for error in errors]
        for field, errors in form.errors.items()
    }


def customer_change_history(record):
    history = record.change_history.select_related("changed_by")
    return CustomerRecordChangeSerializer(history, many=True).data


def callback_phone(record):
    phone_keys = ("phone_number", "phone", "mobile_number", "mobile", "contact_number", "telephone")
    for key in phone_keys:
        value = record.original_data.get(key)
        if value not in (None, ""):
            return mask_sensitive_value(value)
    return ""


def callback_payload(record):
    return {
        "id": record.id,
        "datasetId": record.dataset_id,
        "datasetName": record.dataset.name,
        "customerName": record.display_name,
        "phone": callback_phone(record),
        "callbackDate": record.callback_date,
        "callbackCompletedAt": record.callback_completed_at,
        "callbackCompletedBy": record.callback_completed_by.username if record.callback_completed_by else None,
        "status": record.response,
        "statusLabel": record.get_response_display(),
        "note": record.note,
        "updatedAt": record.updated_at,
    }


class SessionView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        csrf_token = get_token(request)
        if request.user.is_authenticated:
            return Response(
                {
                    "isAuthenticated": True,
                    "csrfToken": csrf_token,
                    "user": UserSerializer(request.user).data,
                }
            )
        return Response({"isAuthenticated": False, "csrfToken": csrf_token, "user": None})


@method_decorator(csrf_protect, name="dispatch")
class OvertimeRequestView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        attendance_admin = attendance_super_admin(request)
        if not request.user.is_authenticated and not attendance_admin:
            return Response({"detail": "Attendance login required."}, status=401)
        queryset = OvertimeRequest.objects.select_related("employee", "reviewed_by")
        if not admin_only(request) and not attendance_admin:
            queryset = queryset.filter(employee=request.user)
        for item in queryset.filter(status=OvertimeRequest.STATUS_PENDING):
            try:
                _, _, _, _, actual = _ot_context(item.employee, item.work_date)
                if actual and item.actual_punch_out != actual:
                    OvertimeRequest.objects.filter(pk=item.pk, status=OvertimeRequest.STATUS_PENDING).update(actual_punch_out=actual)
                    item.actual_punch_out = actual
            except (ValueError, TypeError):
                pass
        items = list(queryset)
        approved = sum(item.approved_minutes for item in items if item.status == OvertimeRequest.STATUS_APPROVED and item.employee_id == request.user.id)
        return Response({"requests": [_serialize_ot(item) for item in items], "approvedMinutes": approved})

    def post(self, request):
        work_date = parse_date(str(request.data.get("workDate", "")))
        if not work_date:
            return Response({"detail": "Choose a valid working date."}, status=400)
        try:
            declared = datetime.fromisoformat(str(request.data.get("declaredLeaveTime", "")).replace("Z", "+00:00"))
            if timezone.is_naive(declared):
                declared = timezone.make_aware(declared)
        except (TypeError, ValueError):
            return Response({"detail": "Enter a valid expected leaving time."}, status=400)
        employee, start, end, official, actual = _ot_context(request.user, work_date)
        if declared <= official:
            return Response({"detail": "Expected leaving time must be after the official end time."}, status=400)
        if OvertimeRequest.objects.filter(employee=request.user, work_date=work_date).exists():
            return Response({"detail": "An OT request already exists for this working date."}, status=409)
        item = OvertimeRequest(employee=request.user, work_date=work_date, assigned_start_time=start.time(), assigned_end_time=end.time(), official_end_time=official.time(), declared_leave_time=declared, actual_punch_out=actual, requested_minutes=_ot_minutes(official, declared))
        try:
            with transaction.atomic():
                item.save()
                admins = User.objects.filter(is_staff=True, is_active=True)
                Reminder.objects.bulk_create([Reminder(owner=admin, text=f"New OT request from {request.user.get_full_name() or request.user.username} for {work_date}", reminder_at=timezone.now()) for admin in admins])
        except IntegrityError:
            return Response({"detail": "An OT request already exists for this working date."}, status=409)
        return Response(_serialize_ot(item), status=201)


@method_decorator(csrf_protect, name="dispatch")
class OvertimeReviewView(APIView):
    permission_classes = [AllowAny]

    def post(self, request, request_id, action):
        if not admin_only(request) and not attendance_super_admin(request):
            return Response({"detail": "Only Attendance Super Admin users can review overtime."}, status=403)
        with transaction.atomic():
            item = OvertimeRequest.objects.select_for_update().select_related("employee").filter(pk=request_id).first()
            if not item:
                return Response({"detail": "OT request not found."}, status=404)
            if item.status != OvertimeRequest.STATUS_PENDING:
                return Response({"detail": "This OT request has already been reviewed."}, status=409)
            _, _, _, official, actual = _ot_context(item.employee, item.work_date)
            if action == "approve":
                if not actual:
                    return Response({"detail": "Approval requires a final punch-out record."}, status=400)
                item.actual_punch_out = actual
                item.approved_minutes = _ot_minutes(official, actual)
                item.status = OvertimeRequest.STATUS_APPROVED
            elif action == "reject":
                item.status = OvertimeRequest.STATUS_REJECTED
                item.rejection_message = str(request.data.get("message", "")).strip()
                if not item.rejection_message:
                    return Response({"detail": "Enter a rejection reason."}, status=400)
            else:
                return Response({"detail": "Unknown review action."}, status=400)
            item.reviewed_by = request.user
            item.reviewed_at = timezone.now()
            item.save(update_fields=["actual_punch_out", "approved_minutes", "status", "rejection_message", "reviewed_by", "reviewed_at", "updated_at"])
            text = "approved" if item.status == OvertimeRequest.STATUS_APPROVED else "rejected"
            Reminder.objects.create(owner=item.employee, text=f"Your OT request for {item.work_date} was {text}." + (f" {item.rejection_message}" if item.rejection_message else ""), reminder_at=timezone.now())
        return Response(_serialize_ot(item))


@method_decorator(csrf_protect, name="dispatch")
class LoginView(APIView):
    permission_classes = [AllowAny]

    def post(self, request):
        username = request.data.get("username", "")
        password = request.data.get("password", "")
        if "@" in username:
            email_match = User.objects.filter(email__iexact=username, is_active=True).first()
            if email_match:
                username = email_match.get_username()
        user = authenticate(request, username=username, password=password)
        if user is None:
            return Response(
                {"detail": "Invalid username or password."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not user.is_active:
            return Response(
                {"detail": "This account is inactive."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        login(request, user)
        return Response({"user": UserSerializer(user).data})


class LogoutView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class DashboardView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        datasets = get_accessible_datasets(request.user)
        customer_records = CustomerRecord.objects.filter(dataset__in=datasets)
        visits = get_accessible_visits(request.user)
        today = timezone.localdate()
        response_counts = {
            row["response"]: row["count"]
            for row in customer_records.values("response").annotate(count=Count("id"))
        }
        response_stats = [
            {
                "value": value,
                "label": label,
                "count": response_counts.get(value, 0),
            }
            for value, label in CustomerRecord.RESPONSE_CHOICES
        ]
        payment_totals = visits.aggregate(
            total_amount=Sum("total_amount"),
            paid_amount=Sum("paid_amount"),
        )
        total_amount = payment_totals["total_amount"] or 0
        paid_amount = payment_totals["paid_amount"] or 0
        recent_datasets = datasets.annotate(customer_count=Count("records"))[:3]
        return Response(
            {
                "totalDatasets": datasets.count(),
                "totalCustomers": customer_records.count(),
                "responseStats": response_stats,
                "recentDatasets": DatasetListSerializer(recent_datasets, many=True).data,
                "payments": {
                    "totalAmount": total_amount,
                    "paidAmount": paid_amount,
                    "pendingAmount": max(total_amount - paid_amount, 0),
                    "paidCount": visits.filter(paid_amount__gt=0).count(),
                    "pendingCount": visits.filter(total_amount__gt=F("paid_amount")).count(),
                    "oneTimeCount": visits.filter(payment_status=Visit.PAYMENT_ONE_TIME).count(),
                    "completedCount": visits.filter(payment_status=Visit.PAYMENT_COMPLETED).count(),
                },
                "sales": {
                    "totalVisits": visits.count(),
                    "todaysVisits": visits.filter(visit_date=today).count(),
                    "monthVisits": visits.filter(
                        visit_date__year=today.year,
                        visit_date__month=today.month,
                    ).count(),
                    "totalVisitExpenses": visits.aggregate(total=Sum("expense"))["total"] or 0,
                },
            }
        )


class DatasetListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        datasets = get_accessible_datasets(request.user).select_related("owner").annotate(
            customer_count=Count("records")
        )
        return Response({"results": DatasetListSerializer(datasets, many=True).data})


class DatasetManagementView(APIView):
    permission_classes = [IsAuthenticated]

    def get_dataset(self, request, dataset_id):
        return get_object_or_404(
            get_accessible_datasets(request.user).annotate(customer_count=Count("records")),
            pk=dataset_id,
        )

    def patch(self, request, dataset_id):
        dataset = self.get_dataset(request, dataset_id)
        form = DatasetForm(request.data, instance=dataset)
        if not form.is_valid():
            return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        dataset = form.save()
        dataset.customer_count = dataset.records.count()
        return Response(DatasetListSerializer(dataset).data)

    def delete(self, request, dataset_id):
        dataset = self.get_dataset(request, dataset_id)
        dataset.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DatasetDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, dataset_id):
        columns_queryset = DatasetColumn.objects.order_by("sheet_name", "order")
        dataset = get_object_or_404(
            get_accessible_datasets(request.user)
            .prefetch_related(Prefetch("columns", queryset=columns_queryset))
            .annotate(customer_count=Count("records")),
            pk=dataset_id,
        )
        search_query = request.GET.get("q", "").strip()
        response_filter = request.GET.get("response", "").strip()
        records = get_filtered_records(dataset, search_query, response_filter)
        paginator = Paginator(records, 20)
        page_obj = paginator.get_page(request.GET.get("page"))
        columns_by_sheet = group_columns_by_sheet(dataset.columns.all())
        records_by_sheet = build_records_by_sheet(page_obj.object_list, columns_by_sheet)
        return Response(
            {
                "dataset": DatasetListSerializer(dataset).data,
                "responseChoices": [
                    {"value": value, "label": label}
                    for value, label in CustomerRecord.RESPONSE_CHOICES
                ],
                "responseStats": get_dataset_response_stats(dataset),
                "recordsBySheet": [
                    {
                        "sheetName": sheet["sheet_name"],
                        "columns": [
                            {
                                "id": column.id,
                                "originalName": column.original_name,
                                "fieldKey": column.field_key,
                            }
                            for column in sheet["columns"]
                        ],
                        "records": [
                            {
                                "record": CustomerRecordSerializer(item["record"]).data,
                                "values": item["values"],
                            }
                            for item in sheet["records"]
                        ],
                    }
                    for sheet in records_by_sheet
                ],
                "filters": {
                    "search": search_query,
                    "response": response_filter,
                    "active": bool(search_query or response_filter),
                    "filteredCount": paginator.count,
                },
                "pagination": {
                    "page": page_obj.number,
                    "numPages": paginator.num_pages,
                    "count": paginator.count,
                    "hasNext": page_obj.has_next(),
                    "hasPrevious": page_obj.has_previous(),
                    "nextPage": page_obj.next_page_number() if page_obj.has_next() else None,
                    "previousPage": page_obj.previous_page_number() if page_obj.has_previous() else None,
                    "pageRange": list(paginator.page_range),
                },
            }
        )


class CustomerDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, dataset_id, record_id):
        dataset, record = get_dataset_record(request.user, dataset_id, record_id)
        columns = get_record_columns(dataset, record)
        return Response(
            {
                "dataset": DatasetListSerializer(dataset).data,
                "record": CustomerRecordSerializer(record).data,
                "fieldRows": build_field_rows(record, columns),
                "changeHistory": customer_change_history(record),
                "responseChoices": [
                    {"value": value, "label": label}
                    for value, label in CustomerRecord.RESPONSE_CHOICES
                ],
            }
        )

    def patch(self, request, dataset_id, record_id):
        dataset, record = get_dataset_record(request.user, dataset_id, record_id)
        previous_values = customer_crm_values(record)
        form = CustomerCRMForm(request.data, instance=record)
        if not form.is_valid():
            return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        record = save_customer_crm_change(form, request.user, previous_values)
        columns = get_record_columns(dataset, record)
        return Response(
            {
                "dataset": DatasetListSerializer(dataset).data,
                "record": CustomerRecordSerializer(record).data,
                "fieldRows": build_field_rows(record, columns),
                "changeHistory": customer_change_history(record),
            }
        )

    def delete(self, request, dataset_id, record_id):
        _, record = get_dataset_record(request.user, dataset_id, record_id)
        record.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class CustomerByIdView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, record_id):
        record = get_object_or_404(
            CustomerRecord.objects.filter(dataset__in=get_accessible_datasets(request.user))
            .select_related("dataset"),
            pk=record_id,
        )
        columns = get_record_columns(record.dataset, record)
        return Response(
            {
                "dataset": DatasetListSerializer(record.dataset).data,
                "record": CustomerRecordSerializer(record).data,
                "fieldRows": build_field_rows(record, columns),
                "changeHistory": customer_change_history(record),
                "responseChoices": [
                    {"value": value, "label": label}
                    for value, label in CustomerRecord.RESPONSE_CHOICES
                ],
            }
        )


class CustomerListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        records = list(CustomerRecord.objects.filter(
            dataset__in=get_accessible_datasets(request.user),
        ).select_related("dataset").order_by(
            "-dataset__uploaded_at",
            "dataset_id",
            "sheet_name",
            "row_number",
            "id",
        ))
        search_query = request.query_params.get("q", "").strip()
        if search_query:
            normalized_query = search_query.casefold()
            records = [
                record for record in records
                if normalized_query in record.display_name.casefold()
            ]

        response_counts = Counter(record.response for record in records)
        status_filter = request.query_params.get("status", "").strip()
        if status_filter not in dict(CustomerRecord.RESPONSE_CHOICES):
            status_filter = ""

        if status_filter:
            records = [record for record in records if record.response == status_filter]
        paginator = Paginator(records, 50)
        page_obj = paginator.get_page(request.query_params.get("page", 1))
        page_records = list(page_obj.object_list)

        dataset_ids = {record.dataset_id for record in page_records}
        column_map = {}
        for column in DatasetColumn.objects.filter(dataset_id__in=dataset_ids).order_by(
            "dataset_id", "sheet_name", "order"
        ):
            column_map.setdefault((column.dataset_id, column.sheet_name), []).append(column)

        results = []
        for record in page_records:
            results.append({
                "record": CustomerRecordSerializer(record).data,
                "datasetId": record.dataset_id,
                "datasetName": record.dataset.name,
                "fieldRows": build_field_rows(
                    record,
                    column_map.get((record.dataset_id, record.sheet_name), []),
                ),
            })

        return Response({
            "results": results,
            "searchQuery": search_query,
            "selectedStatus": status_filter,
            "statusOptions": [
                {
                    "value": value,
                    "label": label,
                    "count": response_counts.get(value, 0),
                }
                for value, label in CustomerRecord.RESPONSE_CHOICES
            ],
            "totalCount": sum(response_counts.values()),
            "pagination": {
                "page": page_obj.number,
                "pageSize": 50,
                "numPages": paginator.num_pages,
                "count": paginator.count,
                "hasNext": page_obj.has_next(),
                "hasPrevious": page_obj.has_previous(),
                "nextPage": page_obj.next_page_number() if page_obj.has_next() else None,
                "previousPage": page_obj.previous_page_number() if page_obj.has_previous() else None,
            },
        })


class CallbackListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        today = timezone.localdate()
        tomorrow = today + timedelta(days=1)
        accessible_records = CustomerRecord.objects.filter(
            dataset__in=get_accessible_datasets(request.user),
        ).select_related("dataset", "callback_completed_by")
        callbacks = accessible_records.filter(
            response=CustomerRecord.RESPONSE_CALLBACK,
            callback_completed_at__isnull=True,
        )
        called_back = accessible_records.filter(callback_completed_at__isnull=False)

        today_count = callbacks.filter(callback_date=today).count()
        tomorrow_count = callbacks.filter(callback_date=tomorrow).count()
        preset = request.query_params.get("preset", "today").strip().lower()
        date_value = request.query_params.get("date", "").strip()
        selected_date = None

        if preset == "called_back" and not date_value:
            callbacks = called_back
            selected_date = None
        elif date_value:
            selected_date = parse_date(date_value)
            if selected_date is None:
                return Response({"detail": "Enter a valid callback date."}, status=status.HTTP_400_BAD_REQUEST)
            preset = "custom"
        elif preset == "today":
            selected_date = today
        elif preset == "tomorrow":
            selected_date = tomorrow
        elif preset != "all":
            preset = "today"
            selected_date = today

        if selected_date:
            callbacks = callbacks.filter(callback_date=selected_date)

        sort = request.query_params.get("sort", "asc").strip().lower()
        if preset == "called_back":
            callbacks = callbacks.order_by("-updated_at", "-id")
        elif sort == "desc":
            callbacks = callbacks.order_by(F("callback_date").desc(nulls_last=True), "-updated_at", "-id")
        else:
            sort = "asc"
            callbacks = callbacks.order_by(F("callback_date").asc(nulls_last=True), "updated_at", "id")

        return Response({
            "results": [callback_payload(record) for record in callbacks],
            "counts": {
                "today": today_count,
                "tomorrow": tomorrow_count,
                "total": CustomerRecord.objects.filter(
                    dataset__in=get_accessible_datasets(request.user),
                    response=CustomerRecord.RESPONSE_CALLBACK,
                    callback_completed_at__isnull=True,
                ).count(),
                "calledBack": called_back.count(),
            },
            "filters": {
                "preset": preset,
                "date": selected_date,
                "sort": sort,
                "today": today,
                "tomorrow": tomorrow,
            },
            "outcomeChoices": [
                {"value": value, "label": label}
                for value, label in CustomerRecord.RESPONSE_CHOICES
                if value != CustomerRecord.RESPONSE_CALLBACK
            ],
        })


class CallbackCompleteView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, record_id):
        record = get_object_or_404(
            CustomerRecord.objects.filter(dataset__in=get_accessible_datasets(request.user)),
            pk=record_id,
        )
        if record.response != CustomerRecord.RESPONSE_CALLBACK or record.callback_completed_at:
            return Response({"detail": "This callback is no longer pending."}, status=status.HTTP_400_BAD_REQUEST)

        outcome = (request.data.get("response") or "").strip()
        allowed_outcomes = {
            value for value, _ in CustomerRecord.RESPONSE_CHOICES
            if value != CustomerRecord.RESPONSE_CALLBACK
        }
        if outcome not in allowed_outcomes:
            return Response({"errors": {"response": ["Choose a valid callback outcome."]}}, status=status.HTTP_400_BAD_REQUEST)

        previous_values = customer_crm_values(record)
        with transaction.atomic():
            record.response = outcome
            record.callback_completed_at = timezone.now()
            record.callback_completed_by = request.user
            record.save(update_fields=["response", "callback_completed_at", "callback_completed_by", "updated_at"])
            CustomerRecordChange.objects.create(
                record=record,
                changed_by=request.user,
                previous_values=previous_values,
                updated_values=customer_crm_values(record),
            )

        return Response({
            "record": CustomerRecordSerializer(record).data,
            "callback": callback_payload(record),
            "changeHistory": customer_change_history(record),
        })


class ExcelInspectView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        form = ExcelUploadForm(request.POST, request.FILES)
        if not form.is_valid():
            return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)

        uploaded_file = form.cleaned_data["excel_file"]
        dataset_name = form.cleaned_data["dataset_name"]

        try:
            inspection = inspect_workbook(uploaded_file)
            pending_import_token = save_pending_upload(request, uploaded_file, dataset_name)
        except ImportError:
            return Response(
                {"detail": "Excel inspection requires pandas and openpyxl. Install the packages in requirements.txt and try again."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        except zipfile.BadZipFile:
            return Response(
                {"detail": "The uploaded file is not a readable .xlsx workbook."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ValueError as exc:
            return Response(
                {"detail": f"Could not inspect this workbook: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception:
            return Response(
                {"detail": "Something went wrong while reading the workbook. Please check that the file is not corrupted."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "datasetName": dataset_name,
                "pendingImportToken": pending_import_token,
                "inspection": inspection,
            }
        )


class ExcelConfirmImportView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        token = request.data.get("pendingImportToken") or request.data.get("pending_import_token") or ""
        pending_upload = get_pending_upload(request, token)

        if not pending_upload:
            return Response(
                {"detail": "The pending import could not be found. Please upload the Excel file again."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            with open(pending_upload["path"], "rb") as workbook_file:
                inspection = inspect_workbook(workbook_file, filename=pending_upload["filename"])
            dataset, import_summary = create_dataset_from_inspection(
                request.user,
                pending_upload["dataset_name"],
                inspection,
            )
            import_summary["dataset_id"] = dataset.id
            import_summary["dataset_name"] = dataset.name
            dataset.customer_count = dataset.records.count()
            delete_pending_upload(request, token)
        except ImportError:
            return Response(
                {"detail": "Excel import requires pandas and openpyxl. Install the packages in requirements.txt and try again."},
                status=status.HTTP_500_INTERNAL_SERVER_ERROR,
            )
        except FileNotFoundError:
            delete_pending_upload(request, token)
            return Response(
                {"detail": "The temporary uploaded file was not found. Please upload it again."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except zipfile.BadZipFile:
            delete_pending_upload(request, token)
            return Response(
                {"detail": "The uploaded file is not a readable .xlsx workbook."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except ValueError as exc:
            return Response(
                {"detail": f"Could not import this workbook: {exc}"},
                status=status.HTTP_400_BAD_REQUEST,
            )
        except Exception:
            return Response(
                {"detail": "Something went wrong while importing the workbook. Please check that the file is not corrupted."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response(
            {
                "dataset": DatasetListSerializer(dataset).data,
                "summary": import_summary,
            },
            status=status.HTTP_201_CREATED,
        )


class DatasetExportView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, dataset_id):
        columns_queryset = DatasetColumn.objects.order_by("sheet_name", "order")
        dataset = get_object_or_404(
            get_accessible_datasets(request.user).prefetch_related(
                Prefetch("columns", queryset=columns_queryset),
            ),
            pk=dataset_id,
        )
        search_query = request.GET.get("q", "").strip()
        response_filter = request.GET.get("response", "").strip()
        records = get_filtered_records(dataset, search_query, response_filter)
        workbook = build_dataset_export_workbook(dataset, records)

        output = io.BytesIO()
        workbook.save(output)
        output.seek(0)

        filename = f"{safe_export_filename(dataset.name)}.xlsx"
        response = HttpResponse(
            output.getvalue(),
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        response["Content-Disposition"] = f'attachment; filename="{filename}"'
        return response


class VisitListView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def get(self, request):
        status_filter = request.query_params.get("status", "").strip()
        try:
            date_from = parse_date(request.query_params.get("date_from", ""))
        except ValueError:
            date_from = None
        try:
            date_to = parse_date(request.query_params.get("date_to", ""))
        except ValueError:
            date_to = None
        visits = get_accessible_visits(request.user).select_related(
            "customer",
            "customer__dataset",
            "manual_client",
            "manual_client__owner",
        ).prefetch_related("images")
        if status_filter in dict(Visit.STATUS_CHOICES):
            visits = visits.filter(status=status_filter)
        if date_from:
            visits = visits.filter(visit_date__gte=date_from)
        if date_to:
            visits = visits.filter(visit_date__lte=date_to)
        return Response({"results": VisitSerializer(visits, many=True).data})

    def post(self, request):
        mode = request.data.get("visit_mode", "existing")
        if mode == "manual":
            form = ManualVisitForm(request.data, request.FILES, owner=request.user)
        else:
            datasets = get_accessible_datasets(request.user)
            selected = datasets.filter(pk=request.data.get("dataset")).first()
            form = VisitForm(
                request.data,
                request.FILES,
                datasets=datasets,
                selected_dataset=selected,
                customer_search=request.data.get("customer_search", ""),
            )
        if not form.is_valid():
            return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        visit = form.save()
        save_visit_images(visit, form.cleaned_data["images"])
        visit = get_accessible_visits(request.user).select_related(
            "customer", "customer__dataset", "manual_client"
        ).prefetch_related("images").get(pk=visit.pk)
        return Response(visit_detail_payload(visit), status=status.HTTP_201_CREATED)


class VisitClientsView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        dataset = get_object_or_404(
            get_accessible_datasets(request.user), pk=request.GET.get("dataset")
        )
        records = get_visit_customer_options(dataset, request.GET.get("q", "").strip())
        return Response({
            "results": [
                {
                    "id": record.id,
                    "label": record.display_name,
                    "sheetName": record.sheet_name,
                    "rowNumber": record.row_number,
                }
                for record in records
            ]
        })


class VisitDetailView(APIView):
    permission_classes = [IsAuthenticated]
    parser_classes = [JSONParser, FormParser, MultiPartParser]

    def get_visit(self, request, visit_id):
        return get_object_or_404(
            get_accessible_visits(request.user).select_related(
                "customer", "customer__dataset", "manual_client"
            ).prefetch_related("images"), pk=visit_id
        )

    def get(self, request, visit_id):
        return Response(visit_detail_payload(self.get_visit(request, visit_id)))

    def patch(self, request, visit_id):
        visit = self.get_visit(request, visit_id)
        if visit.manual_client_id:
            form = ManualVisitForm(
                request.data,
                request.FILES,
                instance=visit,
                owner=visit.manual_client.owner,
            )
        else:
            datasets = get_accessible_datasets(request.user)
            selected = datasets.filter(pk=request.data.get("dataset")).first() or visit.customer.dataset
            form = VisitForm(
                request.data,
                request.FILES,
                instance=visit,
                datasets=datasets,
                selected_dataset=selected,
                customer_search=request.data.get("customer_search", ""),
            )
        if not form.is_valid():
            return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        visit = form.save()
        save_visit_images(visit, form.cleaned_data["images"])
        visit = self.get_visit(request, visit.pk)
        return Response(visit_detail_payload(visit))

    def delete(self, request, visit_id):
        visit = self.get_visit(request, visit_id)
        visit.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class VisitImageView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, visit_id, image_id):
        visit = get_object_or_404(get_accessible_visits(request.user), pk=visit_id)
        image = get_object_or_404(VisitImage, visit=visit, pk=image_id)
        response = FileResponse(
            image.image.open("rb"),
            content_type=mimetypes.guess_type(image.image.name)[0] or "application/octet-stream",
        )
        response["Content-Disposition"] = "inline"
        response["X-Content-Type-Options"] = "nosniff"
        return response


class PushConfigView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        if not settings.WEBPUSH_VAPID_PUBLIC_KEY or not settings.WEBPUSH_VAPID_PRIVATE_KEY:
            return Response({"detail": "Browser notifications are not configured on the server."}, status=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response({"publicKey": settings.WEBPUSH_VAPID_PUBLIC_KEY})


class PushSubscriptionView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({"enabled": PushSubscription.objects.filter(owner=request.user).exists()})

    def post(self, request):
        endpoint = request.data.get("endpoint")
        keys = request.data.get("keys") or {}
        p256dh = keys.get("p256dh")
        auth = keys.get("auth")
        if not all(isinstance(value, str) and value for value in (endpoint, p256dh, auth)):
            return Response({"detail": "A valid browser push subscription is required."}, status=status.HTTP_400_BAD_REQUEST)
        subscription, _ = PushSubscription.objects.update_or_create(
            endpoint=endpoint,
            defaults={"owner": request.user, "p256dh": p256dh, "auth": auth},
        )
        return Response({"enabled": True}, status=status.HTTP_201_CREATED)

    def delete(self, request):
        endpoint = request.data.get("endpoint")
        if endpoint:
            PushSubscription.objects.filter(owner=request.user, endpoint=endpoint).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReminderListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        reminders = Reminder.objects.filter(owner=request.user)
        return Response({"results": ReminderSerializer(reminders, many=True).data})

    def post(self, request):
        serializer = ReminderSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({"errors": serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        reminder = serializer.save(owner=request.user)
        return Response(ReminderSerializer(reminder).data, status=status.HTTP_201_CREATED)


class ReminderDeliveryStatusView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        now = timezone.now()
        reminders = Reminder.objects.filter(owner=request.user)
        subscriptions = PushSubscription.objects.filter(owner=request.user)
        due_unsent = reminders.filter(reminder_at__lte=now, sent_at__isnull=True).count()
        retrying = reminders.filter(delivery_status=Reminder.DELIVERY_RETRYING).count()
        failed = reminders.filter(delivery_status__in=[Reminder.DELIVERY_FAILED, Reminder.DELIVERY_NO_SUBSCRIPTIONS]).count()
        last_attempt = reminders.exclude(last_delivery_attempt_at__isnull=True).order_by("-last_delivery_attempt_at").first()
        return Response({
            "pushSubscriptions": subscriptions.count(),
            "dueUnsent": due_unsent,
            "retrying": retrying,
            "failed": failed,
            "lastAttemptAt": last_attempt.last_delivery_attempt_at if last_attempt else None,
            "workerRequired": True,
        })


class ReminderDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def put(self, request, reminder_id):
        return self.update(request, reminder_id)

    def patch(self, request, reminder_id):
        return self.update(request, reminder_id)

    def update(self, request, reminder_id):
        reminder = get_object_or_404(Reminder, pk=reminder_id, owner=request.user)
        previous_reminder_at = reminder.reminder_at
        serializer = ReminderSerializer(reminder, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response({"errors": serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        reminder = serializer.save()
        if reminder.reminder_at != previous_reminder_at:
            reminder.deliveries.all().delete()
            Reminder.objects.filter(pk=reminder.pk).update(
                sent_at=None,
                delivery_status=Reminder.DELIVERY_PENDING,
                delivery_attempt_count=0,
                last_delivery_attempt_at=None,
                next_delivery_attempt_at=None,
                delivery_locked_at=None,
                last_delivery_error="",
            )
        return Response(ReminderSerializer(reminder).data)

    def delete(self, request, reminder_id):
        reminder = get_object_or_404(Reminder, pk=reminder_id, owner=request.user)
        reminder.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class AssignedTaskListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        tasks = AssignedTask.objects.filter(assignee=request.user).select_related("assignee", "assigned_by")
        return Response({"results": AssignedTaskSerializer(tasks, many=True).data})


class AssignedTaskDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def patch(self, request, task_id):
        task = get_object_or_404(AssignedTask, pk=task_id, assignee=request.user)
        status_value = request.data.get("status")
        if status_value not in dict(AssignedTask.STATUS_CHOICES):
            return Response({"detail": "Choose a valid task status."}, status=status.HTTP_400_BAD_REQUEST)
        task.status = status_value
        task.completed_at = timezone.now() if status_value == AssignedTask.STATUS_DONE else None
        task.save(update_fields=["status", "completed_at", "updated_at"])
        return Response(AssignedTaskSerializer(task).data)


class AdminTaskView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def get(self, request):
        denied = self.check_admin(request)
        if denied:
            return denied
        tasks = AssignedTask.objects.select_related("assignee", "assigned_by")
        user_id = request.query_params.get("userId")
        if user_id:
            tasks = tasks.filter(assignee_id=user_id)
        return Response({"results": AssignedTaskSerializer(tasks, many=True).data})

    def post(self, request):
        denied = self.check_admin(request)
        if denied:
            return denied
        assignee_id = request.data.get("assignee")
        assignee = get_object_or_404(User, pk=assignee_id)
        if assignee.is_staff or assignee.is_superuser:
            return Response(
                {"detail": "Tasks can only be assigned to normal users."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        serializer = AssignedTaskSerializer(data=request.data)
        if not serializer.is_valid():
            return Response({"errors": serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        task = serializer.save(assigned_by=request.user)
        return Response(AssignedTaskSerializer(task).data, status=status.HTTP_201_CREATED)


class AdminTaskDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def patch(self, request, task_id):
        denied = self.check_admin(request)
        if denied:
            return denied
        task = get_object_or_404(AssignedTask, pk=task_id)
        serializer = AssignedTaskSerializer(task, data=request.data, partial=True)
        if not serializer.is_valid():
            return Response({"errors": serializer.errors}, status=status.HTTP_400_BAD_REQUEST)
        task = serializer.save(
            completed_at=(
                timezone.now()
                if serializer.validated_data.get("status") == AssignedTask.STATUS_DONE
                else None
                if serializer.validated_data.get("status") == AssignedTask.STATUS_PENDING
                else task.completed_at
            )
        )
        return Response(AssignedTaskSerializer(task).data)


class SalesSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        visits = get_accessible_visits(request.user)
        today = timezone.localdate()
        return Response({
            "totalVisits": visits.count(),
            "todaysVisits": visits.filter(visit_date=today).count(),
            "monthVisits": visits.filter(visit_date__year=today.year, visit_date__month=today.month).count(),
            "totalVisitExpenses": visits.aggregate(total=Sum("expense"))["total"] or 0,
        })


def get_sales_target_percentage(target):
    if target.month.month == 12:
        next_month = target.month.replace(year=target.month.year + 1, month=1, day=1)
    else:
        next_month = target.month.replace(month=target.month.month + 1, day=1)

    converted_count = Visit.objects.filter(
        Q(customer__dataset__owner=target.user) | Q(manual_client__owner=target.user),
        status=Visit.STATUS_CONVERTED,
        visit_date__gte=target.month,
        visit_date__lt=next_month,
    ).count()
    percentage = round((converted_count / target.target) * 100) if target.target else 0

    return converted_count, percentage


def get_sales_target_payload(target):
    converted_count, percentage = get_sales_target_percentage(target)
    if percentage <= 30:
        status_color = "danger"
    elif percentage <= 70:
        status_color = "primary"
    else:
        status_color = "success"

    low_target_count = 0
    for user_target in target.user.sales_targets.all():
        target_percentage = percentage if user_target.pk == target.pk else get_sales_target_percentage(user_target)[1]
        if target_percentage <= 30:
            low_target_count += 1

    return {
        "id": target.id,
        "userId": target.user_id,
        "username": target.user.username,
        "month": target.month.isoformat()[:7],
        "monthLabel": target.month.strftime("%B %Y"),
        "datasetId": None,
        "datasetName": "",
        "target": target.target,
        "converted": converted_count,
        "percentage": percentage,
        "statusColor": status_color,
        "lowTargetCount": low_target_count,
        "needsWarning": low_target_count >= 3,
        "warningMessage": (
            f"{target.user.username} has already failed to achieve at least 30% of the assigned target "
            f"{low_target_count} times. Schedule a meeting and review this user's continuation."
            if low_target_count >= 3
            else ""
        ),
    }


class UserTargetListView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        targets = SalesTarget.objects.filter(user=request.user).select_related("user")
        return Response({
            "results": [
                get_sales_target_payload(target)
                for target in targets
            ]
        })


class AdminTargetView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response(
                {"detail": "Administrator access required."},
                status=status.HTTP_403_FORBIDDEN,
            )
        return None

    def post(self, request):
        denied = self.check_admin(request)
        if denied:
            return denied
        user_id = request.data.get("userId")
        month_value = request.data.get("month")
        target_value = request.data.get("target")

        if not month_value:
            return Response(
                {"detail": "Select a month for this target."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if not user_id:
            return Response(
                {"detail": "Select a sales user."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        user = get_object_or_404(User, pk=user_id)
        target_month = parse_date(f"{month_value}-01" if len(str(month_value)) == 7 else str(month_value))
        if not target_month:
            return Response(
                {"detail": "Choose a valid target month."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        target_month = target_month.replace(day=1)

        # Admin users cannot receive a sales target.
        if user.is_staff or user.is_superuser:
            return Response(
                {"detail": "Targets can only be assigned to sales users."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            target_value = int(target_value)
        except (TypeError, ValueError):
            return Response(
                {"detail": "Target must be a positive whole number."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if target_value <= 0:
            return Response(
                {"detail": "Target must be greater than zero."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        target, created = SalesTarget.objects.update_or_create(
            user=user,
            month=target_month,
            defaults={"target": target_value, "dataset": None},
        )

        return Response(get_sales_target_payload(target), status=status.HTTP_200_OK)

    def get(self, request):
        denied = self.check_admin(request)
        if denied:
            return denied
        targets = (
            SalesTarget.objects
            .select_related("user")
            .prefetch_related("user__sales_targets")
        )

        return Response([
            get_sales_target_payload(target)
            for target in targets
        ])

    def patch(self, request, target_id):
        denied = self.check_admin(request)
        if denied:
            return denied
        target = get_object_or_404(
            SalesTarget,
            pk=target_id,
        )

        target_value = request.data.get("target")

        try:
            target_value = int(target_value)
        except (TypeError, ValueError):
            return Response(
                {"detail": "Target must be a positive whole number."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if target_value <= 0:
            return Response(
                {"detail": "Target must be greater than zero."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        target.target = target_value
        target.save(update_fields=["target"])

        target = SalesTarget.objects.select_related("user").prefetch_related("user__sales_targets").get(pk=target.pk)
        return Response(get_sales_target_payload(target))
class AdminSummaryView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def get(self, request):
        denied = self.check_admin(request)
        if denied: return denied
        users = User.objects.annotate(dataset_count=Count("datasets", distinct=True), customer_count=Count("datasets__records", distinct=True)).order_by("username")
        datasets = Dataset.objects.select_related("owner").annotate(customer_count=Count("records"))[:5]
        recent_users = User.objects.order_by("-date_joined")[:5]
        return Response({
            "metrics": {"totalUsers": User.objects.count(), "activeUsers": User.objects.filter(is_active=True).count(), "totalDatasets": Dataset.objects.count(), "totalCustomers": CustomerRecord.objects.count()},
            "users": [admin_user_payload(user) for user in users],
            "recentDatasets": DatasetListSerializer(datasets, many=True).data,
            "recentUsers": [admin_user_payload(user) for user in recent_users],
        })


def admin_user_payload(user):
    return {
        **UserSerializer(user).data,
        "email": user.email,
        "is_active": user.is_active,
        "date_joined": user.date_joined,
        "dataset_count": getattr(user, "dataset_count", user.datasets.count()),
        "customer_count": getattr(user, "customer_count", CustomerRecord.objects.filter(dataset__owner=user).count()),
    }


class AdminUserView(APIView):
    permission_classes = [IsAuthenticated]

    def get_user(self, user_id):
        return get_object_or_404(User.objects.annotate(dataset_count=Count("datasets", distinct=True), customer_count=Count("datasets__records", distinct=True)), pk=user_id)

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def get(self, request, user_id=None):
        denied = self.check_admin(request)
        if denied:
            return denied
        if user_id is None:
            users = User.objects.annotate(dataset_count=Count("datasets", distinct=True), customer_count=Count("datasets__records", distinct=True)).order_by("username")
            return Response({"results": [admin_user_payload(user) for user in users]})
        return Response(admin_user_payload(self.get_user(user_id)))

    def post(self, request, user_id=None):
        denied = self.check_admin(request)
        if denied:
            return denied
        form = AdminUserCreateForm(request.data)
        if not form.is_valid(): return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(admin_user_payload(form.save()), status=status.HTTP_201_CREATED)

    def patch(self, request, user_id):
        denied = self.check_admin(request)
        if denied:
            return denied
        user = self.get_user(user_id)
        form = AdminUserEditForm(request.data, instance=user)
        if user == request.user and request.data.get("is_active") in (False, "false", "0"):
            form.add_error("is_active", "You cannot deactivate your own administrator account.")
        if not form.is_valid(): return Response({"errors": serialize_form_errors(form)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(admin_user_payload(form.save()))


class AdminUserActionView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def post(self, request, user_id, action):
        denied = self.check_admin(request)
        if denied:
            return denied
        user = get_object_or_404(User, pk=user_id)
        if action == "toggle-active":
            if user == request.user: return Response({"detail": "You cannot change your own active status here."}, status=400)
            user.is_active = not user.is_active; user.save(update_fields=["is_active"])
        elif action == "password":
            if user.is_staff or user.is_superuser: return Response({"detail": "Password reset is available for normal CRM users only."}, status=403)
            form = AdminPasswordResetForm(request.data, user=user)
            if not form.is_valid(): return Response({"errors": serialize_form_errors(form)}, status=400)
            user.set_password(form.cleaned_data["password1"]); user.save(update_fields=["password"])
        else: return Response({"detail": "Unknown action."}, status=404)
        return Response(admin_user_payload(user))


class AdminUserDatasetsView(APIView):
    permission_classes = [IsAuthenticated]

    def check_admin(self, request):
        if not admin_only(request):
            return Response({"detail": "Administrator access required."}, status=status.HTTP_403_FORBIDDEN)
        return None

    def get(self, request, user_id):
        denied = self.check_admin(request)
        if denied:
            return denied
        user = get_object_or_404(User, pk=user_id)
        datasets = user.datasets.annotate(customer_count=Count("records")).order_by("-uploaded_at")
        return Response({"user": admin_user_payload(user), "results": DatasetListSerializer(datasets, many=True).data})
