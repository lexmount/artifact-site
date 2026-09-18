let fallback = true;
let storageUnavailable = false;
const key = "artifact-comment-rail-collapsed";
const changed = "artifact:comment-rail-preference";
export const commentRailPreference = {
  getSnapshot() { if (storageUnavailable) return fallback; try { return localStorage.getItem(key) !== "false"; } catch { return fallback; } },
  getServerSnapshot() { return true; },
  subscribe(callback: () => void) {
    window.addEventListener("storage", callback);
    window.addEventListener(changed, callback);
    return () => { window.removeEventListener("storage", callback); window.removeEventListener(changed, callback); };
  },
  set(value: boolean) { fallback = value; try { localStorage.setItem(key, String(value)); } catch { storageUnavailable = true; } window.dispatchEvent(new Event(changed)); },
};
