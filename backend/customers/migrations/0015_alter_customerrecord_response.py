from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0014_customerrecord_callback_date"),
    ]

    operations = [
        migrations.AlterField(
            model_name="customerrecord",
            name="response",
            field=models.CharField(
                choices=[
                    ("no_response", "No Response"),
                    ("interested", "Interested"),
                    ("not_interested", "Not Interested"),
                    ("callback", "Callback"),
                    ("called_back", "Called Back"),
                    ("converted", "Converted"),
                ],
                default="no_response",
                max_length=32,
            ),
        ),
    ]
