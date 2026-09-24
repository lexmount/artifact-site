/** Session-local caches: invalidate after mutations and identity changes. Never persist grants. */
const clearers = new Set<() => void>();
export function registerClientCache(clear: () => void) {
  clearers.add(clear);
}
export function invalidateClientCaches() {
  for (const clear of clearers) clear();
}
