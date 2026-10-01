from pathlib import Path
import re
from datetime import datetime

from django import forms
from django.contrib.auth import get_user_model, password_validation
from django.contrib.auth.forms import AuthenticationForm
from django.utils import timezone

from .models import CustomerRecord, Dataset, ManualClient, Reminder, Visit, VisitImage


PHONE_PATTERN = re.compile(r"^\+?[0-9][0-9\s\-()]*[0-9]$")
MAX_NOTE_LENGTH = 2000
MAX_VISIT_IMAGE_SIZE = 10 * 1024 * 1024
MAX_VISIT_IMAGES = 10


class ReminderForm(forms.Form):
    text = forms.CharField(
        label="Reminder",
        max_length=500,
        widget=forms.TextInput(attrs={"class": "form-control", "placeholder": "What do you need to remember?"}),
    )
    date = forms.DateField(
        widget=forms.DateInput(attrs={"class": "form-control", "type": "date"}),
    )
    time = forms.TimeField(
        widget=forms.TimeInput(attrs={"class": "form-control", "type": "time"}),
    )

    def clean_text(self):
        text = self.cleaned_data["text"].strip()
        if not text:
            raise forms.ValidationError("Enter a reminder.")
        return text

    def clean(self):
        cleaned_data = super().clean()
        date = cleaned_data.get("date")
        time = cleaned_data.get("time")
        if date and time:
            reminder_at = timezone.make_aware(
                datetime.combine(date, time),
                timezone.get_current_timezone(),
            )
            if reminder_at <= timezone.now():
                raise forms.ValidationError("Choose a future date and time.")
            cleaned_data["reminder_at"] = reminder_at
        return cleaned_data

    def save(self, owner, instance=None):
        reminder = instance or Reminder(owner=owner)
        previous_reminder_at = reminder.reminder_at
        reminder.text = self.cleaned_data["text"]
        reminder.reminder_at = self.cleaned_data["reminder_at"]
        if instance and reminder.reminder_at != previous_reminder_at:
            reminder.sent_at = None
        reminder.save()
        return reminder


class MultipleImageInput(forms.ClearableFileInput):
    allow_multiple_selected = True


class MultipleImageField(forms.FileField):
    widget = MultipleImageInput

    def __init__(self, *args, **kwargs):
        attrs = kwargs.pop("attrs", {})
        attrs.update(
            {
                "class": "form-control",
                "accept": "image/jpeg,image/png,image/gif,image/webp,image/bmp,image/avif",
                "multiple": True,
            }
        )
        super().__init__(*args, widget=self.widget(attrs=attrs), **kwargs)

    def clean(self, data, initial=None):
        if not data:
            return []
        files = data if isinstance(data, (list, tuple)) else [data]
        if len(files) > MAX_VISIT_IMAGES:
            raise forms.ValidationError(f"Upload no more than {MAX_VISIT_IMAGES} images at a time.")

        cleaned_files = []
        for uploaded_file in files:
            uploaded_file = super().clean(uploaded_file, initial=None)
            if uploaded_file.size > MAX_VISIT_IMAGE_SIZE:
                raise forms.ValidationError("Each image must be 10 MB or smaller.")
            header = uploaded_file.read(16)
            uploaded_file.seek(0)
            extension = Path(uploaded_file.name).suffix.lower()
            valid_images = (
                (extension in {".jpg", ".jpeg"} and header.startswith(b"\xff\xd8\xff"))
                or (extension == ".png" and header.startswith(b"\x89PNG\r\n\x1a\n"))
                or (extension == ".gif" and header[:6] in {b"GIF87a", b"GIF89a"})
                or (extension == ".webp" and header[:4] == b"RIFF" and header[8:12] == b"WEBP")
                or (extension == ".bmp" and header.startswith(b"BM"))
                or (extension == ".avif" and header[4:12].startswith(b"ftypavif"))
            )
            if not valid_images:
                raise forms.ValidationError(
                    "Upload valid JPEG, PNG, GIF, WebP, BMP, or AVIF image files."
                )
            cleaned_files.append(uploaded_file)
        return cleaned_files


def save_visit_images(visit, uploaded_files):
    return [
        VisitImage.objects.create(
            visit=visit,
            image=uploaded_file,
            original_name=Path(uploaded_file.name).name[:255],
        )
        for uploaded_file in uploaded_files
    ]


def normalize_spaces(value):
    return " ".join((value or "").strip().split())


