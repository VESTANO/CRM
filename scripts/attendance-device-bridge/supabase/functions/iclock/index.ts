// Compatibility endpoint for biometric relays with the old project URL.
// Store and read nothing in the old project: forward all device traffic to CRM.
const destination = "https://qdtgrddhpbwrutvojpes.supabase.co/functions/v1/iclock";
Deno.serve(async request => {
  const url = new URL(request.url);
  const suffix = url.pathname.slice(url.pathname.indexOf("/iclock") + "/iclock".length);
  if (!/^\/iclock\/(cdata|getrequest|devicecmd)$/.test(suffix)) return new Response("Not Found", { status: 404 });
  try {
    const response = await fetch(`${destination}${suffix}${url.search}`, {
      method: request.method,
      headers: { "Content-Type": request.headers.get("Content-Type") || "text/plain" },
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      signal: AbortSignal.timeout(20000),
    });
    return new Response(response.body, { status: response.status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch {
    return new Response("Attendance storage unavailable; retry upload.", { status: 503 });
  }
});
