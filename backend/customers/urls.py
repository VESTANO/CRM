from django.urls import path

from . import views


app_name = "customers"

urlpatterns = [
    path("", views.dashboard, name="dashboard"),
    path("admin-panel/", views.admin_panel, name="admin_panel"),
    path("admin-panel/users/add/", views.admin_user_add, name="admin_user_add"),
    path("admin-panel/users/<int:user_id>/", views.admin_user_detail, name="admin_user_detail"),
    path("admin-panel/users/<int:user_id>/edit/", views.admin_user_edit, name="admin_user_edit"),
    path(
        "admin-panel/users/<int:user_id>/password/",
        views.admin_user_password,
        name="admin_user_password",
    ),
    path(
        "admin-panel/users/<int:user_id>/toggle-active/",
        views.admin_user_toggle_active,
        name="admin_user_toggle_active",
    ),
    path(
        "admin-panel/users/<int:user_id>/datasets/",
        views.admin_user_datasets,
        name="admin_user_datasets",
    ),
    path("sales/", views.sales_list, name="sales_list"),
    path("reminders/", views.reminders, name="reminders"),
    path("notifications/", views.notifications, name="notifications"),
    path("sales/clients/", views.sales_clients, name="sales_clients"),
    path("sales/visits/add/", views.visit_add, name="visit_add"),
    path("sales/visits/<int:visit_id>/", views.visit_detail, name="visit_detail"),
    path("sales/visits/<int:visit_id>/edit/", views.visit_edit, name="visit_edit"),
    path("sales/visits/<int:visit_id>/delete/", views.visit_delete, name="visit_delete"),
    path("datasets/", views.dataset_list, name="dataset_list"),
    path("datasets/<int:dataset_id>/", views.dataset_detail, name="dataset_detail"),
    path("datasets/<int:dataset_id>/export/", views.dataset_export, name="dataset_export"),
    path("datasets/<int:dataset_id>/rename/", views.dataset_rename, name="dataset_rename"),
    path("datasets/<int:dataset_id>/delete/", views.dataset_delete, name="dataset_delete"),
    path(
        "datasets/<int:dataset_id>/customers/<int:record_id>/",
        views.customer_detail,
        name="customer_detail",
    ),
    path(
        "datasets/<int:dataset_id>/customers/<int:record_id>/edit/",
        views.customer_edit,
        name="customer_edit",
    ),
    path(
        "datasets/<int:dataset_id>/customers/<int:record_id>/delete/",
        views.customer_delete,
        name="customer_delete",
    ),
    path("import/", views.import_excel, name="import_excel"),
]