def clean_meaningful_text(value, field_name, *, require_letter=False, reject_numbers_only=False):
    value = normalize_spaces(value)
    if not value:
        raise forms.ValidationError(f"{field_name} is required.")

    if not any(char.isalnum() for char in value):
        raise forms.ValidationError(f"Please enter a valid {field_name.lower()}.")

    if require_letter and not any(char.isalpha() for char in value):
        raise forms.ValidationError(f"Please enter a valid {field_name.lower()}.")

    if reject_numbers_only and value.replace(" ", "").isdigit():
        raise forms.ValidationError(f"Please enter a valid {field_name.lower()}.")

    return value


def clean_optional_meaningful_text(value, field_name, *, require_letter=False, reject_numbers_only=False):
    value = normalize_spaces(value)
    if not value:
        return ""
    return clean_meaningful_text(
        value,
        field_name,
        require_letter=require_letter,
        reject_numbers_only=reject_numbers_only,
    )


def clean_phone_number(value):
    value = normalize_spaces(value)
    if not value:
        return ""

    compact = value.replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    digits = "".join(char for char in compact if char.isdigit())
    if (
        not PHONE_PATTERN.fullmatch(value)
        or value.count("+") > 1
        or ("+" in value and not value.startswith("+"))
        or not 7 <= len(digits) <= 15
    ):
        raise forms.ValidationError("Please enter a valid phone number.")
    return value


class VisitValidationMixin:
    def clean_location(self):
        return clean_meaningful_text(self.cleaned_data["location"], "Location")

    def clean_expense(self):
        expense = self.cleaned_data["expense"]
        if expense < 0:
            raise forms.ValidationError("Expense cannot be negative.")
        return expense

    def clean_note(self):
        note = (self.cleaned_data.get("note") or "").strip()
        if len(note) > MAX_NOTE_LENGTH:
            raise forms.ValidationError(f"Note cannot be longer than {MAX_NOTE_LENGTH} characters.")
        return note


class CRMAuthenticationForm(AuthenticationForm):
    error_messages = {
        "invalid_login": "Invalid username or password.",
        "inactive": "This account is inactive.",
    }


class ExcelUploadForm(forms.Form):
    dataset_name = forms.CharField(
        label="Dataset name",
        max_length=255,
        help_text="Example: January Leads",
        error_messages={"required": "Dataset name is required."},
        widget=forms.TextInput(
            attrs={
                "class": "form-control",
                "placeholder": "January Leads",
                "required": "required",
                "maxlength": "255",
            }
        ),
    )
    excel_file = forms.FileField(
        label="Excel file",
        help_text="Upload an .xlsx workbook for dataset import and structure inspection.",
        widget=forms.ClearableFileInput(
            attrs={
                "accept": ".xlsx",
                "class": "form-control",
            }
        ),
    )

    def clean_excel_file(self):
        uploaded_file = self.cleaned_data["excel_file"]
        extension = Path(uploaded_file.name).suffix.lower()

        if extension != ".xlsx":
            raise forms.ValidationError("Please upload a valid .xlsx Excel file.")

        signature = uploaded_file.read(4)
        uploaded_file.seek(0)
        if signature != b"PK\x03\x04":
            raise forms.ValidationError(
                "The uploaded file does not appear to be a valid .xlsx workbook."
            )

        return uploaded_file

    def clean_dataset_name(self):
        return clean_meaningful_text(
            self.cleaned_data["dataset_name"],
            "Dataset name",
            reject_numbers_only=True,
        )


class CustomerCRMForm(forms.ModelForm):
    class Meta:
        model = CustomerRecord
        fields = ["response", "note"]
        widgets = {
            "response": forms.Select(attrs={"class": "form-select"}),
            "note": forms.Textarea(
                attrs={
                    "class": "form-control",
                    "rows": 5,
                    "placeholder": "Add CRM notes for this customer",
                    "maxlength": str(MAX_NOTE_LENGTH),
                }
            ),
        }

    def clean_note(self):
        note = (self.cleaned_data.get("note") or "").strip()
        if len(note) > MAX_NOTE_LENGTH:
            raise forms.ValidationError(f"Note cannot be longer than {MAX_NOTE_LENGTH} characters.")
        return note


class DatasetForm(forms.ModelForm):
    class Meta:
        model = Dataset
        fields = ["name"]
        widgets = {
            "name": forms.TextInput(attrs={"class": "form-control", "required": "required", "maxlength": "255"}),
        }

    def clean_name(self):
        return clean_meaningful_text(
            self.cleaned_data["name"],
            "Dataset name",
            reject_numbers_only=True,
        )


class CustomerRecordChoiceField(forms.ModelChoiceField):
    def label_from_instance(self, obj):
        return obj.display_name


