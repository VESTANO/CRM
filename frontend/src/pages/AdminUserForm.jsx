import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { adminApi, peekCachedResponse } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import PasswordInput from "../components/PasswordInput.jsx";

export default function AdminUserForm() {
  const { userId } = useParams();
  const [searchParams] = useSearchParams();
  const edit = Boolean(userId);
  const navigate = useNavigate();
  const { csrfToken, user: signedInUser } = useAuth();
  const cachedUser = edit ? peekCachedResponse(`/admin/users/${userId}/`)?.data : null;
  const [values, setValues] = useState(() => cachedUser ? { ...cachedUser, role: cachedUser.role || (cachedUser.is_superuser ? "super_admin" : cachedUser.is_admin ? "admin" : "employee"), password1: "", password2: "" } : { username: "", email: "", role: searchParams.get("role") === "super_admin" ? "super_admin" : searchParams.get("role") === "admin" ? "admin" : "employee", store_id: searchParams.get("store") || "", is_active: true, password1: "", password2: "" });
  const [errors, setErrors] = useState({});
  const [originalRole, setOriginalRole] = useState(cachedUser?.role || "");
  const [stores, setStores] = useState([]);
  const [storeError, setStoreError] = useState("");
  const [loading, setLoading] = useState(edit && !cachedUser);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!edit) { setLoading(false); return; }
    setLoading(!peekCachedResponse(`/admin/users/${userId}/`));
    adminApi.detail(userId)
      .then(({ data }) => {
        const role = data.role || (data.is_superuser ? "super_admin" : data.is_admin ? "admin" : "employee");
        setOriginalRole(role);
        setValues({ ...data, role, password1: "", password2: "" });
      })
      .catch(() => setErrors({ non_field_errors: ["Unable to load user details. Please reload this page."] }))
      .finally(() => setLoading(false));
  }, [edit, userId]);

  const needsStore = edit && originalRole === "super_admin" && values.role !== "super_admin";
  useEffect(() => {
    if (!needsStore || !signedInUser?.is_superuser) return;
    let active = true;
    adminApi.stores().then(({ data }) => { if (active) { setStores(data.results || []); setStoreError(""); } })
      .catch(() => { if (active) setStoreError("Unable to load stores. Reload before changing this account's role."); });
    return () => { active = false; };
  }, [needsStore, signedInUser?.is_superuser]);

  const change = (event) => setValues((current) => ({
    ...current,
    [event.target.name]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
  }));

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    const username = String(values.username || "").trim();
    if (!username) {
      setErrors({ username: ["Enter a username."] });
      return;
    }
    if (needsStore && !values.store_id) { setErrors({ store_id: ["Choose a store for this account."] }); return; }
    setSaving(true);
    try {
      // The admin overview preloads this list, so this normally resolves from
      // memory.  Validate before the create request so the form never reloads
      // or loses entered values for a duplicate username.
      const { data: users } = await adminApi.listUsers();
      const normalizedUsername = username.toLocaleLowerCase();
      const duplicate = (users.results || []).find((user) => (
        user.id !== userId && String(user.username || "").trim().toLocaleLowerCase() === normalizedUsername
      ));
      if (duplicate) {
        setErrors({ username: ["This username is already in use. Choose a different username."] });
        return;
      }
      const response = edit
        ? await adminApi.update(userId, { username, email: values.email, role: values.role, store_id: values.store_id, is_active: values.is_active }, csrfToken)
        : await adminApi.createUser({ ...values, username }, csrfToken);
      navigate(`/admin-panel/users/${response.data.id}`);
    } catch (error) {
      setErrors(error.response?.data?.errors || { non_field_errors: ["Unable to save user."] });
    } finally {
      setSaving(false);
    }
  };

  return <>
    <div className="page-header mb-4"><h1 className="h2">{edit ? "Edit User" : values.role === "super_admin" ? "Add Super Admin" : values.role === "admin" ? "Add Admin" : "Add User"}</h1><p className="text-secondary">{edit ? "Update account details, access role, and active status." : values.role === "super_admin" ? "This is a global account, independent of every store. Its email is used for password recovery." : "This account will be created in the store you selected."}</p></div>
    <div className="panel admin-form-panel">{loading ? <p className="mb-0" role="status">Loading user details…</p> : <form onSubmit={submit}>
      {errors.non_field_errors && <div className="alert alert-danger" role="alert"><FieldErrors errors={errors.non_field_errors} /></div>}
      {["username", "email"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "username" ? "Username" : "Email"}</label><input id={`user-${name}`} className="form-control" name={name} type={name === "email" ? "email" : "text"} value={values[name] || ""} onChange={change} /><FieldErrors errors={errors[name]} /></div>)}
      <div className="mb-3"><label className="form-label" htmlFor="user-role">Role</label><select id="user-role" className="form-select" name="role" value={values.role} onChange={change} disabled={values.role === "super_admin" && !signedInUser?.is_superuser}><option value="employee">User</option><option value="admin">Admin</option>{(signedInUser?.is_superuser || values.role === "super_admin") && <option value="super_admin">Super Admin</option>}</select>{values.role === "super_admin" && <div className="form-text">Super Admin is a global role and is not assigned to a store. Existing business records stay in their original store.</div>}<FieldErrors errors={errors.role} /></div>
      {needsStore && <div className="mb-3"><label className="form-label" htmlFor="user-store">Store</label><select id="user-store" className="form-select" name="store_id" value={values.store_id || ""} onChange={change} required><option value="">Choose a store</option>{stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}</select><div className="form-text">The account needs a store for its new role. Historical business records keep their original store.</div><FieldErrors errors={errors.store_id} />{storeError && <div className="text-danger small mt-2" role="alert">{storeError}</div>}</div>}
      {!edit && ["password1", "password2"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "password1" ? "Password" : "Confirm password"}</label><PasswordInput id={`user-${name}`} name={name} value={values[name]} onChange={change} autoComplete={name === "password1" ? "new-password" : "new-password"} /><FieldErrors errors={errors[name]} /></div>)}
      <div className="form-check form-switch mb-3"><input id="user-active" className="form-check-input" type="checkbox" name="is_active" checked={values.is_active} onChange={change} /><label className="form-check-label" htmlFor="user-active">Active status</label></div>
      <div className="d-flex flex-wrap gap-2"><button className="btn btn-primary" disabled={saving || (edit && !values.id)}>{saving ? "Saving…" : edit ? "Save Changes" : values.role === "super_admin" ? "Create Super Admin" : "Create User"}</button><Link className="btn btn-outline-secondary" to={edit ? `/admin-panel/users/${userId}` : signedInUser?.is_superuser ? "/admin-panel/stores" : "/admin-panel"}>Cancel</Link></div>
    </form>}</div>
  </>;
}

function FieldErrors({ errors }) {
  return (errors || []).map((error) => <div className="text-danger small mt-2" key={error}>{error}</div>);
}
