from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("customers", "0019_overtimerequest")]

    operations = [
        migrations.AlterField(
            model_name="visit",
            name="meeting_time",
            field=models.TimeField(blank=True, null=True),
        ),
        migrations.AlterField(
            model_name="visit",
            name="location",
            field=models.CharField("Meeting Location", blank=True, max_length=255),
        ),
    ]
