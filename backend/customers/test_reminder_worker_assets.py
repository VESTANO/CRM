from django.conf import settings
from django.test import SimpleTestCase


class ReminderWorkerAssetTests(SimpleTestCase):
    def test_root_worker_uses_the_same_canonical_source_as_pages(self):
        response = self.client.get("/service-worker.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-cache")
        self.assertEqual(response["Service-Worker-Allowed"], "/")
        actual = b"".join(response.streaming_content)
        self.assertEqual(actual, (settings.BASE_DIR / "frontend/public/service-worker.js").read_bytes())

    def test_imported_worker_core_is_javascript_and_not_the_react_html_fallback(self):
        response = self.client.get("/reminder-worker-core.js")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/javascript")
        self.assertIn(b"createReminderWorker", b"".join(response.streaming_content))
