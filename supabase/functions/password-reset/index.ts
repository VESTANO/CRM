import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const brevoApiKey = Deno.env.get("BREVO_API_KEY") || "";
const brevoSenderEmail = Deno.env.get("BREVO_SENDER_EMAIL") || "";
const brevoSenderName = Deno.env.get("BREVO_SENDER_NAME") || "Vestano CRM";
const defaultResetUrl = "https://vestano.online/login";
const resetRedirectUrl = Deno.env.get("PASSWORD_RESET_REDIRECT_URL") || defaultResetUrl;

function response(status = 200, body: Record<string, unknown> = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function escapeHtml(value: string) {
  const entities: Record<string, string> = {
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  };
  return value.replace(/[&<>'"]/g, (character) => entities[character] || character);
}

async function sha256(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function claimResetCooldown(adminClient: ReturnType<typeof createClient>, emailHash: string) {
  const { data, error } = await adminClient.rpc("crm_claim_password_reset", { p_email_hash: emailHash });
  if (error) throw error;
  return data === true;
}

async function sendBrevoResetEmail(email: string, actionLink: string) {
  const safeLink = escapeHtml(actionLink);
  const mail = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": brevoApiKey, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { email: brevoSenderEmail, name: brevoSenderName },
      to: [{ email }],
      subject: "Reset your Vestano CRM password",
      htmlContent: `<!doctype html><html><body style="margin:0;background:#f5f1e9;font-family:Arial,sans-serif;color:#172b3a"><main style="max-width:560px;margin:32px auto;background:#ffffff;padding:32px;border-radius:16px"><p style="margin:0 0 20px;font-size:13px;letter-spacing:1.5px;font-weight:700">VESTANO CRM</p><h1 style="margin:0 0 16px;font-size:28px">Reset your password</h1><p style="line-height:1.6">We received a request to reset your password. Use the button below to choose a new one.</p><p style="margin:28px 0"><a href="${safeLink}" style="display:inline-block;background:#d97736;color:#172b3a;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:700">Reset password</a></p><p style="line-height:1.6">This link can be used once and will expire. If you did not request it, you can safely ignore this email.</p></main></body></html>`,
    }),
  });
  if (!mail.ok) throw new Error(`Brevo rejected password-reset email (${mail.status}).`);
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return response(405, { error: "Use POST for password resets." });

  // Always use the same success response for valid requests so email addresses
  // cannot be discovered through this unauthenticated endpoint.
  const accepted = () => response(200, { ok: true });
  try {
    const body = await request.json().catch(() => ({}));
    const identity = String(body?.identity || body?.email || "").trim();
    if (!identity || identity.length > 256) return accepted();
    if (!supabaseUrl || !serviceRoleKey || !brevoApiKey || !brevoSenderEmail) {
      console.error("Password reset is missing required Brevo or Supabase configuration.");
      return response(503, { error: "Password recovery is temporarily unavailable." });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // Resolve exact case-insensitive identities in SQL rather than ILIKE URL
    // filters, where PostgREST also treats '*' as a wildcard alias. The private
    // resolver checks current profile activity for migrated email aliases.
    const { data: profiles, error: profileError } = await adminClient.rpc("crm_password_reset_profile", { p_identity: identity });
    if (profileError) throw profileError;
    if (!Array.isArray(profiles) || profiles.length !== 1 || !profiles[0].active) return accepted();
    const recipientEmail = profiles[0].email || "";
    if (!recipientEmail) return accepted();

    const emailHash = await sha256(recipientEmail.toLowerCase());
    // Claim before generating or sending mail so parallel requests cannot each
    // pass a read-then-write cooldown check. Provider failures retain the claim
    // for its bounded 60-second window, preventing a retry flood.
    if (!await claimResetCooldown(adminClient, emailHash)) return accepted();

    const { data: generated, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "recovery",
      email: recipientEmail,
      options: { redirectTo: resetRedirectUrl },
    });
    if (linkError || !generated.properties?.action_link) throw linkError || new Error("No recovery link was generated.");

    await sendBrevoResetEmail(recipientEmail, generated.properties.action_link);
    return accepted();
  } catch (error) {
    console.error("Password-reset request failed:", error instanceof Error ? error.message : error);
    // An account-dependent provider/database failure must not distinguish a
    // registered identity from an unknown one at this public endpoint.
    return accepted();
  }
});
