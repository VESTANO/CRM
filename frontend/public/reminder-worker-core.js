// Shared by the real Service Worker and isolated delivery tests.
self.createReminderWorker = ({ storage, showNotification, getNotifications, clients, fetchReceipt, baseUrl, now = Date.now }) => {
  const base = new URL(baseUrl);
  const targetUrl = (p) => {
    const fallback = new URL(`reminders${p.reminderId ? `?reminder=${p.reminderId}#reminder-${p.reminderId}` : ""}`, base);
    try { const url = new URL(p.path || p.url || fallback.href, base); return url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url.href : fallback.href; }
    catch { return fallback.href; }
  };
  const queueReceipt = async (p, event) => {
    const r = p.receipt;
    if (!r || !/^[A-Za-z0-9_-]{43}$/.test(r.token || "") || r.url !== "https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/reminder-receipt") return;
    await storage.put(`receipt:${r.token}:${event}`, { ...r, event, expires: now() + 8 * 86400000 });
  };
  const flush = async () => {
    for (const { key, value } of await storage.entries()) {
      if (!key.startsWith("receipt:")) continue;
      if (value.expires < now()) { await storage.remove(key); continue; }
      try { const r = await fetchReceipt(value.url, { token: value.token, event: value.event }); if (r.ok || [400, 404].includes(r.status)) await storage.remove(key); }
      catch { /* Offline receipts stay queued for the next push, activation, or app visit. */ }
    }
  };
  return {
    flush,
    bind: async (owner) => {
      await storage.put("owner", owner || null);
      for (const n of await getNotifications()) if (n.data?.ownerId && n.data.ownerId !== owner) n.close();
    },
    push: async (p) => {
      if (!p.ownerId || await storage.get("owner") !== p.ownerId) return;
      if (p.expiresAt && new Date(p.expiresAt).getTime() < now()) return;
      const key = `notified:${p.notificationKey || p.reminderId || p.tag}`;
      await queueReceipt(p, "received");
      // A reminder may have been rescheduled while its push was queued offline.
      // The scoped receipt endpoint rejects obsolete schedule revisions.
      if (p.receipt?.url === "https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/reminder-receipt") {
        try {
          const r = await fetchReceipt(p.receipt.url, { token: p.receipt.token, event: "received" });
          if (r.status === 404) { await storage.remove(`receipt:${p.receipt.token}:received`); return; }
          if (r.ok) await storage.remove(`receipt:${p.receipt.token}:received`);
        } catch { /* Preserve the queued receipt if connectivity drops during delivery. */ }
      }
      const prior = await storage.get(key);
      const tag = p.tag || `crm-reminder-${p.reminderId || "due"}`;
      const existing = await getNotifications({ tag });
      if (!prior && !existing.length) {
        const icon = base.pathname === "/" ? "/static/images/customer-crm.svg" : new URL("notification-icon.svg", base).href;
        await showNotification(p.title || "Customer CRM | Reminder", { body: p.body || "A reminder is due.", tag, icon, badge: icon, renotify: false, requireInteraction: true, data: { ...p, url: targetUrl(p) } });
      }
      await storage.put(key, now());
      await queueReceipt(p, "displayed");
      await flush();
    },
    click: async (p) => {
      if (p.ownerId && await storage.get("owner") !== p.ownerId) return;
      await queueReceipt(p, "clicked");
      const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => c.url.startsWith(base.href));
      if (existing) { await existing.navigate(targetUrl(p)); await existing.focus(); }
      else await clients.openWindow(targetUrl(p));
      await flush();
    },
    prune: async () => {
      for (const { key, value } of await storage.entries()) if (key.startsWith("notified:") && value < now() - 8 * 86400000) await storage.remove(key);
    },
  };
};
