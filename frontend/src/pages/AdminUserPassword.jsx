import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import PasswordInput from "../components/PasswordInput.jsx";

export default function AdminUserPassword() {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [values, setValues] = useState({ password1: "", password2: "" });
  const [errors, setErrors] = useState({});

  const submit = async (event) => {
    event.preventDefault();
    try {
      await adminApi.action(userId, "password", values, csrfToken);
      navigate(`/admin-panel/users/${userId}`);
    } catch (error) {
      setErrors(error.response?.data?.errors || { detail: ["Unable to reset password."] });
    }
  };

  return <div className="panel">
    <h1 className="h2 mb-2">Reset Password</h1>
    <p className="text-secondary">Set a new password. Existing passwords are never displayed.</p>
    <form onSubmit={submit}>
      {["password1", "password2"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`reset-${name}`}>{name === "password1" ? "Password" : "Confirm password"}</label><PasswordInput id={`reset-${name}`} name={name} value={values[name]} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))} autoComplete="new-password" /><FieldErrors errors={errors[name]} /></div>)}
      <FieldErrors errors={errors.detail} />
      <div className="d-flex flex-wrap gap-2"><button className="btn btn-primary">Reset Password</button><Link className="btn btn-outline-secondary" to={`/admin-panel/users/${userId}`}>Cancel</Link></div>
    </form>
  </div>;
}

function FieldErrors({ errors }) {
  return (errors || []).map((error) => <div className="text-danger small mt-2" key={error}>{error}</div>);
}
