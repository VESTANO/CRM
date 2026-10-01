from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import migrations, models
import django.db.models.deletion


def assign_existing_dataset_owners(apps, schema_editor):
    Dataset = apps.get_model("customers", "Dataset")
    User = apps.get_model("auth", "User")

    owner = (
        User.objects.filter(is_superuser=True).order_by("id").first()
        or User.objects.filter(is_staff=True).order_by("id").first()
        or User.objects.order_by("id").first()
    )

    if owner is None:
        owner = User.objects.create(
            username="legacy_owner",
            password=make_password(None),
            is_active=False,
        )

    Dataset.objects.filter(owner__isnull=True).update(owner=owner)


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("customers", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="dataset",
            name="owner",
            field=models.ForeignKey(
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="datasets",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.RunPython(assign_existing_dataset_owners, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="dataset",
            name="owner",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT,
                related_name="datasets",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
    ]
