import io
import json
import tempfile
import zipfile
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient

from .attendance_store import attendance_data


class AttendanceTests(TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings_override = override_settings(ATTENDANCE_DB_PATH=Path(self.temp.name) / "attendance.sqlite3")
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        users = get_user_model()
        self.employee = users.objects.create_user(username="EMP001", email="one@example.test", password="test-password")
        self.other = users.objects.create_user(username="other", email="two@example.test", password="test-password")
        self.admin = users.objects.create_user(username="admin", is_staff=True, password="test-password")
        self.client = APIClient()
        with attendance_data(write=True) as data:
            data["users"] = [
                {"id": "old-1", "employeeId": "EMP001", "email": "one@example.test", "name": "Employee One"},
                {"id": "old-2", "employeeId": "EMP002", "email": "two@example.test", "name": "Employee Two"},
                {"id": "old-3", "employeeId": "EMP003", "name": "Not Linked"},
            ]
            data["attendance"] = [
                {"id": str(index), "userId": f"old-{index}", "punchCode": str(index), "timestamp": "2026-10-29 09:30:00"}
                for index in (1, 2, 3)
            ]
            data["attendanceMappings"] = {"1": "old-1", "2": "old-2"}
        self.url = reverse("attendance_api")
        self.mapping_url = reverse("attendance_action", args=["mappings"])

    def test_crm_session_opens_attendance_without_another_login(self):
        self.client.force_login(self.employee)
        response = self.client.get(self.url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual([record["id"] for record in response.data["records"]], ["1"])

    def test_signed_out_requests_are_denied(self):
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_employee_cannot_request_someone_elses_records(self):
        self.client.force_login(self.employee)
        response = self.client.get(self.url, {"userId": f"crm:{self.other.pk}"})
        self.assertEqual([record["id"] for record in response.data["records"]], ["1"])
        self.assertEqual(len(response.data["employees"]), 1)
        self.assertEqual(response.data["punchCodes"], [])

    def test_unique_email_links_existing_employee(self):
        self.client.force_login(self.other)
        self.assertEqual([record["id"] for record in self.client.get(self.url).data["records"]], ["2"])

    def test_ambiguous_identity_is_not_linked(self):
        get_user_model().objects.create_user(username="EMP002", email="different@example.test")
        self.client.force_login(self.other)
        self.assertEqual(self.client.get(self.url).data["records"], [])

    def test_admin_can_filter_all_records(self):
        self.client.force_login(self.admin)
        self.assertEqual(len(self.client.get(self.url).data["records"]), 3)
        response = self.client.get(self.url, {"userId": f"crm:{self.other.pk}"})
        self.assertEqual([record["id"] for record in response.data["records"]], ["2"])
        self.assertEqual(self.client.get(self.url, {"from": "2026-10-30"}).data["records"], [])

    def test_invalid_date_ranges_are_rejected(self):
        self.client.force_login(self.employee)
        for params in [{"from": "not-a-date"}, {"from": "2026-02-31"}, {"from": "2026-10-30", "to": "2026-10-01"}]:
            self.assertEqual(self.client.get(self.url, params).status_code, 400)

    def test_employee_cannot_change_mappings(self):
        self.client.force_login(self.employee)
        self.assertEqual(self.client.post(self.mapping_url, {"punchCode": "3", "userId": f"crm:{self.employee.pk}"}).status_code, 403)

    def test_admin_mapping_persists_and_changes_employee_visibility(self):
        self.client.force_login(self.admin)
        response = self.client.post(self.mapping_url, {"punchCode": "3", "userId": f"crm:{self.employee.pk}"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data["matched"], 1)
        self.client.force_login(self.employee)
        self.assertEqual({record["id"] for record in self.client.get(self.url).data["records"]}, {"1", "3"})

    def test_mapping_requires_known_code_and_employee(self):
        self.client.force_login(self.admin)
        for code, identity in [("missing", f"crm:{self.employee.pk}"), ("3", "missing")]:
            self.assertEqual(self.client.post(self.mapping_url, {"punchCode": code, "userId": identity}).status_code, 400)

    def test_mapping_uses_crm_csrf_protection(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.admin)
        self.assertEqual(client.post(self.mapping_url, {"punchCode": "3", "userId": f"crm:{self.employee.pk}"}).status_code, 403)

    def test_crm_logout_removes_attendance_access(self):
        self.client.force_login(self.employee)
        self.client.logout()
        self.assertIn(self.client.get(self.url).status_code, (401, 403))

    def test_import_is_repeatable_and_does_not_import_credentials(self):
        archive_path = Path(self.temp.name) / "attendance.zip"
        source = {
            "users": [{"id": "new-employee", "employeeId": "EMP004", "passwordHash": "do-not-import"}],
            "attendance": [{"id": "new-punch", "userId": "new-employee", "punchCode": "4", "timestamp": "2026-10-29 10:00:00"}],
        }
        with zipfile.ZipFile(archive_path, "w") as archive:
            archive.writestr("Time sheet/data/app-data.json", json.dumps(source))
        for _ in range(2):
            call_command("import_attendance_zip", str(archive_path), stdout=io.StringIO())
        with attendance_data() as data:
            self.assertEqual(len(data["attendance"]), 4)
            self.assertNotIn("passwordHash", data["users"][-1])
