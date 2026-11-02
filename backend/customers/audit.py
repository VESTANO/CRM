from django.db import transaction

from .models import CustomerRecordChange


def customer_crm_values(record):
    return {
        "response": record.response,
        "callback_date": record.callback_date.isoformat() if record.callback_date else "",
        "note": record.note,
    }


def save_customer_crm_change(form, changed_by, previous_values):
    with transaction.atomic():
        record = form.save(commit=False)
        if record.response == record.RESPONSE_CALLBACK:
            record.callback_completed_at = None
            record.callback_completed_by = None
        record.save()
        updated_values = customer_crm_values(record)
        if previous_values != updated_values:
            CustomerRecordChange.objects.create(
                record=record,
                changed_by=changed_by,
                previous_values=previous_values,
                updated_values=updated_values,
            )
    return record
