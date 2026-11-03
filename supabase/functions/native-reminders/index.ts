import { createClient } from "npm:@supabase/supabase-js@2";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const db = createClient(Deno.env.get("SUPABASE_URL") || "", key, { auth: { persistSession: false, autoRefreshToken: false } });
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))),v=>v.toString(16).padStart(2,"0")).join("");
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,"0")).join("");
Deno.serve(async (req) => {
  if(req.method !== "POST") return new Response(null,{status:405});
  try {
    const text=await req.text();
    if(text.length>2048) return new Response(null,{status:413});
    const body=JSON.parse(text), action=new URL(req.url).pathname.split("/").at(-1);
    if(action === "pair") {
      const requester=await hash((req.headers.get("x-forwarded-for")?.split(",")[0] || "unknown")+key);
      const {count,error:rateError}=await db.from("crm_native_reminder_devices").select("id",{count:"exact",head:true}).eq("requester_hash",requester).gte("created_at",new Date(Date.now()-600000).toISOString());
      if(rateError) throw rateError;
      if((count||0)>=20) return new Response(null,{status:429});
      const secret=token(), code=token().slice(0,10).toUpperCase();
      const {error}=await db.from("crm_native_reminder_devices").insert({token_hash:await hash(secret),pair_code:code,requester_hash:requester});
      if(error) throw error;
      return Response.json({token:secret,pair_code:code,expires_in:600});
    }
    if(typeof body.token!=="string" || !/^[a-f0-9]{64}$/.test(body.token)) return new Response(null,{status:401});
    const {data:device,error}=await db.from("crm_native_reminder_devices").select("*").eq("token_hash",await hash(body.token)).maybeSingle();
    if(error) throw error;
    if(!device || device.revoked_at) return new Response(null,{status:401});
    if(!device.owner_id) return Response.json({approved:false},{status:new Date(device.pair_expires_at).getTime()<Date.now()?410:200});
    if(action === "poll") {
      const {data:owner,error:ownerError}=await db.from("profiles").select("active").eq("id",device.owner_id).maybeSingle();
      if(ownerError) throw ownerError;
      if(!owner?.active) return new Response(null,{status:403});
      const {data:reminders,error:readError}=await db.from("crm_reminders").select("id,text,reminder_at,delivery_revision").eq("owner_id",device.owner_id).gte("reminder_at",device.approved_at).gte("reminder_at",new Date(Date.now()-7*86400000).toISOString()).lte("reminder_at",new Date(Date.now()+30*86400000).toISOString()).order("reminder_at").limit(1000);
      if(readError) throw readError;
      const {error:seenError}=await db.from("crm_native_reminder_devices").update({last_seen_at:new Date().toISOString()}).eq("id",device.id);
      if(seenError) throw seenError;
      return Response.json({approved:true,device_id:device.id,reminders,server_time:new Date().toISOString()});
    }
    if(action === "receipt") {
      const {data:r,error:readError}=await db.from("crm_reminders").select("id,delivery_revision").eq("id",body.reminder_id).eq("owner_id",device.owner_id).gte("reminder_at",device.approved_at).maybeSingle();
      if(readError) throw readError;
      if(!r || r.delivery_revision!==body.delivery_revision) return new Response(null,{status:404});
      const {error:saveError}=await db.from("crm_native_reminder_receipts").upsert({device_id:device.id,reminder_id:r.id,delivery_revision:r.delivery_revision},{onConflict:"device_id,reminder_id,delivery_revision",ignoreDuplicates:true});
      if(saveError) throw saveError;
      return new Response(null,{status:204});
    }
    return new Response(null,{status:404});
  } catch {return Response.json({error:"Windows reminder connection is temporarily unavailable."},{status:503});}
});
