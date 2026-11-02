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


if os.environ.get("DB_ENGINE", "postgresql") == "sqlite":
    default_database = {
        "ENGINE": "django.db.backends.sqlite3",
        "NAME": os.environ.get("SQLITE_DB_NAME", BASE_DIR / "db.sqlite3"),
    }
else:
    default_database = {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.environ.get("POSTGRES_DB", "customer_crm"),
        "USER": os.environ.get("POSTGRES_USER", "customer_crm_user"),
        "PASSWORD": os.environ.get("POSTGRES_PASSWORD", ""),
        "HOST": os.environ.get("POSTGRES_HOST", "localhost"),
        "PORT": os.environ.get("POSTGRES_PORT", "5432"),
    }

DATABASES = {
    "default": default_database,
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
LOG_DIR = BASE_DIR / "tmp"
LOG_DIR.mkdir(exist_ok=True)

WEBPUSH_VAPID_PUBLIC_KEY = os.environ.get("WEBPUSH_VAPID_PUBLIC_KEY", "")
WEBPUSH_VAPID_PRIVATE_KEY = os.environ.get("WEBPUSH_VAPID_PRIVATE_KEY", "")
WEBPUSH_VAPID_SUBJECT = os.environ.get("WEBPUSH_VAPID_SUBJECT", "mailto:admin@example.com")
ATTENDANCE_SUPABASE_URL = os.environ.get("ATTENDANCE_SUPABASE_URL", "https://lorrfeyiqgdfxdjqnpmn.supabase.co")
ATTENDANCE_SUPABASE_PUBLISHABLE_KEY = os.environ.get("ATTENDANCE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_Mh4xVEoQFpooPU0uRblTow_AQmf0YiG")
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

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {
            "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
        },
    },
    "handlers": {
        "reminder_file": {
            "class": "logging.handlers.RotatingFileHandler",
            "filename": LOG_DIR / "reminder-worker.log",
            "maxBytes": 1_000_000,
            "backupCount": 5,
            "formatter": "standard",
        },
    },
    "loggers": {
        "customers.reminders": {
            "handlers": ["reminder_file"],
            "level": "INFO",
            "propagate": True,
        },
    },
}
