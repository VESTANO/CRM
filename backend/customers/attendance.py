"""Attendance uses the existing CRM session and permissions."""

from django.contrib.auth import get_user_model
from django.utils.dateparse import parse_date
from django.views.decorators.cache import never_cache
from django.views.decorators.csrf import csrf_exempt
from django.http import HttpResponse
from django.utils import timezone
from datetime import datetime
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from .attendance_store import attendance_data


def _device_timestamp(value):
    value = str(value or "").strip().replace("T", " ")
    for pattern in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%d-%m-%Y %H:%M:%S", "%d-%m-%Y %H:%M"):
        try:
            return datetime.strptime(value, pattern).strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
    return value


def _device_fields(body):
    text = body.decode("utf-8", errors="ignore").strip()
    if not text:
        return []
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        if "=" in line and "&" in line:
            from urllib.parse import parse_qs
            rows.append({key: values[-1] for key, values in parse_qs(line, keep_blank_values=True).items()})
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            rows.append({"PIN": parts[0], "DateTime": parts[1], "Status": parts[2] if len(parts) > 2 else "", "Verify": parts[3] if len(parts) > 3 else ""})
    return rows


@csrf_exempt
def attendance_device_receiver(request):
    """Receive eSSL/ADMS punches directly into CRM without a Vestano login."""
    serial = request.GET.get("SN", "") or request.POST.get("SN", "")
    if request.method == "GET":
        return HttpResponse("GET OPTION FROM: SN=%s\nATTLOGStamp=0\nOPERLOGStamp=0\n\n" % serial, content_type="text/plain")
    rows = _device_fields(request.body)
    if not rows and request.POST:
        rows = [request.POST.dict()]
    added = 0
    with attendance_data(write=True) as data:
        device = next((item for item in data.setdefault("attendanceDevices", []) if item.get("serialNumber") == serial), None)
        if not device:
            device = {"id": f"device:{serial or 'unknown'}", "serialNumber": serial or "UNKNOWN", "name": f"eSSL Device {serial or 'UNKNOWN'}"}
            data["attendanceDevices"].append(device)
        device.update({"ipAddress": request.META.get("REMOTE_ADDR", ""), "lastSeenAt": timezone.now().isoformat()})
        users = data.get("users", [])
        for row in rows:
            code = str(row.get("PIN") or row.get("pin") or row.get("UserID") or row.get("employeeId") or "").strip()
            timestamp = _device_timestamp(row.get("DateTime") or row.get("datetime") or row.get("timestamp"))
            if not code or code.casefold() in {"pin", "userid", "employeeid"} or not timestamp or not timestamp[:4].isdigit():
                continue
            mapped = data.setdefault("attendanceMappings", {}).get(code)
            user = next((item for item in users if item.get("id") == mapped or str(item.get("employeeId", "")).casefold() == code.casefold()), None)
            duplicate = any(item.get("serialNumber") == (serial or "UNKNOWN") and str(item.get("punchCode")) == code and item.get("timestamp") == timestamp for item in data["attendance"])
            if duplicate:
                continue
            data["attendance"].append({"id": f"device:{serial}:{code}:{timestamp}", "userId": user.get("id", "") if user else "", "employeeId": user.get("employeeId", "") if user else code, "punchCode": code, "timestamp": timestamp, "status": row.get("Status", ""), "verifyMode": row.get("Verify", ""), "serialNumber": serial or "UNKNOWN", "raw": request.body.decode("utf-8", errors="ignore"), "receivedAt": timezone.now().isoformat()})
            added += 1
        data.setdefault("settings", {})["attendanceLastSync"] = timezone.now().isoformat()
    return HttpResponse(f"OK\nReceived={added}\n", content_type="text/plain")


def employee_directory(data):
    crm_users = list(get_user_model().objects.filter(is_active=True))
    employees, aliases = {}, {}
    for user in crm_users:
        identity = f"crm:{user.pk}"
        employees[identity] = {
            "id": identity, "employeeId": user.username,
            "name": user.get_full_name() or user.username, "active": True,
            "role": "admin" if user.is_staff or user.is_superuser else "employee",
            "shiftStartTime": "09:30", "shiftEndTime": "17:30",
        }
    for source in data["users"]:
        code = str(source.get("employeeId", "")).casefold()
        email = str(source.get("email", "")).strip().casefold()
        matches = [user for user in crm_users if
                   (code and user.username.casefold() == code) or
                   (email and user.email.strip().casefold() == email)]
        identity = f"crm:{matches[0].pk}" if len(matches) == 1 else f"legacy:{source['id']}"
        aliases[str(source["id"])] = identity
        if identity not in employees:
            employees[identity] = {
                "id": identity, "employeeId": source.get("employeeId", ""),
                "name": source.get("name", ""), "active": source.get("active", True), "role": "employee",
            }
        employees[identity].update({
            "shiftStartTime": source.get("shiftStartTime") or ("09:00" if code == "emp13" else "09:30"),
            "shiftEndTime": source.get("shiftEndTime") or ("17:00" if code == "emp13" else "17:30"),
        })
    for identity, shift in data.get("employeeShifts", {}).items():
        if identity in employees:
            employees[identity].update(shift)
    return employees, aliases