class VisitForm(VisitValidationMixin, forms.ModelForm):
    images = MultipleImageField(required=False, label="Visit Images")
    dataset = forms.ModelChoiceField(
        queryset=Dataset.objects.none(),
        label="Dataset / Customer List",
        widget=forms.Select(attrs={"class": "form-select", "required": "required"}),
    )
    customer = CustomerRecordChoiceField(
        queryset=CustomerRecord.objects.none(),
        label="Client",
        widget=forms.Select(attrs={"class": "form-select", "required": "required"}),
    )
    customer_search = forms.CharField(
        label="Search client",
        required=False,
        widget=forms.TextInput(
            attrs={
                "class": "form-control",
                "placeholder": "Search by customer name, phone, email, city...",
            }
        ),
    )

    class Meta:
        model = Visit
        fields = [
            "dataset",
            "customer_search",
            "customer",
            "visit_date",
            "meeting_time",
            "location",
            "expense",
            "status",
            "note",
        ]
        widgets = {
            "visit_date": forms.DateInput(attrs={"class": "form-control", "type": "date", "required": "required"}),
            "meeting_time": forms.TimeInput(attrs={"class": "form-control", "type": "time", "required": "required"}),
            "location": forms.TextInput(attrs={"class": "form-control", "placeholder": "Meeting location", "required": "required", "maxlength": "255"}),
            "expense": forms.NumberInput(attrs={"class": "form-control", "step": "0.01", "min": "0"}),
            "status": forms.Select(attrs={"class": "form-select"}),
            "note": forms.Textarea(attrs={"class": "form-control", "rows": 5, "placeholder": "Add visit notes", "maxlength": str(MAX_NOTE_LENGTH)}),
        }

    def __init__(self, *args, datasets=None, selected_dataset=None, customer_search="", **kwargs):
        super().__init__(*args, **kwargs)
        datasets = datasets or Dataset.objects.none()
        self.fields["dataset"].queryset = datasets
        self.fields["customer"].queryset = CustomerRecord.objects.none()
        self.fields["customer_search"].initial = customer_search

        if self.instance and self.instance.pk:
            selected_dataset = selected_dataset or self.instance.customer.dataset
            self.fields["dataset"].initial = selected_dataset

        if selected_dataset:
            customer_queryset = selected_dataset.records.order_by("sheet_name", "row_number")
            if customer_search:
                matching_ids = [
                    record.id
                    for record in customer_queryset
                    if customer_search.casefold() in " ".join(
                        str(value) for value in record.original_data.values()
                    ).casefold()
                ]
                customer_queryset = selected_dataset.records.filter(id__in=matching_ids).order_by(
                    "sheet_name",
                    "row_number",
                )
            self.fields["customer"].queryset = customer_queryset

    def clean(self):
        cleaned_data = super().clean()
        dataset = cleaned_data.get("dataset")
        customer = cleaned_data.get("customer")

        if dataset and customer and customer.dataset_id != dataset.id:
            self.add_error("customer", "Select a client from the selected dataset.")

        return cleaned_data


