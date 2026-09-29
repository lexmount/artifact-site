/** Browser-wide learning: successful copies, not link creation or acknowledgement clicks. */
export const SHARE_EDUCATION_KEY = "artifact-site:share-education:v3";
export const SHARE_EDUCATION_DATABASE = "artifact-share-education";
export const SHARE_EDUCATION_DISMISSED_KEY = `${SHARE_EDUCATION_KEY}:dismissed`;
export const SHARE_EDUCATION_LIMIT = 3;
export const SHARE_EDUCATION_INTERVAL = 24 * 60 * 60 * 1000;
export const SHARE_EDUCATION_CHANGED_EVENT = "artifact-site:share-education-changed";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
export type ShareEducation = { copies: number; dismissed: boolean; lastShownAt: number | null };

export function isShareEducationStorageKey(key: string | null): boolean {
  return key === null || key === SHARE_EDUCATION_KEY || key === SHARE_EDUCATION_DISMISSED_KEY;
}
export function readShareEducation(storage: StorageLike | null): ShareEducation {
  let dismissed = false;
  try { dismissed = storage?.getItem(SHARE_EDUCATION_DISMISSED_KEY) === "1"; } catch { /* Optional guidance. */ }
  try {
    const value = JSON.parse(storage?.getItem(SHARE_EDUCATION_KEY) ?? "null") as Partial<ShareEducation> | null;
    return {
      copies: typeof value?.copies === "number" && Number.isFinite(value.copies) ? Math.min(SHARE_EDUCATION_LIMIT, Math.max(0, Math.floor(value.copies))) : 0,
      dismissed: dismissed || value?.dismissed === true,
      lastShownAt: typeof value?.lastShownAt === "number" && Number.isFinite(value.lastShownAt) && value.lastShownAt >= 0 ? value.lastShownAt : null,
    };
  } catch { return { copies: 0, dismissed, lastShownAt: null }; }
}
type Update<T> = { value: T; state?: ShareEducation };
/** Web Locks order notifications; IndexedDB is authoritative across renderer storage caches. */
async function coordinated<T>(storage: StorageLike | null, run: (state: ShareEducation) => Update<T>): Promise<T | undefined> {
  try {
    if (typeof navigator === "undefined" || !navigator.locks || typeof indexedDB === "undefined") return;
    return await navigator.locks.request(SHARE_EDUCATION_KEY, () => new Promise<T>((resolve, reject) => {
      const opening = indexedDB.open(SHARE_EDUCATION_DATABASE, 1);
      let abandoned = false;
      opening.onupgradeneeded = () => opening.result.createObjectStore("progress");
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => { abandoned = true; reject(new Error("Education database is blocked")); };
      opening.onsuccess = () => {
        const db = opening.result;
        if (abandoned) { db.close(); return; }
        db.onversionchange = () => db.close();
        const transaction = db.transaction("progress", "readwrite");
        const store = transaction.objectStore("progress");
        const reading = store.get(SHARE_EDUCATION_KEY);
        let update: Update<T>;
        reading.onsuccess = () => {
          try {
            const local = readShareEducation(storage);
            // Migrate existing progress once. Never use a renderer's cached progress after that.
            const state: ShareEducation = reading.result ?? local;
            update = run({ ...state, dismissed: state.dismissed || local.dismissed });
            if (update.state) store.put(update.state, SHARE_EDUCATION_KEY);
          } catch { transaction.abort(); }
        };
        transaction.oncomplete = () => {
          db.close();
          // localStorage is only a UI notification/migration mirror, never the claim authority.
          if (update.state) write(storage, update.state);
          resolve(update.value);
        };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    }));
  } catch { /* Skip optional education if coordination/storage is unavailable; clipboard success stands. */ }
}
function write(storage: StorageLike | null, state: ShareEducation): void {
  try { storage?.setItem(SHARE_EDUCATION_KEY, JSON.stringify(state)); } catch { /* Optional guidance. */ }
}
export function shareEducationCompleted(state: ShareEducation): boolean {
  return state.dismissed || state.copies >= SHARE_EDUCATION_LIMIT;
}
/** Claim only on mount, never on copy/storage events: those may close a lesson but cannot reopen it. */
export async function claimShareEducation(local: StorageLike | null, session: StorageLike | null, slug: string, now = Date.now(), isActive = () => true): Promise<boolean> {
  const claimed = await coordinated(local, state => {
    if (!isActive()) return { value: false };
    if (shareEducationCompleted(state)) return { value: false };
    if (state.lastShownAt !== null && now - state.lastShownAt < SHARE_EDUCATION_INTERVAL) return { value: false };
    const key = `${SHARE_EDUCATION_KEY}:seen:${encodeURIComponent(slug)}`;
    try { if (session?.getItem(key)) return { value: false }; } catch { /* Local cooldown still applies. */ }
    return { value: true, state: { ...state, lastShownAt: now } };
  });
  if (claimed) {
    try { session?.setItem(`${SHARE_EDUCATION_KEY}:seen:${encodeURIComponent(slug)}`, "1"); } catch { /* Global cooldown still applies. */ }
  }
  return claimed ?? false;
}
export function dismissShareEducationForever(storage: StorageLike | null): void {
  // Monotonic and independent of copy/claim snapshots, including ones from an older tab.
  try { storage?.setItem(SHARE_EDUCATION_DISMISSED_KEY, "1"); } catch { /* Current visit still dismisses. */ }
}

// Storage access itself can throw. Retain this page's progress when storage is unavailable/full.
const fallback = { localStorage: new Map<string, string>(), sessionStorage: new Map<string, string>() };
export function educationStorage(kind: "localStorage" | "sessionStorage"): StorageLike {
  return {
    getItem(key) {
      if (fallback[kind].has(key)) return fallback[kind].get(key)!;
      try { return window[kind].getItem(key); } catch { return null; }
    },
    setItem(key, value) {
      try { window[kind].setItem(key, value); fallback[kind].delete(key); }
      catch { fallback[kind].set(key, value); }
    },
  };
}
/** Call only for share URLs; canonical addresses and passcodes use ordinary clipboard writes. */
export async function copyShareLink(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  const storage = educationStorage("localStorage");
  // Clipboard success must not wait for optional guidance in a frozen/blocked tab.
  void coordinated(storage, state => ({
    value: undefined,
    state: { ...state, copies: Math.min(SHARE_EDUCATION_LIMIT, state.copies + 1) },
  })).then(() => {
    window.dispatchEvent(new Event(SHARE_EDUCATION_CHANGED_EVENT));
  }).catch(() => { /* Optional notification must never affect clipboard feedback. */ });
}
