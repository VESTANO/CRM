from django.db import migrations, models


def backfill_completed_at(apps, schema_editor):
    AssignedTask = apps.get_model("customers", "AssignedTask")
    AssignedTask.objects.filter(status="done", completed_at__isnull=True).update(
        completed_at=models.F("updated_at")
    )


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0017_visit_payment_fields"),
    ]

    operations = [
        migrations.AddField(
            model_name="assignedtask",
            name="completed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.RunPython(backfill_completed_at, migrations.RunPython.noop),
    ]
