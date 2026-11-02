"""Isolated, transactional storage for attendance imported from the supplied portal."""

from contextlib import closing, contextmanager
import json
import sqlite3
from pathlib import Path

from django.conf import settings


@contextmanager
def attendance_data(write=False):
    path = getattr(settings, "ATTENDANCE_DB_PATH", settings.MEDIA_ROOT / "attendance" / "attendance.sqlite3")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(path, timeout=15)) as connection, connection:
        connection.execute("CREATE TABLE IF NOT EXISTS attendance_state (id INTEGER PRIMARY KEY, data TEXT NOT NULL)")
        if write:
            connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT data FROM attendance_state WHERE id = 1").fetchone()
        data = json.loads(row[0]) if row else {
            "settings": {}, "users": [], "attendance": [], "attendanceDevices": [], "attendanceMappings": {},
        }
        yield data
        if write:
            connection.execute(
                "INSERT INTO attendance_state (id, data) VALUES (1, ?) "
                "ON CONFLICT(id) DO UPDATE SET data = excluded.data", (json.dumps(data),),
            )
