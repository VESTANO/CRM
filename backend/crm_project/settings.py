from pathlib import Path
import os

from dotenv import load_dotenv


BASE_DIR = Path(__file__).resolve().parents[2]
BACKEND_DIR = BASE_DIR / "backend"
load_dotenv(BASE_DIR / ".env")

SECRET_KEY = "django-insecure-development-key-change-before-production"

DEBUG = True

DEV_LAN_HOST = os.environ.get("DEV_LAN_HOST", "192.168.1.4")

ALLOWED_HOSTS = [
    "localhost",
    "127.0.0.1",
    DEV_LAN_HOST,
]


INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "rest_framework",
    "customers",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
CSRF_TRUSTED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    f"http://{DEV_LAN_HOST}:5173",
]
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
ROOT_URLCONF = "crm_project.urls"
CORS_ALLOW_CREDENTIALS = True
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BACKEND_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "crm_project.wsgi.application"


DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
    }
}


AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]


LANGUAGE_CODE = "en-us"

TIME_ZONE = "Asia/Kolkata"

USE_I18N = True

USE_TZ = True


STATIC_URL = "static/"
STATICFILES_DIRS = [BACKEND_DIR / "static"]
MEDIA_ROOT = BASE_DIR / "media"

WEBPUSH_VAPID_PUBLIC_KEY = os.environ.get("WEBPUSH_VAPID_PUBLIC_KEY", "")
WEBPUSH_VAPID_PRIVATE_KEY = os.environ.get("WEBPUSH_VAPID_PRIVATE_KEY", "")
WEBPUSH_VAPID_SUBJECT = os.environ.get("WEBPUSH_VAPID_SUBJECT", "mailto:admin@example.com")
QZ_TRAY_CERTIFICATE_PATH = Path(os.environ.get(
    "QZ_TRAY_CERTIFICATE_PATH",
    BASE_DIR / "tmp" / "qz-tray" / "digital-certificate.txt",
))
QZ_TRAY_PRIVATE_KEY_PATH = Path(os.environ.get(
    "QZ_TRAY_PRIVATE_KEY_PATH",
    BASE_DIR / "tmp" / "qz-tray" / "private-key.pem",
))

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

FILE_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024

LOGIN_URL = "/legacy-login/"
LOGIN_REDIRECT_URL = "/legacy/"
LOGOUT_REDIRECT_URL = "/legacy-login/"

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}
