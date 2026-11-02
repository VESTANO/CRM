from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("customers", "0016_callback_completion"),
    ]

    operations = [
        migrations.AddField(
            model_name="visit",
            name="paid_amount",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
        migrations.AddField(
            model_name="visit",
            name="payment_description",
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name="visit",
            name="payment_status",
            field=models.CharField(
                choices=[
                    ("not_paid", "Not Paid"),
                    ("partially_paid", "Partially Paid"),
                    ("completed", "Completed"),
                    ("one_time", "One-time Payment"),
                ],
                default="not_paid",
                max_length=32,
            ),
        ),
        migrations.AddField(
            model_name="visit",
            name="total_amount",
            field=models.DecimalField(decimal_places=2, default=0, max_digits=12),
        ),
    ]
