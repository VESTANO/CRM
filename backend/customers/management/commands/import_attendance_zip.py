import json
import zipfile

from django.core.management.base import BaseCommand, CommandError

from customers.attendance_store import attendance_data


class Command(BaseCommand):
    help = "Import attendance records from the supplied Time sheet ZIP without importing its logins."

    def add_arguments(self, parser):
        parser.add_argument("archive")

    def handle(self, *args, **options):
        with zipfile.ZipFile(options["archive"]) as archive:
            candidates = [name for name in archive.namelist() if name.endswith("/data/app-data.json")]
            if len(candidates) != 1:
                raise CommandError("Expected one attendance data/app-data.json in the archive.")
            source = json.loads(archive.read(candidates[0]))
        user_fields = ("id", "employeeId", "name", "email", "active", "shiftStartTime", "shiftEndTime")
        record_fields = ("id", "userId", "employeeId", "punchCode", "timestamp", "status", "verifyMode", "serialNumber")
        with attendance_data(write=True) as data:
            # Reimports add new punches while preserving CRM mappings and existing records.
            users = {str(user["id"]): user for user in data["users"]}
            for user in source.get("users", []):
                users.setdefault(str(user["id"]), {key: user[key] for key in user_fields if key in user})
            records = {str(record["id"]): record for record in data["attendance"]}
            before = len(records)
            for record in source.get("attendance", []):
                records.setdefault(str(record["id"]), {key: record[key] for key in record_fields if key in record})
            data["users"] = list(users.values())
            data["attendance"] = list(records.values())
            if not data["settings"]:
                data["settings"] = source.get("settings", {})
            if not data["attendanceDevices"]:
                data["attendanceDevices"] = source.get("attendanceDevices", [])
            for code, identity in source.get("attendanceMappings", {}).items():
                data["attendanceMappings"].setdefault(str(code), identity)
        self.stdout.write(self.style.SUCCESS(f"Imported {len(records) - before} new attendance punches. Attendance passwords were not imported."))
