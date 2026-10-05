from django.urls import path

from . import api_views

app_name = "customers_api"

urlpatterns = [
    path("auth/session/", api_views.SessionView.as_view(), name="session"),
    path("auth/login/", api_views.LoginView.as_view(), name="login"),
    path("auth/logout/", api_views.LogoutView.as_view(), name="logout"),
    path("dashboard/", api_views.DashboardView.as_view(), name="dashboard"),
    path("datasets/", api_views.DatasetListView.as_view(), name="dataset_list"),
    path("datasets/<int:dataset_id>/manage/", api_views.DatasetManagementView.as_view(), name="dataset_manage"),
    path("datasets/<int:dataset_id>/", api_views.DatasetDetailView.as_view(), name="dataset_detail"),
    path("datasets/<int:dataset_id>/export/", api_views.DatasetExportView.as_view(), name="dataset_export"),
    path(
        "datasets/<int:dataset_id>/customers/<int:record_id>/",
        api_views.CustomerDetailView.as_view(),
        name="customer_detail",
    ),
    path("customers/<int:record_id>/", api_views.CustomerByIdView.as_view(), name="customer_by_id"),
    path("import/inspect/", api_views.ExcelInspectView.as_view(), name="import_inspect"),
    path("import/confirm/", api_views.ExcelConfirmImportView.as_view(), name="import_confirm"),
    path("sales/visits/", api_views.VisitListView.as_view(), name="visit_list"),
    path("sales/summary/", api_views.SalesSummaryView.as_view(), name="sales_summary"),
    path("notifications/", api_views.ReminderListView.as_view(), name="reminder_list"),
    path("notifications/<int:reminder_id>/", api_views.ReminderDetailView.as_view(), name="reminder_detail"),
    path("tasks/", api_views.AssignedTaskListView.as_view(), name="task_list"),
    path("tasks/<int:task_id>/", api_views.AssignedTaskDetailView.as_view(), name="task_detail"),
    path("targets/", api_views.UserTargetListView.as_view(), name="target_list"),
    path("push/config/", api_views.PushConfigView.as_view(), name="push_config"),
    path("push/subscriptions/", api_views.PushSubscriptionView.as_view(), name="push_subscriptions"),
    path("sales/clients/", api_views.VisitClientsView.as_view(), name="visit_clients"),
    path("sales/visits/<int:visit_id>/", api_views.VisitDetailView.as_view(), name="visit_detail"),
    path(
        "sales/visits/<int:visit_id>/images/<int:image_id>/",
        api_views.VisitImageView.as_view(),
        name="visit_image",
    ),
    path("admin/summary/", api_views.AdminSummaryView.as_view(), name="admin_summary"),
    path("admin/users/", api_views.AdminUserView.as_view(), name="admin_user_list"),
    path("admin/users/<int:user_id>/", api_views.AdminUserView.as_view(), name="admin_user_detail"),
    path("admin/users/<int:user_id>/datasets/", api_views.AdminUserDatasetsView.as_view(), name="admin_user_datasets"),
    path("admin/users/<int:user_id>/<str:action>/", api_views.AdminUserActionView.as_view(), name="admin_user_action"),
    path("admin/tasks/", api_views.AdminTaskView.as_view(), name="admin_task_list"),
    path("admin/tasks/<int:task_id>/", api_views.AdminTaskDetailView.as_view(), name="admin_task_detail"),
    path("admin/targets/", api_views.AdminTargetView.as_view(), name="admin-targets"),
    path(
        "admin/targets/<int:target_id>/",
        api_views.AdminTargetView.as_view(),
        name="admin-target-detail",
    ),
]
