import { AUTH_CHANGE_COOKIE, authChangeCookiePath } from "@/lib/auth-change";
import { appFetch, appPath, localPath } from "@/lib/app-path";
import { invalidateClientCaches } from "@/lib/client-cache";
// One observable browser snapshot for the header, account pages and login acknowledgement.
export interface MeUser {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}
export interface AuthState {
  user: MeUser | null;
  oidcEnabled: boolean;
  isAdmin: boolean;
  loading: boolean;
  error: boolean;
}
export const initialAuth: AuthState = { user: null, oidcEnabled: false, isAdmin: false, loading: true, error: false };
let snapshot = initialAuth;
let inflight: Promise<AuthState> | null = null;
let generation = 0;
let signingOut = false;
let automaticLoginDecided = false;
const AUTO_ATTEMPT_KEY = "artifact-site:sso-attempt:";
function tryAutomaticLogin() {
  if (typeof window === "undefined") return;
  // Never navigate embedded previews or interrupt an explicit OAuth authorization flow.
  if (window.top && window.top !== window.self) return;
  const path = localPath(window.location.pathname);
  if (/^\/(api|oauth|v1)(\/|$)/.test(path)) return;
  try {
    const key = AUTO_ATTEMPT_KEY + appPath("/");
    const previous = Number(window.sessionStorage.getItem(key));
    if (previous && Date.now() - previous < 60_000) return;
    // Persist before leaving: even blocked cookies or a failed callback cannot cause a loop.
    window.sessionStorage.setItem(key, String(Date.now()));
    const target = window.location.pathname + window.location.search + window.location.hash;
    window.location.replace(appPath(`/api/auth/login?silent=1&return_to=${encodeURIComponent(target)}`));
  } catch { /* Without loop protection, leave manual sign-in available. */ }
}
const listeners = new Set<() => void>();
const CHANGE_KEY = "artifact-site:auth-change";
export const getAuthSnapshot = () => snapshot;
function publish(next: AuthState) {
  if (snapshot.user?.id !== next.user?.id || snapshot.isAdmin !== next.isAdmin) invalidateClientCaches();
  snapshot = next;
  listeners.forEach((listener) => listener());
}
function revalidate() { void refreshAuth(); }
function onStorage(event: StorageEvent) {
  if (event.key === CHANGE_KEY) { resetAuthCache(); revalidate(); }
}
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof window !== "undefined") {
    window.addEventListener("focus", revalidate);
    window.addEventListener("pageshow", revalidate);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined") {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener("pageshow", revalidate);
      window.removeEventListener("storage", onStorage);
    }
  };
}
function notifyAuthChange(eventId?: string) {
  try {
    eventId ??= crypto.randomUUID();
    if (window.localStorage.getItem(CHANGE_KEY) !== eventId) window.localStorage.setItem(CHANGE_KEY, eventId);
  } catch { /* Focus also revalidates when storage is unavailable. */ }
}
let consumedLoginEvent: string | undefined;
function loginChangeMarker(): string | undefined {
  try {
    return document.cookie.split(";").map(part => part.trim())
      .find(part => part.startsWith(`${AUTH_CHANGE_COOKIE}=`))?.slice(AUTH_CHANGE_COOKIE.length + 1);
  } catch { return undefined; }
}
/** Only completed callbacks leave this marker; URL presentation hints cannot trigger a broadcast. */
function consumeLoginChange(user: MeUser | null, marker: string | undefined) {
  // A request sent before this callback cannot confirm or consume the newer login event.
  if (!marker || loginChangeMarker() !== marker) return;
  try {
    document.cookie = `${AUTH_CHANGE_COOKIE}=; Path=${authChangeCookiePath()}; Max-Age=0; SameSite=Lax`;
    if (marker === consumedLoginEvent) return;
    consumedLoginEvent = marker;
    // An anonymous result burns a stale marker without announcing a successful login.
    if (user) notifyAuthChange(marker);
  } catch { /* An optional sync hint must not make account detection fail. */ }
}
/** Superseded requests must never restore a previous account. */
export function resetAuthCache() {
  generation++;
  inflight = null;
  invalidateClientCaches();
}
export function refreshAuth(): Promise<AuthState> {
  if (signingOut) return Promise.resolve(snapshot);
  if (inflight) return inflight;
  // Decide once at page entry, including guest cooldowns and failed lookups. Later focus,
  // storage and navigation checks may refresh identity but must not interrupt active work.
  const mayNavigate = !automaticLoginDecided;
  automaticLoginDecided = true;
  const version = generation;
  const loginEvent = loginChangeMarker();
  inflight = (async () => {
    // Bound the whole exchange, including a response body that never finishes. Otherwise
    // focus checks and manual retries keep joining a stuck promise for this tab's lifetime.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await appFetch("/api/auth/me", { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!response.ok) throw new Error("Account lookup failed");
      const body = await response.json();
      if (!body || typeof body.oidcEnabled !== "boolean" || !("user" in body)) throw new Error("Invalid account response");
      if (version === generation) {
        publish({ user: body.user, oidcEnabled: body.oidcEnabled, isAdmin: Boolean(body.isAdmin), loading: false, error: false });
        consumeLoginChange(body.user, loginEvent);
        if (mayNavigate && !body.user && body.oidcEnabled && body.autoLogin === true) tryAutomaticLogin();
      }
    } catch {
      // A network/server failure is not evidence of logout. Keep the last known identity.
      if (version === generation) publish({ ...snapshot, loading: false, error: true });
    } finally {
      clearTimeout(timeout);
      if (version === generation) inflight = null;
    }
    return snapshot;
  })();
  return inflight;
}
export async function logoutAuth(): Promise<void> {
  if (signingOut) throw new Error("Sign-out already in progress");
  signingOut = true;
  resetAuthCache();
  try {
    const response = await appFetch("/api/auth/logout", { method: "POST", credentials: "same-origin", cache: "no-store" });
    if (!response.ok || (await response.json()).ok !== true) throw new Error("Sign-out failed");
    publish({ ...snapshot, user: null, isAdmin: false, loading: false, error: false });
    notifyAuthChange();
  } finally {
    signingOut = false;
  }
}
