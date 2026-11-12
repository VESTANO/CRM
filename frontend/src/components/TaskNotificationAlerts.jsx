import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useTaskNotifications } from "../hooks/useTaskNotifications.js";

function NotificationAlert({ notification, onOpen, onDismiss }) {
  useEffect(() => {
    let timer;
    const visible = () => {
      window.clearTimeout(timer);
      if (!document.hidden) timer = window.setTimeout(() => onDismiss(notification.id), 3000);
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [notification.id, onDismiss]);
  return <div className={`task-notification-alert task-notification-${notification.kind}`} role="status">
    <div className="d-flex justify-content-between align-items-start gap-3">
      <div className="fw-semibold">{notification.title}</div>
      <button type="button" className="btn-close flex-shrink-0" aria-label={`Dismiss ${notification.title}`} onClick={() => onDismiss(notification.id)} />
    </div>
    <p className="small mt-2 mb-2 task-notification-message">{notification.message}</p>
    <Link className="btn btn-outline-primary btn-sm" to={`/notifications#task-${notification.task_id}`} onClick={() => onOpen(notification.id)}>View task</Link>
  </div>;
}

export default function TaskNotificationAlerts() {
  const { alerts, markRead, dismissAlert } = useTaskNotifications();
  return <div className="task-notification-alerts" aria-label="New task notifications" aria-live="polite" aria-relevant="additions">
    {alerts.map((notification) => <NotificationAlert key={notification.id} notification={notification} onDismiss={dismissAlert}
      onOpen={(id) => { dismissAlert(id); void markRead(id); }} />)}
  </div>;
}
