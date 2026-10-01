import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { adminApi } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import PasswordInput from "../components/PasswordInput.jsx";

export default function AdminUserForm() {
  const { userId } = useParams();
  const edit = Boolean(userId);
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [values, setValues] = useState({ username: "", email: "", is_active: true, password1: "", password2: "" });
  const [errors, setErrors] = useState({});

  useEffect(() => {
    if (edit) adminApi.detail(userId).then(({ data }) => setValues({ ...data, password1: "", password2: "" }));
  }, [edit, userId]);

  const change = (event) => setValues((current) => ({
    ...current,
    [event.target.name]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
  }));

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    try {
      const response = edit
        ? await adminApi.update(userId, { username: values.username, email: values.email, is_active: values.is_active }, csrfToken)
        : await adminApi.createUser(values, csrfToken);
      navigate(`/admin-panel/users/${response.data.id}`);
    } catch (error) {
      setErrors(error.response?.data?.errors || { non_field_errors: ["Unable to save user."] });
    }
  };

  return <>
    <div className="page-header mb-4"><h1 className="h2">{edit ? "Edit User" : "Add User"}</h1><p className="text-secondary">{edit ? "Update account details and active status." : "Create a normal CRM user account."}</p></div>
    <div className="panel"><form onSubmit={submit}>
      {["username", "email"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "username" ? "Username" : "Email"}</label><input id={`user-${name}`} className="form-control" name={name} type={name} value={values[name] || ""} onChange={change} /><FieldErrors errors={errors[name]} /></div>)}
      {!edit && ["password1", "password2"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "password1" ? "Password" : "Confirm password"}</label><PasswordInput id={`user-${name}`} name={name} value={values[name]} onChange={change} autoComplete={name === "password1" ? "new-password" : "new-password"} /><FieldErrors errors={errors[name]} /></div>)}
      <div className="form-check form-switch mb-3"><input id="user-active" className="form-check-input" type="checkbox" name="is_active" checked={values.is_active} onChange={change} /><label className="form-check-label" htmlFor="user-active">Active status</label></div>
      <div className="d-flex flex-wrap gap-2"><button className="btn btn-primary">{edit ? "Save Changes" : "Create User"}</button><Link className="btn btn-outline-secondary" to={edit ? `/admin-panel/users/${userId}` : "/admin-panel"}>Cancel</Link></div>
    </form></div>
  </>;
}

function FieldErrors({ errors }) {
  return (errors || []).map((error) => <div className="text-danger small mt-2" key={error}>{error}</div>);
}
