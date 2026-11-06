import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const brevoApiKey = Deno.env.get("BREVO_API_KEY") || "";
const brevoSenderEmail = Deno.env.get("BREVO_SENDER_EMAIL") || "";
const brevoSenderName = Deno.env.get("BREVO_SENDER_NAME") || "Vestano CRM";
const defaultResetUrl = "https://vestano.online/login";
const resetRedirectUrl = Deno.env.get("PASSWORD_RESET_REDIRECT_URL") || defaultResetUrl;
const resetCooldownMs = 60_000;

function response(status = 200, body: Record<string, unknown> = { ok: true }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
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

async function isCoolingDown(adminClient: ReturnType<typeof createClient>, emailHash: string) {
  const { data, error } = await adminClient
    .from("crm_password_reset_requests")
    .select("requested_at")
    .eq("email_hash", emailHash)
    .maybeSingle();
  if (error) throw error;
  if (!data?.requested_at) return false;
  return Date.now() - new Date(data.requested_at).getTime() < resetCooldownMs;
}

async function recordRequest(adminClient: ReturnType<typeof createClient>, emailHash: string) {
  const { error } = await adminClient.from("crm_password_reset_requests").upsert({
    email_hash: emailHash,
    requested_at: new Date().toISOString(),
  });
  if (error) throw error;
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
    const email = String(body?.email || "").trim().toLowerCase();
    if (!validEmail(email)) return accepted();
    if (!supabaseUrl || !serviceRoleKey || !brevoApiKey || !brevoSenderEmail) {
      console.error("Password reset is missing required Brevo or Supabase configuration.");
      return response(503, { error: "Password recovery is temporarily unavailable." });
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: profile, error: profileError } = await adminClient
      .from("profiles")
      .select("email, active")
      .eq("email", email)
      .maybeSingle();
    if (profileError) throw profileError;
    if (profile && !profile.active) return accepted();

    // Imported accounts can retain a legacy sign-in email while Supabase uses
    // a distinct auth email. Honor that alias without revealing its presence.
    let recipientEmail = profile?.email || "";
    if (!profile) {
      const { data: legacy, error: legacyError } = await adminClient
        .from("crm_legacy_auth")
        .select("auth_email, is_active")
        .eq("original_email", email)
        .maybeSingle();
      if (legacyError) throw legacyError;
      if (!legacy?.is_active) return accepted();
      recipientEmail = legacy.auth_email || "";
    }
    if (!recipientEmail) return accepted();

    const emailHash = await sha256(recipientEmail.toLowerCase());
    if (await isCoolingDown(adminClient, emailHash)) return accepted();

    const { data: generated, error: linkError } = await adminClient.auth.admin.generateLink({
      type: "recovery",
      email: recipientEmail,
      options: { redirectTo: resetRedirectUrl },
    });
    if (linkError || !generated.properties?.action_link) throw linkError || new Error("No recovery link was generated.");

    await sendBrevoResetEmail(recipientEmail, generated.properties.action_link);
    await recordRequest(adminClient, emailHash);
    return accepted();
  } catch (error) {
    console.error("Password-reset request failed:", error instanceof Error ? error.message : error);
    return response(503, { error: "Password recovery is temporarily unavailable." });
  }
});
