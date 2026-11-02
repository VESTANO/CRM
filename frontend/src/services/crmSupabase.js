import { createClient } from "@supabase/supabase-js";

export const CRM_SUPABASE_URL = import.meta.env.VITE_CRM_SUPABASE_URL || "https://qdtgrddhpbwrutvojpes.supabase.co";
export const CRM_SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_CRM_SUPABASE_PUBLISHABLE_KEY || "sb_publishable_Cm9EyPZ-a-9KrylPythgbw_MvdG3pHd";

export const crmSupabase = createClient(
  CRM_SUPABASE_URL,
  CRM_SUPABASE_PUBLISHABLE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } },
);
