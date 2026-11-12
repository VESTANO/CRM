import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  const requestedStoreId = searchParams.get("store") || "";
  const requestedRole = searchParams.get("role") || "";
  const creatingSuperAdmin = !edit && requestedRole === "super_admin" && !requestedStoreId;
  const [values, setValues] = useState(() => cachedUser ? { ...cachedUser, designation: cachedUser.designation || "", role: cachedUser.role || (cachedUser.is_superuser ? "super_admin" : cachedUser.is_admin ? "admin" : "employee"), password1: "", password2: "" } : { username: "", email: "", designation: "", role: creatingSuperAdmin ? "super_admin" : requestedRole === "admin" ? "admin" : "employee", store_id: requestedStoreId, is_active: true, password1: "", password2: "" });
  const [errors, setErrors] = useState({});
  const [originalRole, setOriginalRole] = useState(cachedUser?.role || "");
  const [designations, setDesignations] = useState([]);
  const [designationDraft, setDesignationDraft] = useState("");
  const [designationSaving, setDesignationSaving] = useState(false);
  const [loading, setLoading] = useState(edit && !cachedUser);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!edit) { setLoading(false); return; }
    setLoading(!peekCachedResponse(`/admin/users/${userId}/`));
    adminApi.detail(userId)
      .then(({ data }) => {
        const role = data.role || (data.is_superuser ? "super_admin" : data.is_admin ? "admin" : "employee");
        setOriginalRole(role);
        setValues({ ...data, designation: data.designation || "", role, password1: "", password2: "" });
      })
      .catch(() => setErrors({ non_field_errors: ["Unable to load user details. Please reload this page."] }))
      .finally(() => setLoading(false));
  }, [edit, userId]);

  // Designations describe staff jobs (for example, Sales). Administrator
  // accounts manage a store and therefore do not need a designation.
  const designationRequired = values.role === "employee";
  const designationStoreId = designationRequired ? values.store_id || signedInUser?.store_id || searchParams.get("store") || "" : "";
  useEffect(() => {
    if (!designationStoreId) { setDesignations([]); return undefined; }
    let active = true;
    adminApi.designations(designationStoreId)
      .then(({ data }) => {
        if (!active) return;
        setDesignations(data.results || []);
        setErrors((current) => ({ ...current, designation: undefined }));
      })
      .catch((error) => {
        if (!active) return;
        const detail = error.response?.data?.detail || "Unable to load designations. Please retry.";
        setErrors((current) => ({ ...current, designation: [detail] }));
      });
    return () => { active = false; };
  }, [designationStoreId]);

  const change = (event) => setValues((current) => ({
    ...current,
    [event.target.name]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    ...(event.target.name === "store_id" ? { designation: "" } : {}),
  }));

  const addDesignation = async () => {
    const name = designationDraft.trim().replace(/\s+/g, " ");
    if (!name || !designationStoreId || designationSaving) return;
    setDesignationSaving(true);
    setErrors((current) => ({ ...current, designation: undefined }));
    try {
      const { data } = await adminApi.createDesignation(name, designationStoreId, csrfToken);
      setDesignations((current) => [...current.filter((item) => item.id !== data.id), data].sort((first, second) => first.name.localeCompare(second.name)));
      setValues((current) => ({ ...current, designation: data.name }));
      setDesignationDraft("");
    } catch (error) {
      setErrors((current) => ({ ...current, designation: [error.response?.data?.detail || "Unable to add this designation."] }));
    } finally {
      setDesignationSaving(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setErrors({});
    const username = String(values.username || "").trim();
    if (!username) {
      setErrors({ username: ["Enter a username."] });
      return;
    }
    if (designationRequired && !String(values.designation || "").trim()) {
      setErrors({ designation: ["Choose a designation."] });
      return;
    }
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
        ? await adminApi.update(userId, { username, email: values.email, designation: designationRequired ? values.designation : "", role: values.role, store_id: values.store_id, is_active: values.is_active }, csrfToken)
        : await adminApi.createUser({ ...values, username }, csrfToken);
      navigate(`/admin-panel/users/${response.data.id}`);
    } catch (error) {
      const serverErrors = error.response?.data?.errors;
      const detail = String(error.response?.data?.detail || "").trim();
      const unavailableMessage = error.code === "ECONNABORTED"
        ? "The CRM request timed out before it could confirm the save. Open the Users list to check for this account before trying again."
        : "The CRM service could not be reached, so the save status is unknown. Open the Users list to check for this account before trying again.";
      setErrors(serverErrors || { non_field_errors: [detail || unavailableMessage] });
    } finally {
      setSaving(false);
    }
  };

  // Store Admins may only manage regular users in their own store.  This is
  // also enforced by the API; the redirect prevents an editable admin form
  // being shown if a URL is entered directly.
  if (!loading && signedInUser && !signedInUser.is_superuser && (originalRole === "admin" || originalRole === "super_admin" || values.role !== "employee")) {
    return <Navigate to="/admin-panel/users" replace />;
  }

  const fallbackPath = edit ? `/admin-panel/users/${userId}` : signedInUser?.is_superuser ? "/admin-panel/stores" : "/admin-panel";
  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate(fallbackPath);
  };

  return <>
    <div className="page-header mb-4 d-flex flex-wrap justify-content-between align-items-start gap-3"><div><h1 className="h2">{edit ? "Edit User" : values.role === "super_admin" ? "Add Super Admin" : values.role === "admin" ? "Add Admin" : "Add User"}</h1><p className="text-secondary mb-0">{edit ? "Update account details, access role, and active status." : values.role === "super_admin" ? "This is a global account, independent of every store. Its email is used for password recovery." : "This account will be created in the store you selected."}</p></div><button className="btn btn-outline-secondary" type="button" onClick={goBack}><i className="bi bi-arrow-left me-1" aria-hidden="true" />Back</button></div>
    <div className="panel admin-form-panel">{loading ? <p className="mb-0" role="status">Loading user details…</p> : <form onSubmit={submit}>
      {errors.non_field_errors && <div className="alert alert-danger" role="alert"><FieldErrors errors={errors.non_field_errors} /></div>}
      {["username", "email"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "username" ? "Username" : "Email"}</label><input id={`user-${name}`} className="form-control" name={name} type={name === "email" ? "email" : "text"} value={values[name] || ""} onChange={change} /><FieldErrors errors={errors[name]} /></div>)}
      <div className="mb-3"><label className="form-label" htmlFor="user-role">Role</label>{values.role === "super_admin" ? <input id="user-role" className="form-control" value="Super Admin" readOnly aria-readonly="true" /> : <select id="user-role" className="form-select" name="role" value={values.role} onChange={change}><option value="employee">User</option>{signedInUser?.is_superuser && <option value="admin">Admin</option>}</select>}{values.role === "super_admin" && <div className="form-text">Super Admin is a protected global role and is managed separately from store accounts.</div>}<FieldErrors errors={errors.role} /></div>
      {designationRequired && <div className="mb-3"><label className="form-label" htmlFor="user-designation">Designation *</label><select id="user-designation" className="form-select" name="designation" value={values.designation || ""} onChange={change} disabled={!designationStoreId} required><option value="">No designation selected</option>{designations.map((designation) => <option key={designation.id} value={designation.name}>{designation.name}</option>)}</select>{designationStoreId ? <div className="input-group mt-2"><input className="form-control" value={designationDraft} maxLength="80" placeholder="Add a new designation" onChange={(event) => setDesignationDraft(event.target.value)} /><button className="btn btn-outline-primary designation-add-button" type="button" disabled={designationSaving || !designationDraft.trim()} onClick={addDesignation}>{designationSaving ? "Adding…" : "Add"}</button></div> : <div className="form-text">Choose a store before selecting or adding a designation.</div>}<FieldErrors errors={errors.designation} /></div>}
      {!edit && ["password1", "password2"].map((name) => <div className="mb-3" key={name}><label className="form-label" htmlFor={`user-${name}`}>{name === "password1" ? "Password" : "Confirm password"}</label><PasswordInput id={`user-${name}`} name={name} value={values[name]} onChange={change} autoComplete={name === "password1" ? "new-password" : "new-password"} /><FieldErrors errors={errors[name]} /></div>)}
      <div className="form-check form-switch mb-3"><input id="user-active" className="form-check-input" type="checkbox" name="is_active" checked={values.is_active} onChange={change} /><label className="form-check-label" htmlFor="user-active">Active status</label></div>
      <div className="d-flex flex-wrap gap-2"><button className="btn btn-primary" disabled={saving || (edit && !values.id)}>{saving ? "Saving…" : edit ? "Save Changes" : values.role === "super_admin" ? "Create Super Admin" : "Create User"}</button><Link className="btn btn-outline-secondary" to={fallbackPath}>Cancel</Link></div>
    </form>}</div>
  </>;
}

function FieldErrors({ errors }) {
  return (errors || []).map((error) => <div className="text-danger small mt-2" key={error}>{error}</div>);
}
