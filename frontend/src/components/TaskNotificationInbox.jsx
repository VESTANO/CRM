import { useState } from "react";
import { Link } from "react-router-dom";
import { useTaskNotifications } from "../hooks/useTaskNotifications.js";
import { formatDateTime } from "../utils/formatters.js";

export default function TaskNotificationInbox() {
  const { notifications, unreadCount, loaded, error, markRead, markAllRead, refresh } = useTaskNotifications();
  const [busy, setBusy] = useState(false);
  const markAll = async () => { setBusy(true); try { await markAllRead(); } finally { setBusy(false); } };
  return <section className="panel mb-4" aria-labelledby="task-notification-inbox-title">
    <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
      <h2 id="task-notification-inbox-title" className="h5 mb-0">Recent notifications {unreadCount > 0 && <span className="badge task-status-submitted ms-2">{unreadCount} unread</span>}</h2>
      {unreadCount > 0 && <button type="button" className="btn btn-outline-secondary btn-sm" disabled={busy} onClick={markAll}>{busy ? "Marking as read..." : "Mark all as read"}</button>}
    </div>
    {error && <div className="alert alert-warning py-2" role="status">{error} <button type="button" className="btn btn-sm btn-outline-secondary ms-2" onClick={() => refresh({ force: true })}>Retry notifications</button></div>}
    {!loaded ? <p className="text-secondary mb-0">Loading notifications...</p> : notifications.length ? <div className="task-notification-inbox">
      {notifications.map((notification) => <div className={`task-notification-item ${notification.read_at ? "" : "is-unread"}`} key={notification.id}>
        <div className="d-flex justify-content-between align-items-start gap-3 flex-wrap">
          <div className="fw-semibold">{notification.title} {!notification.read_at && <span className="task-unread-dot" aria-label="Unread" />}</div>
          <time className="text-secondary small" dateTime={notification.created_at}>{formatDateTime(notification.created_at)}</time>
        </div>
        <p className="text-secondary small task-notification-message mt-1 mb-2">{notification.message}</p>
        <div className="d-flex gap-3 align-items-center">
          <Link className="small fw-semibold" to={`/notifications#task-${notification.task_id}`} onClick={() => { void markRead(notification.id); }}>View task</Link>
          {!notification.read_at && <button type="button" className="btn btn-link btn-sm p-0" onClick={() => { void markRead(notification.id); }}>Mark as read</button>}
        </div>
      </div>)}
    </div> : <p className="text-secondary mb-0">Task assignments, submissions, and admin decisions will appear here automatically.</p>}
  </section>;
}
