from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def preserve_existing_called_back_records(apps, schema_editor):
    CustomerRecord = apps.get_model("customers", "CustomerRecord")
    for record in CustomerRecord.objects.filter(response="called_back").iterator():
        record.response = "no_response"
        record.callback_completed_at = record.updated_at
        record.save(update_fields=["response", "callback_completed_at"])


class Migration(migrations.Migration):
    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("customers", "0015_alter_customerrecord_response"),
    ]

    operations = [
        migrations.AddField(
            model_name="customerrecord",
            name="callback_completed_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="customerrecord",
            name="callback_completed_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="completed_callbacks",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(preserve_existing_called_back_records, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="customerrecord",
            name="response",
            field=models.CharField(
                choices=[
                    ("no_response", "No Response"),
                    ("interested", "Interested"),
                    ("not_interested", "Not Interested"),
                    ("callback", "Callback"),
                    ("converted", "Converted"),
                ],
                default="no_response",
                max_length=32,
            ),
        ),
    ]
