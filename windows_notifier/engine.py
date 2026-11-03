"""Browser-independent reminder scheduling; no credentials or Windows APIs here."""
from datetime import datetime, timezone, timedelta


def parse_time(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("Reminder dates must include a timezone")
    return result


class ReminderEngine:
    def __init__(self, state, persist, show):
        self.state, self.persist, self.show = state, persist, show
        state.setdefault("reminders", [])
        state.setdefault("shown", {})
        state.setdefault("receipts", {})

    def sync(self, reminders):
        for reminder in reminders:
            parse_time(reminder["reminder_at"])
            if not isinstance(reminder["id"], int) or not isinstance(reminder["delivery_revision"], int):
                raise ValueError("Invalid reminder identity")
        self.state["reminders"] = reminders
        self.persist(self.state)

    def tick(self, now=None):
        now = now or datetime.now(timezone.utc)
        for reminder in self.state["reminders"]:
            key = f'{reminder["id"]}:{reminder["delivery_revision"]}'
            scheduled = parse_time(reminder["reminder_at"])
            if scheduled > now or now-scheduled > timedelta(days=7) or key in self.state["shown"]:
                continue
            self.show(reminder)
            self.state["shown"][key] = now.isoformat()
            self.state["receipts"][key] = {"reminder_id": reminder["id"], "delivery_revision": reminder["delivery_revision"]}
            self.persist(self.state)
