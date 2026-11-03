from django.contrib import admin
from django.contrib.auth.views import LoginView, LogoutView
from django.conf import settings
from django.http import FileResponse, HttpResponse
from django.urls import include, path, re_path

from customers.forms import CRMAuthenticationForm
from customers.attendance import attendance_api, attendance_device_receiver


def service_worker(request, filename="service-worker.js"):
    # Development and Pages share frontend/public. Docker contains the built
    # copies under backend/static/frontend, so it serves those same assets.
    public_dir = settings.BASE_DIR / "frontend" / "public"
    asset_dir = public_dir if public_dir.is_dir() else settings.BACKEND_DIR / "static" / "frontend"
    response = FileResponse(
        (asset_dir / filename).open("rb"),
        content_type="application/javascript",
    )
    response["Service-Worker-Allowed"] = "/"
    response["Cache-Control"] = "no-cache"
    return response


def react_app(request):
    index_path = settings.BACKEND_DIR / "static" / "frontend" / "index.html"
    if not index_path.is_file():
        return HttpResponse(
            "React frontend is not built. Run `npm run build` in the frontend directory.",
            status=503,
            content_type="text/plain",
        )
    response = FileResponse(index_path.open("rb"), content_type="text/html")
    response["Cache-Control"] = "no-cache"
    return response


urlpatterns = [
    path("admin/", admin.site.urls),
    path("service-worker.js", service_worker, name="service_worker"),
    path("reminder-worker-core.js", service_worker, {"filename": "reminder-worker-core.js"}, name="reminder_worker_core"),
    path("api/", include("customers.api_urls")),
    path("api/attendance/", attendance_api, name="attendance_api"),
    path("api/attendance/<str:action>/", attendance_api, name="attendance_action"),
    path("iclock/cdata", attendance_device_receiver, name="attendance_device_receiver"),
    path("iclock/cdata/", attendance_device_receiver),
    path("iclock/getrequest", attendance_device_receiver),
    path("iclock/getrequest/", attendance_device_receiver),
    path(
        "legacy-login/",
        LoginView.as_view(
            template_name="registration/login.html",
            authentication_form=CRMAuthenticationForm,
        ),
        name="login",
    ),
    path("logout/", LogoutView.as_view(), name="logout"),
    path("legacy/", include("customers.urls")),
    re_path(r"^(?!api/|admin/|legacy/|static/|media/|service-worker\.js$).*", react_app),
]