def record_identity(record, data, aliases):
    mapped = data["attendanceMappings"].get(str(record.get("punchCode", "")))
    identity = str(mapped or record.get("userId") or "")
    return aliases.get(identity, identity if identity.startswith(("crm:", "legacy:")) else "")


@never_cache
@api_view(["GET", "POST"])
@permission_classes([IsAuthenticated])
def attendance_api(request, action=""):
    admin = request.user.is_staff or request.user.is_superuser
    own_identity = f"crm:{request.user.pk}"
    if request.method == "POST":
        if action != "mappings":
            return Response({"detail": "Method not allowed."}, status=405)
        if not admin:
            return Response({"detail": "Only CRM administrators can map attendance codes."}, status=403)
        code = str(request.data.get("punchCode", "")).strip()
        identity = str(request.data.get("userId", ""))
        with attendance_data(write=True) as data:
            employees, aliases = employee_directory(data)
            if not code or identity not in employees or not employees[identity]["active"]:
                return Response({"detail": "Select a valid punch code and active employee."}, status=400)
            if not any(str(record.get("punchCode")) == code for record in data["attendance"]):
                return Response({"detail": "Unknown punch code."}, status=400)
            source_record = next(record for record in data["attendance"] if str(record.get("punchCode")) == code)
            original = employees.get(record_identity(source_record, data, aliases), {})
            data.setdefault("employeeShifts", {})[identity] = {
                "shiftStartTime": original.get("shiftStartTime", "09:30"),
                "shiftEndTime": original.get("shiftEndTime", "17:30"),
            }
            data["attendanceMappings"][code] = identity
            matched = sum(str(record.get("punchCode")) == code for record in data["attendance"])
        return Response({"matched": matched, "employee": employees[identity]})
    if action:
        return Response({"detail": "Attendance endpoint not found."}, status=404)
    start, end = request.query_params.get("from", ""), request.query_params.get("to", "")
    try:
        valid_dates = all(not value or parse_date(value) for value in (start, end))
    except ValueError:
        valid_dates = False
    if not valid_dates or (start and end and start > end):
        return Response({"detail": "Choose a valid date range."}, status=400)
    with attendance_data() as data:
        employees, aliases = employee_directory(data)
        all_dates = sorted({str(record.get("timestamp", ""))[:10] for record in data["attendance"] if record.get("timestamp")})
        records = []
        for record in data["attendance"]:
            identity = record_identity(record, data, aliases)
            if not admin and identity != own_identity:
                continue
            if admin and request.query_params.get("userId") and identity != request.query_params["userId"]:
                continue
            date = str(record.get("timestamp", ""))[:10]
            if (start and date < start) or (end and date > end):
                continue
            employee = employees.get(identity, {})
            punch_code = str(record.get("punchCode", "")).strip()
            records.append({**record, "userId": identity,
                            "employeeName": employee.get("name") or f"Unmapped employee (Punch {punch_code})",
                            "employeeId": employee.get("employeeId") or record.get("employeeId", "") or f"Punch {punch_code}"})
        codes = sorted({str(record.get("punchCode", "")) for record in data["attendance"]}) if admin else []
        mappings = []
        for code in codes:
            record = next(record for record in data["attendance"] if str(record.get("punchCode", "")) == code)
            identity = record_identity(record, data, aliases)
            mappings.append({"punchCode": code, "userId": identity, "employeeName": employees.get(identity, {}).get("name", "") or f"Unmapped employee (Punch {code})"})
        return Response({
            "records": sorted(records, key=lambda record: record["timestamp"], reverse=True),
            "employees": list(employees.values()) if admin else [employees[own_identity]],
            "punchCodes": mappings,
            "lastSync": data["settings"].get("attendanceLastSync", ""),
            "source": "Imported attendance records",
            "availableFrom": all_dates[0] if all_dates else "",
            "availableTo": all_dates[-1] if all_dates else "",
            "devices": data.get("attendanceDevices", []),
            "deviceConfig": data.get("settings", {}).get("attendanceDeviceConfig", {}),
        })
