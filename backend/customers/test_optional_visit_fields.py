from datetime import time

from django.contrib.auth import get_user_model
from django.test import TestCase

from .forms import ManualVisitForm, VisitForm


class OptionalMeetingFieldsTests(TestCase):
    def setUp(self):
        self.owner = get_user_model().objects.create_user(username="optional-visit-owner")
        self.payload = {"client_name": "Test Client", "visit_date": "2026-11-03", "expense": "0", "status": "healthy"}

    def test_create_without_meeting_time_and_location(self):
        form = ManualVisitForm(self.payload, owner=self.owner)
        self.assertTrue(form.is_valid(), form.errors)
        visit = form.save()
        visit.refresh_from_db()
        self.assertIsNone(visit.meeting_time)
        self.assertEqual(visit.location, "")

    def test_edit_can_clear_meeting_fields(self):
        form = ManualVisitForm({**self.payload, "meeting_time": "10:30", "location": "Office"}, owner=self.owner)
        self.assertTrue(form.is_valid(), form.errors)
        visit = form.save()
        self.assertEqual(visit.meeting_time, time(10, 30))
        form = ManualVisitForm({**self.payload, "meeting_time": "", "location": ""}, instance=visit, owner=self.owner)
        self.assertTrue(form.is_valid(), form.errors)
        visit = form.save()
        visit.refresh_from_db()
        self.assertIsNone(visit.meeting_time)
        self.assertEqual(visit.location, "")

    def test_both_forms_render_optional_fields_and_still_validate_values(self):
        for form in [VisitForm(), ManualVisitForm(owner=self.owner)]:
            self.assertFalse(form.fields["meeting_time"].required)
            self.assertFalse(form.fields["location"].required)
            self.assertNotIn("required", form.fields["meeting_time"].widget.attrs)
            self.assertNotIn("required", form.fields["location"].widget.attrs)
            self.assertEqual(form.fields["location"].label, "Meeting Location")
        form = ManualVisitForm({**self.payload, "meeting_time": "25:00"}, owner=self.owner)
        self.assertFalse(form.is_valid())
        self.assertIn("meeting_time", form.errors)
