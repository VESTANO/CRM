import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { dispatchDueReminders } from "../_shared/reminder-delivery.ts";

const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(Deno.env.get("SUPABASE_URL") || "", serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const checked = async (query: any) => { const { data, error } = await query; if (error) throw new Error("Reminder storage is unavailable."); return data || []; };
const store = {
  claim: () => checked(db.rpc("claim_due_crm_reminders", { batch_size: 20 })),
  isCurrent: async (r: any) => (await checked(db.from("crm_reminders").select("id").eq("id", r.id).eq("delivery_status", "processing").eq("delivery_locked_at", r.delivery_locked_at).eq("reminder_at", r.reminder_at))).length > 0,
  subscriptions: (owner: string) => checked(db.from("crm_push_subscriptions").select("*").eq("owner_id", owner)),
  deliveries: (id: number) => checked(db.from("crm_reminder_deliveries").select("*").eq("reminder_id", id)),
  expire: (id: number) => checked(db.from("crm_push_subscriptions").delete().eq("id", id)),
  saveDelivery: async (id: number, s: any, status: string, lastError: string, attempts: number, now: Date) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.endpoint));
    const endpointHash = Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("");
    // Expired subscription rows were removed; keep the delivery audit without its FK.
    const values = { reminder_id: id, subscription_id: status === "expired" ? null : s.id, endpoint_hash: endpointHash, status, last_error: lastError, attempt_count: attempts, last_attempt_at: now.toISOString() };
    if (status === "expired") await checked(db.from("crm_reminder_deliveries").insert(values));
    else await checked(db.from("crm_reminder_deliveries").upsert(values, { onConflict: "reminder_id,subscription_id" }));
  },
  finish: (r: any, values: any) => checked(db.from("crm_reminders").update(values).eq("id", r.id).eq("delivery_status", "processing").eq("delivery_locked_at", r.delivery_locked_at).eq("reminder_at", r.reminder_at)),
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  // Gateway JWT verification remains enabled. A separate, narrowly scoped
  // server-only token also prevents ordinary CRM sessions invoking delivery.
  const dispatchToken = Deno.env.get("REMINDER_DISPATCH_TOKEN");
  if (!dispatchToken || request.headers.get("X-Reminder-Dispatch-Token") !== dispatchToken) return new Response(null, { status: 401 });
  const publicKey = Deno.env.get("WEBPUSH_VAPID_PUBLIC_KEY"), privateKey = Deno.env.get("WEBPUSH_VAPID_PRIVATE_KEY"), subject = Deno.env.get("WEBPUSH_VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) return Response.json({ error: "Push delivery is not configured." }, { status: 503 });
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    const body = await request.json().catch(() => ({}));
    if (body.mode === "health") {
      const { count, error } = await db.from("crm_reminders").select("id", { count: "exact", head: true }).is("sent_at", null).lte("reminder_at", new Date().toISOString()).in("delivery_status", ["pending", "retrying", "processing", "no_subscriptions"]);
      if (error) throw error;
      return Response.json({ configured: true, due: count || 0 });
    }
    const result = await dispatchDueReminders(store, async (subscription: any, payload: any) => {
      const details = webpush.generateRequestDetails({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(payload), {
        TTL: 86400, vapidDetails: { subject, publicKey, privateKey },
      });
      const response = await fetch(details.endpoint, { method: details.method, headers: details.headers, body: details.body, signal: AbortSignal.timeout(10000), redirect: "error" });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error("Push service rejected delivery."), { statusCode: response.status });
    });
    return Response.json(result);
  } catch { return Response.json({ error: "Reminder delivery could not complete; its lease will be retried." }, { status: 500 }); }
});
