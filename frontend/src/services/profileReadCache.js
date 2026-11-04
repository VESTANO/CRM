// Share the CRM profile read with Attendance during session restoration. The
// cache is short lived and never substitutes for database row-level security.
export function createProfileReadCache(load, { now = Date.now, maxAge = 5_000 } = {}) {
  const entries = new Map();
  return {
    read(userId) {
      if (!userId) return Promise.resolve(null);
      const cached = entries.get(userId);
      if (cached && (cached.pending || cached.expiresAt > now())) return cached.promise;

      const entry = { pending: true, expiresAt: 0, promise: null };
      entry.promise = Promise.resolve().then(() => load(userId)).then((profile) => {
        if (profile && profile.id !== userId) throw new Error("The CRM profile does not match the signed-in account.");
        entry.pending = false;
        entry.expiresAt = now() + maxAge;
        return profile ? Object.freeze({ ...profile }) : null;
      }).catch((error) => {
        if (entries.get(userId) === entry) entries.delete(userId);
        throw error;
      });
      entries.set(userId, entry);
      return entry.promise;
    },
    // A read already in flight may still resolve for its original caller, but
    // it cannot repopulate a cleared cache or be reused by the next identity.
    clear() { entries.clear(); },
  };
}
