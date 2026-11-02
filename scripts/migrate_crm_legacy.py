"""Send the local Django CRM database to its private Supabase migration endpoint.

The script streams no files to disk: it reads the existing SQLite database and
visit images, sends the payload over HTTPS, and prints counts only. It includes
Django password hashes, never plaintext passwords.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sqlite3
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DB = ROOT / "db.sqlite3"
SUPABASE_CONFIG = ROOT / "frontend" / "src" / "services" / "crmSupabase.js"


def parse_json(value):
    if value in (None, ""):
        return {}
    if isinstance(value, (dict, list)):
        return value
    return json.loads(value)


def table_rows(connection: sqlite3.Connection, table: str) -> list[dict]:
    cursor = connection.execute(f'SELECT * FROM "{table}" ORDER BY id')
    names = [item[0] for item in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def export_payload(db_path: Path, media_root: Path) -> dict:
    connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        users = []
        for row in table_rows(connection, "auth_user"):
            users.append(
                {
                    "local_user_id": row["id"],
                    "username": row["username"],
                    "email": row["email"] or "",
                    "password_hash": row["password"] or "",
                    "active": bool(row["is_active"]),
                    "is_staff": bool(row["is_staff"]),
                    "is_superuser": bool(row["is_superuser"]),
                    "first_name": row["first_name"] or "",
                    "last_name": row["last_name"] or "",
                    "date_joined": row["date_joined"],
                }
            )

        datasets = table_rows(connection, "customers_dataset")
        columns = [
            {
                "id": row["id"],
                "dataset_id": row["dataset_id"],
                "sheet_name": row["sheet_name"],
                "original_name": row["original_name"],
                "field_key": row["field_key"],
                "column_order": row["order"],
            }
            for row in table_rows(connection, "customers_datasetcolumn")
        ]
        records = table_rows(connection, "customers_customerrecord")
        for row in records:
            row["original_data"] = parse_json(row["original_data"])
            row["callback_completed_by_id"] = row.pop("callback_completed_by_id")

        changes = table_rows(connection, "customers_customerrecordchange")
        for row in changes:
            row["previous_values"] = parse_json(row["previous_values"])
            row["updated_values"] = parse_json(row["updated_values"])

        manual_clients = table_rows(connection, "customers_manualclient")
        visit_rows = connection.execute(
            """SELECT v.*,
                      COALESCE(
                        (SELECT d.owner_id FROM customers_customerrecord r
                         JOIN customers_dataset d ON d.id = r.dataset_id
                         WHERE r.id = v.customer_id),
                        (SELECT m.owner_id FROM customers_manualclient m
                         WHERE m.id = v.manual_client_id)
                      ) AS owner_id
               FROM customers_visit v ORDER BY v.id"""
        )
        visit_names = [column[0] for column in visit_rows.description]
        visits = [dict(zip(visit_names, row)) for row in visit_rows.fetchall()]

        visit_images = []
        for row in table_rows(connection, "customers_visitimage"):
            relative_path = Path(row["image"])
            file_path = media_root / relative_path
            if not file_path.is_file():
                raise FileNotFoundError(f"A visit image is missing from the media folder (image record {row['id']}).")
            content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
            visit_images.append(
                {
                    "id": row["id"],
                    "visit_id": row["visit_id"],
                    "original_name": row["original_name"],
                    "uploaded_at": row["uploaded_at"],
                    "file_name": file_path.name,
                    "content_type": content_type,
                    "content_base64": base64.b64encode(file_path.read_bytes()).decode("ascii"),
                }
            )

        return {
            "version": 1,
            "users": users,
            "datasets": datasets,
            "dataset_columns": columns,
            "customer_records": records,
            "customer_record_changes": changes,
            "manual_clients": manual_clients,
            "visits": visits,
            "visit_images": visit_images,
            "reminders": table_rows(connection, "customers_reminder"),
            "assigned_tasks": table_rows(connection, "customers_assignedtask"),
            "sales_targets": table_rows(connection, "customers_salestarget"),
            "overtime_requests": table_rows(connection, "customers_overtimerequest"),
            "push_subscriptions": table_rows(connection, "customers_pushsubscription"),
            "reminder_deliveries": table_rows(connection, "customers_reminderdelivery"),
        }
    finally:
        connection.close()


def counts(payload: dict) -> dict[str, int]:
    return {key: len(value) for key, value in payload.items() if isinstance(value, list)}


def supabase_config() -> tuple[str, str]:
    content = SUPABASE_CONFIG.read_text(encoding="utf-8")
    url = os.environ.get("CRM_SUPABASE_URL") or os.environ.get("VITE_CRM_SUPABASE_URL")
    publishable_key = os.environ.get("CRM_SUPABASE_PUBLISHABLE_KEY") or os.environ.get("VITE_CRM_SUPABASE_PUBLISHABLE_KEY")
    if not url:
        url_match = re.search(r'CRM_SUPABASE_URL\s*=\s*"([^"]+)"', content)
        url = url_match.group(1) if url_match else ""
    if not publishable_key:
        key_match = re.search(r'CRM_SUPABASE_PUBLISHABLE_KEY\s*=\s*"([^"]+)"', content)
        publishable_key = key_match.group(1) if key_match else ""
    if not url or not publishable_key or "your-crm-project-ref" in url or "REPLACE_AFTER" in publishable_key:
        raise RuntimeError("Set CRM_SUPABASE_URL and CRM_SUPABASE_PUBLISHABLE_KEY to the dedicated CRM project before importing data.")
    return url, publishable_key


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DB)
    parser.add_argument("--media", type=Path, default=ROOT / "media")
    parser.add_argument("--dry-run", action="store_true", help="Count the data without sending it.")
    args = parser.parse_args()

    if not args.database.is_file():
        print("Local CRM database was not found.", file=sys.stderr)
        return 2

    payload = export_payload(args.database.resolve(), args.media.resolve())
    if args.dry_run:
        print(json.dumps(counts(payload), sort_keys=True))
        return 0

    token = os.environ.get("CRM_MIGRATION_TOKEN", "")
    if not token:
        print("CRM_MIGRATION_TOKEN is required.", file=sys.stderr)
        return 2

    project_url, publishable_key = supabase_config()
    target = project_url + "/functions/v1/crm-api/api/migration/import/"
    request = Request(
        target,
        data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "apikey": publishable_key,
            "x-crm-migration-token": token,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        print(f"Supabase rejected the migration request (HTTP {error.code}).", file=sys.stderr)
        return 1
    except (URLError, TimeoutError) as error:
        print(f"The Supabase migration request failed: {type(error).__name__}.", file=sys.stderr)
        return 1

    print(json.dumps({"status": "complete", "counts": counts(payload), "result": result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