class ManualVisitForm(VisitValidationMixin, forms.ModelForm):
    images = MultipleImageField(required=False, label="Visit Images")
    client_name = forms.CharField(
        label="Client Name",
        max_length=255,
        error_messages={"required": "Client Name is required."},
        widget=forms.TextInput(attrs={"class": "form-control", "placeholder": "Client name", "required": "required", "maxlength": "255"}),
    )
    phone = forms.CharField(
        label="Phone",
        max_length=50,
        required=False,
        widget=forms.TextInput(
            attrs={
                "class": "form-control",
                "placeholder": "+91 98765 43210",
                "maxlength": "50",
                "pattern": r"\+?[0-9][0-9\s\-()]*[0-9]",
                "title": "Please enter a valid phone number.",
            }
        ),
    )
    email = forms.EmailField(
        label="Email",
        required=False,
        widget=forms.EmailInput(attrs={"class": "form-control", "placeholder": "Email address", "maxlength": "254"}),
    )
    company = forms.CharField(
        label="Company",
        max_length=255,
        required=False,
        widget=forms.TextInput(attrs={"class": "form-control", "placeholder": "Company", "maxlength": "255"}),
    )
    client_location = forms.CharField(
        label="Client Location",
        max_length=255,
        required=False,
        widget=forms.TextInput(attrs={"class": "form-control", "placeholder": "Client location", "maxlength": "255"}),
    )

    class Meta:
        model = Visit
        fields = [
            "client_name",
            "phone",
            "email",
            "company",
            "client_location",
            "visit_date",
            "meeting_time",
            "location",
            "expense",
            "status",
            "note",
        ]
        widgets = {
            "visit_date": forms.DateInput(attrs={"class": "form-control", "type": "date", "required": "required"}),
            "meeting_time": forms.TimeInput(attrs={"class": "form-control", "type": "time", "required": "required"}),
            "location": forms.TextInput(attrs={"class": "form-control", "placeholder": "Meeting location", "required": "required", "maxlength": "255"}),
            "expense": forms.NumberInput(attrs={"class": "form-control", "step": "0.01", "min": "0"}),
            "status": forms.Select(attrs={"class": "form-select"}),
            "note": forms.Textarea(attrs={"class": "form-control", "rows": 5, "placeholder": "Add visit notes", "maxlength": str(MAX_NOTE_LENGTH)}),
        }

    def __init__(self, *args, owner=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.owner = owner
        if self.instance and self.instance.pk and self.instance.manual_client_id:
            client = self.instance.manual_client
            self.fields["client_name"].initial = client.client_name
            self.fields["phone"].initial = client.phone
            self.fields["email"].initial = client.email
            self.fields["company"].initial = client.company
            self.fields["client_location"].initial = client.location

    def clean_client_name(self):
        return clean_meaningful_text(
            self.cleaned_data["client_name"],
            "Client Name",
            require_letter=True,
            reject_numbers_only=True,
        )

    def clean_phone(self):
        return clean_phone_number(self.cleaned_data.get("phone", ""))

    def clean_company(self):
        return clean_optional_meaningful_text(
            self.cleaned_data.get("company", ""),
            "Company",
            require_letter=True,
            reject_numbers_only=True,
        )

    def clean_client_location(self):
        return clean_optional_meaningful_text(
            self.cleaned_data.get("client_location", ""),
            "Location",
        )

    def save(self, commit=True):
        visit = super().save(commit=False)
        manual_client = visit.manual_client if visit.pk and visit.manual_client_id else ManualClient(owner=self.owner)
        manual_client.client_name = self.cleaned_data["client_name"]
        manual_client.phone = self.cleaned_data["phone"]
        manual_client.email = self.cleaned_data["email"]
        manual_client.company = self.cleaned_data["company"]
        manual_client.location = self.cleaned_data["client_location"]
        if commit:
            manual_client.save()
            visit.manual_client = manual_client
            visit.customer = None
            visit.save()
            self.save_m2m()
        else:
            visit.manual_client = manual_client
            visit.customer = None
        return visit


class AdminUserCreateForm(forms.ModelForm):
    password1 = forms.CharField(
        label="Password",
        strip=False,
        widget=forms.PasswordInput(attrs={"class": "form-control", "autocomplete": "new-password"}),
    )
    password2 = forms.CharField(
        label="Confirm password",
        strip=False,
        widget=forms.PasswordInput(attrs={"class": "form-control", "autocomplete": "new-password"}),
    )

    class Meta:
        model = get_user_model()
        fields = ["username", "email", "is_active"]
        widgets = {
            "username": forms.TextInput(attrs={"class": "form-control", "autocomplete": "username"}),
            "email": forms.EmailInput(attrs={"class": "form-control", "autocomplete": "email"}),
            "is_active": forms.CheckboxInput(attrs={"class": "form-check-input"}),
        }
        labels = {
            "is_active": "Active status",
        }

    def clean_password2(self):
        password1 = self.cleaned_data.get("password1")
        password2 = self.cleaned_data.get("password2")

        if password1 and password2 and password1 != password2:
            raise forms.ValidationError("The two password fields did not match.")

        if password2:
            password_validation.validate_password(password2, self.instance)
        return password2

    def save(self, commit=True):
        user = super().save(commit=False)
        user.is_staff = False
        user.is_superuser = False
        user.set_password(self.cleaned_data["password1"])

        if commit:
            user.save()

        return user


class AdminUserEditForm(forms.ModelForm):
    class Meta:
        model = get_user_model()
        fields = ["username", "email", "is_active"]
        widgets = {
            "username": forms.TextInput(attrs={"class": "form-control", "autocomplete": "username"}),
            "email": forms.EmailInput(attrs={"class": "form-control", "autocomplete": "email"}),
            "is_active": forms.CheckboxInput(attrs={"class": "form-check-input"}),
        }


class AdminPasswordResetForm(forms.Form):
    password1 = forms.CharField(
        label="New password",
        strip=False,
        widget=forms.PasswordInput(attrs={"class": "form-control", "autocomplete": "new-password"}),
    )
    password2 = forms.CharField(
        label="Confirm new password",
        strip=False,
        widget=forms.PasswordInput(attrs={"class": "form-control", "autocomplete": "new-password"}),
    )

    def __init__(self, *args, user=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.user = user

    def clean_password2(self):
        password1 = self.cleaned_data.get("password1")
        password2 = self.cleaned_data.get("password2")

        if password1 and password2 and password1 != password2:
            raise forms.ValidationError("The two password fields did not match.")

        if password2:
            password_validation.validate_password(password2, self.user)
        return password2
