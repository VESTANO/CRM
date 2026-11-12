import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { adminApi, invalidateApiCache } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";
import { selectStore } from "../services/storeContext.js";
import { useDialogFocus } from "../hooks/useDialogFocus.js";
import "../styles/store-create.css";
import { defaultStoreFeatures, storeFeatureOptions } from "../services/storeFeatures.js";

const emptyStore = () => ({ name: "", contact_email: "", contact_phone: "", contact_person: "", address_line1: "", features: { ...defaultStoreFeatures } });

function FeatureSwitches({ features, onChange, prefix }) {
  return <fieldset className="store-feature-list"><legend className="h6">Store access</legend><p className="text-secondary small">Choose which sections this store can use.</p><div className="row g-2">{storeFeatureOptions.map(({ key, label }) => <div className="col-12 col-sm-6" key={key}><div className="form-check form-switch store-feature-switch"><input className="form-check-input" type="checkbox" role="switch" id={`${prefix}-${key}`} checked={Boolean(features[key])} onChange={(event) => onChange(key, event.target.checked)} /><label className="form-check-label" htmlFor={`${prefix}-${key}`}>{label}</label></div></div>)}</div></fieldset>;
}

export default function AdminStores() {
  const { user, csrfToken } = useAuth();
  const navigate = useNavigate();
  const [stores, setStores] = useState(null);
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [draft, setDraft] = useState(emptyStore);
  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [editingFeatures, setEditingFeatures] = useState(null);
  const [featureDraft, setFeatureDraft] = useState({ ...defaultStoreFeatures });
  const [limitDraft, setLimitDraft] = useState({ admin_limit: "", user_limit: "" });
  const [featureError, setFeatureError] = useState("");
  const dialogRef = useRef(null);
  const nameRef = useRef(null);
  const isSuperAdmin = Boolean(user?.is_superuser);
  useDialogFocus({ open: creating, dialogRef, initialFocusRef: nameRef, onCancel: () => setCreating(false), busy: saving });
  const featuresDialogRef = useRef(null);
  useDialogFocus({ open: Boolean(editingFeatures), dialogRef: featuresDialogRef, onCancel: () => setEditingFeatures(null), busy: saving });

  const load = async () => {
    setError("");
    try { const { data } = await adminApi.stores(); setStores(data.results || []); setSetupAvailable(data.capabilities?.store_features === true); }
    catch (requestError) { setError(requestError.response?.status === 403 ? "Super Admin access required." : "Unable to load stores."); setStores(null); }
  };
  useEffect(() => { load(); }, []);

  const verifyStoreSetup = async () => {
    if (setupAvailable) return true;
    const { data } = await adminApi.stores({ fresh: true });
    const available = data.capabilities?.store_features === true;
    setSetupAvailable(available);
    return available;
  };

  const create = async (event) => {
    event.preventDefault();
    if (!isSuperAdmin || saving) return;
    setSaving(true); setCreateErrors({});
    try {
      if (!(await verifyStoreSetup())) { setCreateErrors({ general: ["Store setup is awaiting the server update. Your details have not been saved."] }); return; }
      await adminApi.createStore({ ...Object.fromEntries(Object.entries(draft).filter(([key]) => key !== "features").map(([key, value]) => [key, value.trim()])), features: draft.features }, csrfToken);
      setCreating(false); setDraft(emptyStore()); invalidateApiCache("/admin/stores/"); await load();
    } catch (requestError) {
      setCreateErrors(requestError.response?.data?.errors || { general: [requestError.response?.data?.detail || "Unable to create the store."] });
    } finally { setSaving(false); }
  };
  const saveFeatures = async (event) => {
    event.preventDefault();
    if (!editingFeatures || saving) return;
    setSaving(true); setFeatureError("");
    try {
      if (!(await verifyStoreSetup())) { setFeatureError("Store access is awaiting the server update. Your changes have not been saved."); return; }
      await adminApi.updateStoreFeatures(editingFeatures.id, featureDraft, limitDraft, csrfToken);
      invalidateApiCache("/admin/stores/", "/store/features/");
      window.dispatchEvent(new Event("crm:store-features-updated"));
      setEditingFeatures(null);
      await load();
    } catch (requestError) {
      setFeatureError(requestError.response?.data?.detail || "Unable to update store access.");
    } finally { setSaving(false); }
  };
  const openStore = (storeId) => { selectStore(storeId); invalidateApiCache(); navigate("/dashboard"); };

  if (stores === null && !error) return <LoadingPanel label="Loading stores" />;
  if (stores === null) return <RequestError message={error} onRetry={load} />;
  return <>
    <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4"><div><div className="text-secondary small mb-1">{isSuperAdmin ? "Super Administration" : "Administration"}</div><h1 className="h2 mb-2">Stores &amp; access</h1><p className="text-secondary mb-0">Accounts and business data are separated by store.</p></div>{isSuperAdmin && <Link className="btn btn-primary" to="/admin-panel/users/add?role=super_admin">Add Super Admin</Link>}</div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {isSuperAdmin && <div className="mb-4"><button className="btn btn-primary" type="button" onClick={() => { setDraft(emptyStore()); setCreateErrors({}); setCreating(true); }}><i className="bi bi-plus-lg me-2" aria-hidden="true" />Add store</button></div>}
    <section className="panel"><h2 className="h5">{isSuperAdmin ? "All stores" : "Your store"}</h2><div className="d-grid gap-3">{stores.map((store) => <article key={store.id} className="store-card border rounded p-3"><div className="d-flex flex-wrap justify-content-between gap-2 align-items-center"><div><h3 className="h6 mb-1">{store.name}</h3><p className="text-secondary small mb-0">{store.contact_person || store.contact_email || store.contact_phone ? [store.contact_person, store.contact_email, store.contact_phone].filter(Boolean).join(" · ") : "Manage the Admins and Users for this store."}</p>{store.address_line1 && <p className="text-secondary small mb-0">{[store.address_line1, store.city, store.state, store.postal_code].filter(Boolean).join(", ")}</p>}</div><div className="d-flex flex-wrap gap-2"><Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users?store=${store.id}`}>Manage users</Link><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => openStore(store.id)}>Open store</button>{isSuperAdmin && <><button className="btn btn-outline-primary btn-sm" type="button" onClick={() => { setFeatureDraft({ ...defaultStoreFeatures, ...store.features }); setLimitDraft({ admin_limit: store.admin_limit ?? "", user_limit: store.user_limit ?? "" }); setFeatureError(""); setEditingFeatures(store); }}>Manage access</button><Link className="btn btn-primary btn-sm" to={`/admin-panel/users/add?store=${store.id}&role=admin`}>Add Admin</Link></>}</div></div></article>)}</div></section>
    {creating && createPortal(<><div className="modal d-block store-create-modal" ref={dialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="store-create-title"><div className="modal-dialog modal-dialog-centered"><form className="modal-content" onSubmit={create}><div className="modal-header"><div><h2 className="modal-title h5 mb-0" id="store-create-title">Add store</h2><p className="text-secondary small mb-0">Enter the store details and choose the sections it can access.</p></div><button className="btn-close" type="button" aria-label="Close store form" onClick={() => setCreating(false)} disabled={saving} /></div><div className="modal-body"><div className="row g-3" role="group" aria-label="Store details">{[
      ["name", "Store name", "text", 120],
      ["contact_email", "Email", "email", 254], ["contact_phone", "Phone number", "tel", 20],
      ["contact_person", "Contact person (optional)", "text", 120], ["address_line1", "Address (optional)", "text", 240],
    ].map(([key, label, type, maxLength]) => <div className={`col-12 ${key === "name" ? "" : "col-sm-6"}`} key={key}><label className="form-label" htmlFor={`store-${key}`}>{label}</label><input className={`form-control ${createErrors[key] ? "is-invalid" : ""}`} id={`store-${key}`} ref={key === "name" ? nameRef : undefined} type={type} maxLength={maxLength} required={["name", "contact_email", "contact_phone"].includes(key)} value={draft[key]} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} autoComplete={key === "contact_email" ? "email" : key === "contact_phone" ? "tel" : key === "postal_code" ? "postal-code" : "off"} />{createErrors[key] && <div className="invalid-feedback">{createErrors[key].join(" ")}</div>}</div>)}</div><FeatureSwitches prefix="new-store" features={draft.features} onChange={(key, enabled) => setDraft((current) => ({ ...current, features: { ...current.features, [key]: enabled } }))} />{createErrors.features && <div className="alert alert-danger mt-3" role="alert">{createErrors.features.join(" ")}</div>}{createErrors.general && <div className="alert alert-danger mt-3 mb-0" role="alert">{createErrors.general.join(" ")}</div>}</div><div className="modal-footer"><button className="btn btn-outline-secondary" type="button" onClick={() => setCreating(false)} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? "Creating…" : "Create store"}</button></div></form></div></div><div className="modal-backdrop show store-create-backdrop" aria-hidden="true" /></>, document.body)}
    {editingFeatures && createPortal(<><div className="modal d-block store-create-modal" ref={featuresDialogRef} tabIndex="-1" role="dialog" aria-modal="true" aria-labelledby="store-access-title"><div className="modal-dialog modal-dialog-centered"><form className="modal-content" onSubmit={saveFeatures}><div className="modal-header"><div><h2 className="modal-title h5 mb-0" id="store-access-title">Manage access: {editingFeatures.name}</h2><p className="text-secondary small mb-0">Changes apply to everyone in this store.</p></div><button className="btn-close" type="button" aria-label="Close access settings" onClick={() => setEditingFeatures(null)} disabled={saving} /></div><div className="modal-body"><fieldset className="mb-4"><legend className="h6">Account limits</legend><p className="text-secondary small">Set the maximum active accounts allowed in this store. Leave blank for no limit.</p><div className="row g-3"><div className="col-sm-6"><label className="form-label" htmlFor="store-admin-limit">Maximum Admin accounts</label><input className="form-control" id="store-admin-limit" type="number" min="0" max="100000" inputMode="numeric" value={limitDraft.admin_limit} onChange={(event) => setLimitDraft((current) => ({ ...current, admin_limit: event.target.value }))} /></div><div className="col-sm-6"><label className="form-label" htmlFor="store-user-limit">Maximum User accounts</label><input className="form-control" id="store-user-limit" type="number" min="0" max="100000" inputMode="numeric" value={limitDraft.user_limit} onChange={(event) => setLimitDraft((current) => ({ ...current, user_limit: event.target.value }))} /></div></div></fieldset><FeatureSwitches prefix="edit-store" features={featureDraft} onChange={(key, enabled) => setFeatureDraft((current) => ({ ...current, [key]: enabled }))} />{featureError && <div className="alert alert-danger" role="alert">{featureError}</div>}</div><div className="modal-footer"><button className="btn btn-outline-secondary" type="button" onClick={() => setEditingFeatures(null)} disabled={saving}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save access"}</button></div></form></div></div><div className="modal-backdrop show store-create-backdrop" aria-hidden="true" /></>, document.body)}
  </>;
}
