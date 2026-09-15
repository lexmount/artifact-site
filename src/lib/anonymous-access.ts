import { isSecureRequest, readCookie } from "@/lib/http";
// One bounded cookie for recently opened artifacts, never one root cookie per site.
const MAX_RECEIPTS = 8;
const MAX_COOKIE_BYTES = 3000;
function cookieName(request: Request): string {
    return `${isSecureRequest(request) ? "__Host-" : ""}ah_edit`;
}
function receipts(request: Request): [string, string][] {
    try {
        const raw = readCookie(request, cookieName(request)) ?? "[]";
        if (encodeURIComponent(raw).length > MAX_COOKIE_BYTES) return [];
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) return [];
        return value.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every(v => typeof v === "string") && /^[A-Za-z0-9_-]+$/.test(entry[0])).slice(-MAX_RECEIPTS);
    } catch { return []; }
}
export function anonymousEditCookie(request: Request, slug: string, token: string): string {
    const entries = [...receipts(request).filter(([key]) => key !== slug), [slug, token]].slice(-MAX_RECEIPTS);
    while (encodeURIComponent(JSON.stringify(entries)).length > MAX_COOKIE_BYTES) entries.shift();
    return `${cookieName(request)}=${encodeURIComponent(JSON.stringify(entries))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${isSecureRequest(request) ? "; Secure" : ""}`;
}
export function anonymousEditToken(request: Request): string {
    const match = new URL(request.url).pathname.match(/^\/(?:api\/sites|s|api\/preview)\/([A-Za-z0-9_-]+)(?:[~/]|$)/);
    return match ? receipts(request).find(([slug]) => slug === match[1])?.[1] ?? "" : "";
}
