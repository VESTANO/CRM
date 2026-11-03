import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const db = createClient(Deno.env.get("SUPABASE_URL") || "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: corsHeaders });
  if (Number(request.headers.get("content-length") || 0) > 1024) return new Response(null, { status: 413, headers: corsHeaders });
  try {
    const text = await request.text();
    if (text.length > 1024) return new Response(null, { status: 413, headers: corsHeaders });
    const { token, event } = JSON.parse(text);
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token) || !["received", "displayed", "clicked"].includes(event)) return new Response(null, { status: 400, headers: corsHeaders });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
    const { data, error } = await db.rpc("record_crm_reminder_receipt", { token_hash: hash, receipt_event: event });
    if (error) return new Response(null, { status: 503, headers: corsHeaders });
    return new Response(null, { status: data ? 204 : 404, headers: corsHeaders });
  } catch { return new Response(null, { status: 400, headers: corsHeaders }); }
});
