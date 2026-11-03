from datetime import datetime, timedelta, timezone
import unittest
import sys
from unittest.mock import patch

from engine import ReminderEngine
from notifier import safe_base, toast_xml, protect


class NativeReminderTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.reminder = {"id": 1, "delivery_revision": 1, "text": 'Call <client> & check "order"', "reminder_at": (self.now + timedelta(seconds=10)).isoformat()}

    def test_native_schedule_works_without_browser_or_network(self):
        state, shown = {}, []
        engine = ReminderEngine(state, lambda state: None, shown.append)
        engine.sync([self.reminder])
        engine.tick(self.now)
        self.assertFalse(shown)
        engine.tick(self.now + timedelta(seconds=11))
        self.assertEqual(shown, [self.reminder])
        restarted = ReminderEngine(state, lambda state: None, shown.append)
        restarted.tick(self.now + timedelta(seconds=50))
        self.assertEqual(len(shown), 1)
        self.assertIn("1:1", state["receipts"])

    def test_rescheduling_and_deletion_replace_cached_schedule(self):
        shown = []
        engine = ReminderEngine({}, lambda state: None, shown.append)
        engine.sync([self.reminder])
        engine.sync([{**self.reminder, "delivery_revision": 2, "reminder_at": (self.now+timedelta(days=1)).isoformat()}])
        engine.tick(self.now+timedelta(minutes=1))
        self.assertFalse(shown)
        engine.sync([])
        engine.tick(self.now+timedelta(days=2))
        self.assertFalse(shown)

    def test_xml_is_escaped_and_click_opens_the_relevant_reminder(self):
        xml = toast_xml(self.reminder, "https://vestano.github.io/CRM/")
        self.assertIn("Call &lt;client&gt; &amp;", xml)
        self.assertIn("reminders?reminder=1#reminder-1", xml)
        for value in ["javascript:alert(1)", "http://remote.test/", "https://user:secret@example.com/"]:
            with self.assertRaises(ValueError): safe_base(value)

    @unittest.skipUnless(sys.platform == "win32", "Windows DPAPI integration test")
    def test_device_state_is_encrypted_for_the_windows_user(self):
        secret = b'{"token":"test-only","reminders":[]}'
        ciphertext = protect(secret)
        self.assertNotIn(secret, ciphertext)
        self.assertEqual(protect(ciphertext, True), secret)


if __name__ == "__main__": unittest.main()
