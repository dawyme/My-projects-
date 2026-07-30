// Tiny in-memory TTL cache used to speed up dashboard/analytics aggregate queries.
const store = new Map();

function get(key) {
  const hit = store.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) { store.delete(key); return null; }
  return hit.value;
}

function set(key, value, ttlMs = 30000) {
  store.set(key, { value, expires: Date.now() + ttlMs });
  return value;
}

async function wrap(key, ttlMs, producer) {
  const cached = get(key);
  if (cached !== null) return cached;
  return set(key, await producer(), ttlMs);
}

function invalidate(prefix = '') {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

module.exports = { get, set, wrap, invalidate };
