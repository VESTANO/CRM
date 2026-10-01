import base64

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Generate VAPID keys and save them to the ignored project .env file."

    def handle(self, *args, **options):
        env_path = settings.BASE_DIR / ".env"
        existing = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
        if "WEBPUSH_VAPID_PUBLIC_KEY=" in existing or "WEBPUSH_VAPID_PRIVATE_KEY=" in existing:
            raise CommandError("VAPID keys already exist in .env; refusing to replace them.")

        private_key = ec.generate_private_key(ec.SECP256R1())
        private_der = private_key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
        public_bytes = private_key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        public_key = base64.urlsafe_b64encode(public_bytes).decode("ascii").rstrip("=")
        private_key_value = base64.b64encode(private_der).decode("ascii")
        with env_path.open("a", encoding="utf-8") as env_file:
            if existing and not existing.endswith("\n"):
                env_file.write("\n")
            env_file.write(f"WEBPUSH_VAPID_PUBLIC_KEY={public_key}\n")
            env_file.write(f"WEBPUSH_VAPID_PRIVATE_KEY={private_key_value}\n")
            env_file.write("WEBPUSH_VAPID_SUBJECT=mailto:admin@example.com\n")

        self.stdout.write(self.style.SUCCESS("VAPID keys saved to .env. Restart Django before enabling browser notifications."))
