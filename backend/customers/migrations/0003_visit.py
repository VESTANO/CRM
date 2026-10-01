import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("customers", "0002_dataset_owner"),
    ]

    operations = [
        migrations.CreateModel(
            name="Visit",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("visit_date", models.DateField()),
                ("meeting_time", models.TimeField()),
                ("location", models.CharField(max_length=255)),
                ("expense", models.DecimalField(decimal_places=2, default=0, max_digits=10)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("healthy", "Healthy"),
                            ("follow_up_required", "Follow-up Required"),
                            ("interested", "Interested"),
                            ("not_interested", "Not Interested"),
                            ("converted", "Converted"),
                        ],
                        default="healthy",
                        max_length=32,
                    ),
                ),
                ("note", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "customer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="visits",
                        to="customers.customerrecord",
                    ),
                ),
            ],
            options={
                "ordering": ["-visit_date", "-meeting_time", "-created_at"],
            },
        ),
    ]
