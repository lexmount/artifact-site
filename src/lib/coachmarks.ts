export type HintRecord = { seen: number; learned: boolean };
export function canTeach(record: HintRecord, seenThisSession: boolean) { return !record.learned && record.seen < 3 && !seenThisSession; }
const memory = new Map<string, HintRecord>();
export function hintKey(user: string, name: string) { return `artifact:hint:${user}:${name}`; }
export function readHint(key: string): HintRecord {
  try { const r = JSON.parse(localStorage.getItem(key) ?? "null"); if (r && typeof r.seen === "number") return r; } catch { /* Storage is optional. */ }
  return memory.get(key) ?? { seen: 0, learned: false };
}
export function writeHint(key: string, record: HintRecord) { memory.set(key, record); try { localStorage.setItem(key, JSON.stringify(record)); } catch { /* In-memory fallback. */ } }
export function learnHint(user: string, name: string) { const key = hintKey(user, name); writeHint(key, { ...readHint(key), learned: true }); window.dispatchEvent(new CustomEvent("artifact:hint-learned", { detail: key })); }
