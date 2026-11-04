import { createClient } from "npm:@supabase/supabase-js@2";

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const allowedSerial = Deno.env.get("ATTENDANCE_DEVICE_SERIAL") || "";
const allowedSerials = (Deno.env.get("ATTENDANCE_ALLOWED_SERIALS") || allowedSerial).split(",").map(value => value.trim()).filter(Boolean);
const timezoneOffset = Deno.env.get("ATTENDANCE_TIMEZONE_OFFSET") || "+05:30";

function text(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
function check(error: any) { if (error) throw new Error(error.message || "Attendance storage failed."); }
function deviceTimestamp(value: string) {
  const date = new Date(`${value.trim().replace(" ", "T")}${timezoneOffset}`);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid attendance timestamp.");
  return date.toISOString();
}

Deno.serve(async (request) => {
  try {
    const url = new URL(request.url);
    const serialNumber = (url.searchParams.get("SN") || "").trim();
    if (!serialNumber) return text("Missing device serial number", 400);
    if (allowedSerials.length && !allowedSerials.includes(serialNumber)) return text("Unknown device", 403);
    const pathname = url.pathname.toLowerCase();
    const supported = (request.method === "GET" && (pathname.endsWith("/iclock/cdata") || pathname.endsWith("/iclock/getrequest")))
      || (request.method === "POST" && (pathname.endsWith("/iclock/cdata") || pathname.endsWith("/iclock/devicecmd")));
    if (!supported) return text("Not Found", 404);
    const { error: deviceError } = await supabase.from("attendance_devices").upsert({
      serial_number: serialNumber, model: url.searchParams.get("DeviceType") || "K90 Pro",
      ip_address: (request.headers.get("x-forwarded-for") || "").split(",")[0].trim(), last_seen: new Date().toISOString(),
    });
    check(deviceError);
    if (request.method === "GET" && pathname.endsWith("/iclock/cdata")) {
      return text([`GET OPTION FROM: ${serialNumber}`, "ATTLOGStamp=0", "OPERLOGStamp=0", "ATTPHOTOStamp=0",
        "ErrorDelay=60", "Delay=10", "TransTimes=00:00;14:05", "TransInterval=1", "TransFlag=1111000000", "Realtime=1", "Encrypt=0"].join("\n"));
    }
    if (request.method === "POST" && pathname.endsWith("/iclock/cdata")) {
      const table = (url.searchParams.get("table") || "ATTLOG").toUpperCase();
      const rawBody = await request.text();
      let accepted = 0;
      if (table === "ATTLOG") {
        const lines = rawBody.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const parsed = lines.map((raw) => {
          const [punchCode, timestamp, status = "", verifyMode = ""] = raw.split("\t");
          if (!punchCode || !timestamp) throw new Error("Invalid attendance record.");
          return { raw, punchCode, punchedAt: deviceTimestamp(timestamp), status, verifyMode };
        });
        if (parsed.length) {
          const codes = [...new Set(parsed.map((item) => item.punchCode))];
          const { data: mappings, error: mappingError } = await supabase.from("attendance_mappings").select("punch_code, user_id").in("punch_code", codes);
          check(mappingError);
          const ids = [...new Set((mappings || []).map((item) => item.user_id))];
          const profileResult = ids.length ? await supabase.from("profiles").select("id, employee_id, name").in("id", ids) : { data: [], error: null };
          check(profileResult.error);
          const profiles = new Map((profileResult.data || []).map((profile) => [profile.id, profile]));
          const byCode = new Map((mappings || []).map((item) => [item.punch_code, profiles.get(item.user_id)]));
          const rows = parsed.map((item) => {
            const profile = byCode.get(item.punchCode);
            return { user_id: profile?.id || null, employee_id: profile?.employee_id || null, employee_name: profile?.name || "Unmatched",
              punch_code: item.punchCode, punched_at: item.punchedAt, serial_number: serialNumber,
              status: item.status, verify_mode: item.verifyMode, raw: item.raw };
          });
          const { error } = await supabase.from("attendance_records").upsert(rows, { onConflict: "serial_number,punch_code,punched_at", ignoreDuplicates: true });
          check(error);
          accepted = rows.length;
        }
      }
      const { error } = await supabase.from("app_settings").update({ attendance_last_sync: new Date().toISOString() }).eq("id", true);
      check(error);
      // A successful acknowledgement is only returned after every database write.
      return text(`OK: ${accepted}`);
    }
    if (request.method === "POST") await request.text();
    return text("OK");
  } catch (error) {
    console.error("Attendance ingest failed:", error instanceof Error ? error.message : "Unknown storage error");
    return text("Attendance storage unavailable; retry upload.", 500);
  }
});
