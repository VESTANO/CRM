import OvertimePanel from "../components/OvertimePanel.jsx";
import { useAuth } from "../hooks/useAuth.jsx";

export default function Overtime() {
  const { user } = useAuth();
  const admin = Boolean(user?.is_admin);
  return <>
    <div className="page-header mb-4">
      <div className="eyebrow">WORKFORCE MANAGEMENT</div>
      <h1 className="h2 mb-2">Overtime</h1>
      <p className="text-secondary mb-0">{admin ? "Review employee overtime requests and approvals." : "Request and track overtime for your working days."}</p>
    </div>
    <OvertimePanel admin={admin} />
  </>;
}
