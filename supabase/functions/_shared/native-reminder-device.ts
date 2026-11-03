export async function nativeReminderDeviceRequest(db: any, ownerId: string, method: string, parts: string[], body: any, fail: any) {
  if(method === "GET" && parts.length === 1) {
    const {data,error}=await db.from("crm_native_reminder_devices").select("id,approved_at,last_seen_at").eq("owner_id",ownerId).is("revoked_at",null).order("approved_at");
    if(error) throw error;
    return {status:200,data:{results:data||[]}};
  }
  if(method === "POST" && parts[1] === "approve") {
    const code=String(body.pair_code||"").trim().toUpperCase();
    if(!/^[A-F0-9]{10}$/.test(code)) fail(400,"Enter the Windows connection code.");
    const {data:device,error}=await db.from("crm_native_reminder_devices").select("id,owner_id,pair_expires_at").eq("pair_code",code).is("revoked_at",null).maybeSingle();
    if(error) throw error;
    if(!device || (device.owner_id && device.owner_id!==ownerId)) fail(404,"This Windows connection code is unavailable.");
    if(device.owner_id===ownerId) return {status:200,data:{connected:true,id:device.id}};
    if(new Date(device.pair_expires_at).getTime()<=Date.now()) fail(410,"The Windows connection code expired. Restart the notifier connection.");
    const {data:approved,error:saveError}=await db.from("crm_native_reminder_devices").update({owner_id:ownerId,approved_at:new Date().toISOString()}).eq("id",device.id).is("owner_id",null).gt("pair_expires_at",new Date().toISOString()).select("id").maybeSingle();
    if(saveError) throw saveError;
    if(!approved) fail(409,"The Windows connection was already claimed or expired.");
    return {status:200,data:{connected:true,id:approved.id}};
  }
  if(method === "DELETE" && parts.length === 2) {
    const {error}=await db.from("crm_native_reminder_devices").update({revoked_at:new Date().toISOString()}).eq("id",parts[1]).eq("owner_id",ownerId);
    if(error) throw error;
    return {status:204};
  }
  fail(404,"Windows notification action not found.");
}
