from django.contrib import admin
from django.contrib.auth.views import LoginView, LogoutView
from django.conf import settings
from django.http import FileResponse, HttpResponse
from django.urls import include, path, re_path

from customers.forms import CRMAuthenticationForm


def service_worker(request):
    response = FileResponse(
        (settings.BACKEND_DIR / "static" / "js" / "service-worker.js").open("rb"),
        content_type="application/javascript",
    )
    response["Service-Worker-Allowed"] = "/"
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
    path("api/", include("customers.api_urls")),
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
