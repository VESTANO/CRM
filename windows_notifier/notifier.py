"""Per-Windows-user notifier. Never reads browser credentials or uses service keys."""
import argparse
import base64
import ctypes
from ctypes import wintypes
import json
import logging
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
import webbrowser
from xml.sax.saxutils import escape, quoteattr

from engine import ReminderEngine

API = "https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/native-reminders"
APP_ID = "Vestano.CRM.Reminders"
HOME = Path(os.environ.get("LOCALAPPDATA", ".")) / "VestanoCRM" / "Reminders"


class Blob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def protect(data, decrypt=False):
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    result = Blob()
    function = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p if decrypt else wintypes.LPCWSTR, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    description = None if decrypt else "Vestano CRM reminder device"
    if not function(ctypes.byref(source), description, None, None, None, 1, ctypes.byref(result)):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(result.pbData)


def load_state():
    path = HOME / "device.bin"
    return json.loads(protect(path.read_bytes(), True)) if path.exists() else {}


def persist(state):
    HOME.mkdir(parents=True, exist_ok=True)
    path = HOME / "device.tmp"
    path.write_bytes(protect(json.dumps(state).encode()))
    path.replace(HOME / "device.bin")


def post(action, body):
    req = urllib.request.Request(API + "/" + action, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as response:
        data = response.read()
        return json.loads(data) if data else {}


def safe_base(value):
    value = value.rstrip("/") + "/"
    url = urlparse(value)
    if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1")):
        raise ValueError("CRM URL must use HTTPS, except for local development")
    if url.username or url.password or url.query or url.fragment:
        raise ValueError("Invalid CRM URL")
    return value


def toast_xml(reminder, crm_url):
    url = safe_base(crm_url) + f'reminders?reminder={int(reminder["id"])}#reminder-{int(reminder["id"])}'
    return f'<toast activationType="protocol" launch={quoteattr(url)} duration="long"><visual><binding template="ToastGeneric"><text>Vestano CRM | Reminder</text><text>{escape(reminder["text"])}</text></binding></visual></toast>'


def show_toast(reminder, crm_url):
    import hashlib
    xml = toast_xml(reminder, crm_url)
    encoded = base64.b64encode(xml.encode("utf-16-le")).decode()
    tag = hashlib.sha256(f'{reminder["id"]}:{reminder["delivery_revision"]}'.encode()).hexdigest()[:16]
    script = f'''
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{encoded}')))
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$toast.Tag = '{tag}'
$toast.Group = 'CRMReminders'
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{APP_ID}')
if ($notifier.Setting.ToString() -ne 'Enabled') {{ throw 'Windows notification permission is disabled.' }}
$notifier.Show($toast)
'''
    command = base64.b64encode(script.encode("utf-16-le")).decode()
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", command], creationflags=subprocess.CREATE_NO_WINDOW, capture_output=True)
    if result.returncode:
        # Never log reminder text or PowerShell's expanded command.
        raise RuntimeError("Windows rejected the reminder notification")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pair", action="store_true")
    parser.add_argument("--crm-url", default="https://vestano.github.io/CRM/")
    args = parser.parse_args()
    HOME.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=HOME / "notifier.log", level=logging.INFO, format="%(asctime)s %(message)s")
    ctypes.windll.kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    ctypes.windll.kernel32.CreateMutexW.restype = wintypes.HANDLE
    ctypes.windll.kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\VestanoCRMReminders")
    if ctypes.windll.kernel32.GetLastError() == 183:
        return
    try:
        state = load_state()
        crm_url = safe_base(state.get("crm_url", args.crm_url))
        if args.pair or not state.get("token"):
            grant = post("pair", {})
            state = {"token": grant["token"], "crm_url": crm_url}
            persist(state)
            webbrowser.open(crm_url + "reminders?windows_pair=" + grant["pair_code"])
        engine = ReminderEngine(state, persist, lambda reminder: show_toast(reminder, crm_url))
        next_poll = 0
        while True:
            if time.monotonic() >= next_poll:
                try:
                    response = post("poll", {"token": state["token"]})
                    if response.get("approved"):
                        engine.sync(response["reminders"])
                        for receipt_key, receipt in list(state["receipts"].items()):
                            try:
                                post("receipt", {"token": state["token"], **receipt})
                                del state["receipts"][receipt_key]
                            except urllib.error.HTTPError as error:
                                if error.code == 404:
                                    del state["receipts"][receipt_key]
                                else:
                                    raise
                        persist(state)
                except urllib.error.HTTPError as error:
                    if error.code in (401, 403, 410):
                        logging.warning("Device connection needs approval or was revoked. HTTP %s", error.code)
                        return
                    logging.warning("Reminder server temporarily unavailable. HTTP %s", error.code)
                except (OSError, ValueError):
                    logging.warning("Offline; continuing to schedule cached reminders.")
                next_poll = time.monotonic() + 15
            try:
                engine.tick()
            except (OSError, RuntimeError):
                logging.warning("Windows notification failed; will retry.")
            time.sleep(1)
    finally:
        ctypes.windll.kernel32.CloseHandle(mutex)


if __name__ == "__main__":
    main()
