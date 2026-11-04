import { crmSupabase } from "./crmSupabase.js";
import { createProfileReadCache } from "./profileReadCache.js";

const profiles = createProfileReadCache(async (userId) => {
  const { data, error } = await crmSupabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data;
});

export const readCrmProfile = (userId) => profiles.read(userId);
export const clearCrmProfileCache = () => profiles.clear();

crmSupabase.auth.onAuthStateChange((event) => {
  if (["SIGNED_IN", "SIGNED_OUT", "USER_UPDATED"].includes(event)) profiles.clear();
});
