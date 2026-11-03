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
  deliveries: (id: number, revision: number) => checked(db.from("crm_reminder_deliveries").select("*").eq("reminder_id", id).eq("delivery_revision", revision)),
  expire: (id: number) => checked(db.from("crm_push_subscriptions").delete().eq("id", id)),
  prepareDelivery: async (r: any, s: any, now: Date) => {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.endpoint));
    const endpointHash = Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, "0")).join("");
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const receiptToken = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const tokenDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(receiptToken));
    const tokenHash = Array.from(new Uint8Array(tokenDigest), (v) => v.toString(16).padStart(2, "0")).join("");
    const rows = await checked(db.from("crm_reminder_deliveries").upsert({
      reminder_id: r.id, subscription_id: s.id, delivery_revision: r.delivery_revision || 1,
      endpoint_hash: endpointHash, receipt_token_hash: tokenHash,
      receipt_expires_at: new Date(now.getTime() + 8 * 86400000).toISOString(),
    }, { onConflict: "reminder_id,subscription_id,delivery_revision" }).select("id"));
    return { id: rows[0].id, receiptToken, receiptUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/reminder-receipt` };
  },
  saveDelivery: (_id: number, _s: any, status: string, lastError: string, attempts: number, now: Date, deliveryId: number) => checked(db.from("crm_reminder_deliveries").update({ status, last_error: lastError, attempt_count: attempts, last_attempt_at: now.toISOString() }).eq("id", deliveryId)),
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
        TTL: 604800, urgency: "high", vapidDetails: { subject, publicKey, privateKey },
      });
      const response = await fetch(details.endpoint, { method: details.method, headers: details.headers, body: details.body, signal: AbortSignal.timeout(10000), redirect: "error" });
      await response.body?.cancel();
      if (!response.ok) throw Object.assign(new Error("Push service rejected delivery."), { statusCode: response.status });
    });
    return Response.json(result);
  } catch { return Response.json({ error: "Reminder delivery could not complete; its lease will be retried." }, { status: 500 }); }
});
