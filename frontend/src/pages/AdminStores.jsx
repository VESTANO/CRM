import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { adminApi, invalidateApiCache } from "../services/api.js";
import { useAuth } from "../hooks/useAuth.jsx";
import { LoadingPanel, RequestError } from "../components/RequestState.jsx";
import { clearSelectedStore, selectStore } from "../services/storeContext.js";

export default function AdminStores() {
  const { user, csrfToken } = useAuth();
  const navigate = useNavigate();
  const [stores, setStores] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const isSuperAdmin = Boolean(user?.is_superuser);

  const load = async () => {
    setError("");
    try { setStores((await adminApi.stores()).data.results || []); }
    catch (requestError) { setError(requestError.response?.status === 403 ? "Super Admin access required." : "Unable to load stores."); setStores(null); }
  };
  useEffect(() => { load(); }, []);

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setSaving(true); setError("");
    try {
      await adminApi.createStore({ name: name.trim() }, csrfToken);
      setName(""); invalidateApiCache("/admin/stores/"); await load();
    } catch (requestError) {
      setError(requestError.response?.data?.errors?.name?.[0] || "Unable to create the store.");
    } finally { setSaving(false); }
  };
  const openStore = (storeId) => { selectStore(storeId); invalidateApiCache(); navigate("/dashboard"); };

  if (stores === null && !error) return <LoadingPanel label="Loading stores" />;
  if (stores === null) return <RequestError message={error} onRetry={load} />;
  return <>
    <div className="page-header d-flex flex-wrap justify-content-between gap-3 mb-4"><div><div className="text-secondary small mb-1">Super Administration</div><h1 className="h2 mb-2">Stores</h1><p className="text-secondary mb-0">Accounts and business data are separated by store.</p></div><div className="d-flex gap-2"><Link className="btn btn-outline-secondary" to="/admin-panel/users" onClick={() => { clearSelectedStore(); invalidateApiCache(); }}>Manage users</Link><Link className="btn btn-primary" to="/admin-panel/users/add?role=super_admin">Add Super Admin</Link></div></div>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {isSuperAdmin && <form className="panel mb-4" onSubmit={create}><label className="form-label" htmlFor="store-name">New store name</label><div className="d-flex gap-2"><input id="store-name" className="form-control" value={name} onChange={(event) => setName(event.target.value)} maxLength="120" placeholder="Example: Store B" required /><button className="btn btn-primary text-nowrap" disabled={saving}>{saving ? "Creating…" : "Add store"}</button></div></form>}
    <section className="panel"><h2 className="h5">{isSuperAdmin ? "All stores" : "Your store"}</h2><div className="d-grid gap-3">{stores.map((store) => <article key={store.id} className="border rounded p-3"><div className="d-flex flex-wrap justify-content-between gap-2 align-items-center"><div><h3 className="h6 mb-1">{store.name}</h3><p className="text-secondary small mb-0">Manage the Admins and Users for this store.</p></div><div className="d-flex gap-2"><Link className="btn btn-outline-secondary btn-sm" to={`/admin-panel/users?store=${store.id}`}>Manage users</Link><button className="btn btn-outline-secondary btn-sm" type="button" onClick={() => openStore(store.id)}>Open store</button>{isSuperAdmin && <Link className="btn btn-primary btn-sm" to={`/admin-panel/users/add?store=${store.id}&role=admin`}>Add Admin</Link>}</div></div></article>)}</div></section>
  </>;
}
