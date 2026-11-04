export function createReadCache({ now = Date.now } = {}) {
  const entries = new Map();
  return {
    // Expire before the attendance screen's 15-second polling interval.
    read(key, load, maxAge = 10_000) {
      const cached = entries.get(key);
      if (cached && (cached.pending || cached.expiresAt > now())) return cached.promise;

      const entry = { pending: true, expiresAt: 0, promise: null };
      entry.promise = Promise.resolve().then(load).then((value) => {
        entry.pending = false;
        entry.expiresAt = now() + maxAge;
        return value;
      }, (error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
      entries.set(key, entry);
      return entry.promise;
    },
    clear() { entries.clear(); },
  };
}
