import "server-only";
import { createHash } from "node:crypto";
import { consumeOidcFlow } from "@/lib/db";
import { appBasePath } from "@/lib/app-path";
import { isSecureRequest, readCookie } from "@/lib/http";

// Preferences only, never authentication evidence. Scope them to this application mount.
const OPT_OUT = "artifact_sso_opt_out";
const RETRY = "artifact_sso_retry";
export function autoLoginAllowed(request: Request): boolean {
  return !readCookie(request, OPT_OUT) && !readCookie(request, RETRY);
}
export function autoLoginOptedOut(request: Request): boolean {
  return Boolean(readCookie(request, OPT_OUT));
}
function preferenceCookie(request: Request, name: string, maxAge: number): string {
  return `${name}=${maxAge ? "1" : ""}; Path=${appBasePath() || "/"}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(request) ? "; Secure" : ""}`;
}
export function autoLoginOptOutCookie(request: Request, clear = false): string {
  return preferenceCookie(request, OPT_OUT, clear ? 0 : 400 * 24 * 60 * 60);
}
export function autoLoginRetryCookie(request: Request, clear = false): string {
  return preferenceCookie(request, RETRY, clear ? 0 : 60);
}

// A second one-use row remains live while the code exchange is in flight. Explicit actions
// cancel it using the flow bindings present in their browser request, across all server replicas.
export const silentCompletionId = (state: string) => `silent-completion:${state}`;
export async function cancelPendingSilentLogins(request: Request): Promise<void> {
  const prefix = isSecureRequest(request) ? "__Host-oidc_flow_silent_" : "oidc_flow_silent_";
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const name = part.trim().split("=")[0];
    if (!name.startsWith(prefix)) continue;
    const state = readCookie(request, name);
    if (!state || name !== prefix + createHash("sha256").update(state).digest("hex")) continue;
    await consumeOidcFlow(silentCompletionId(state), Date.now());
  }
}
