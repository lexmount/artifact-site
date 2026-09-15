// Which OAuth clients this server will talk to, and how it tells them apart.
//
// Three ways a client can be known (MCP authorization spec, "Client Registration Approaches"):
//   1. Client ID Metadata Document — the client_id IS an https URL, and the JSON document there says
//      who the client is and where it may be sent back to. ChatGPT's preferred method: nothing to
//      configure on either side, and the identity is anchored to the domain hosting the document.
//   2. Dynamic registration (RFC 7591) — the client POSTs its metadata to /oauth/register and gets a
//      client_id (and a secret, if it asked for one). Kept for clients that predate (1).
//   3. Static preregistration — deliberately not implemented: every ChatGPT connector has its own
//      callback URL, so an administrator would be registering clients one user at a time.
//
// The metadata-document fetch is the one place this server requests a URL an unknown party chose,
// so it is fenced: https only, a public host that resolves to public addresses, no redirects, a
// short deadline and a small body — the "Server-Side Request Forgery" section of the
// client-id-metadata-document draft, made concrete.
import "server-only";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { safeEqual, sha256hex } from "@/lib/crypto";
import { getOauthClient, insertOauthClient, touchOauthClient } from "@/lib/db";
import { OauthError, SCOPES } from "@/lib/oauth-shared";
import { policy } from "@/lib/settings";
import type { OauthClientRecord, OauthTokenEndpointAuthMethod } from "@/lib/types";

/** A client as the authorization and token endpoints see it, whichever way it became known. */
export interface OauthClient {
  id: string;
  name: string;
  /** Normalised (`new URL(...).href`) — compared exactly against the authorization request. */
  redirectUris: string[];
  tokenEndpointAuthMethod: OauthTokenEndpointAuthMethod;
  secretHash: string | null;
  kind: "metadata-document" | "registered";
}

const CLIENT_ID_PREFIX = "ahc_";
const CLIENT_SECRET_PREFIX = "ahs_";
const AUTH_METHODS: readonly OauthTokenEndpointAuthMethod[] = ["none", "client_secret_post", "client_secret_basic"];
const MAX_REDIRECT_URIS = 20;
const MAX_NAME_CHARS = 100;

const DOCUMENT_TIMEOUT_MS = 5_000;
const DOCUMENT_MAX_BYTES = 64 * 1024;
const CACHE_MIN_MS = 60_000;
const CACHE_DEFAULT_MS = 5 * 60_000;
const CACHE_MAX_MS = 24 * 60 * 60_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type LookupLike = (host: string) => Promise<{ address: string }[]>;
let documentFetch: FetchLike = (url, init) => fetch(url, init);
let hostLookup: LookupLike = (host) => lookup(host, { all: true });
const documentCache = new Map<string, { client: OauthClient; expiresAt: number }>();

/** Tests swap the network out (a fake document server, a lookup that answers what the case needs). */
export function __setClientDocumentTransportForTests(transport: { fetch?: FetchLike; lookup?: LookupLike } | null): void {
  documentFetch = transport?.fetch ?? ((url, init) => fetch(url, init));
  hostLookup = transport?.lookup ?? ((host) => lookup(host, { all: true }));
  documentCache.clear();
}

export function __resetClientCacheForTests(): void {
  documentCache.clear();
}

// --- what counts as an acceptable address --------------------------------------------------------

/**
 * A native application's own scheme (OAuth 2.1 §8.4.1), decided fail-closed. Registration is
 * unauthenticated, and a redirect to a scheme is a redirect to whatever handles that scheme on
 * the person's machine — protocol-handler gadgets (`ms-msdt:`, `search-ms:`, …) keep appearing,
 * so a denylist can never be complete. What passes instead: the reverse-domain shape RFC 8252
 * §7.1 requires of native apps (`com.example.app:`, a letters-only first label, at least one more
 * label — no hyphens, which is where the system-handler names live), the few non-conforming
 * clients actually in use, and whatever the operator admits from the console or the environment
 * (Windsurf, Zed, a JetBrains IDE — each has a scheme of its own, and a release per editor would
 * be no way to keep up). The consent page still names the address before the button.
 */
const REVERSE_DOMAIN_SCHEME = /^[a-z]{2,24}(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+:$/;
const KNOWN_APP_SCHEMES = new Set(["cursor:", "vscode:", "vscode-insiders:"]);

export function isApplicationScheme(protocol: string): boolean {
  return KNOWN_APP_SCHEMES.has(protocol) || REVERSE_DOMAIN_SCHEME.test(protocol) || policy.oauth.appSchemes.has(protocol.slice(0, -1));
}

/**
 * A redirect_uri this server will send a browser to: https; plain http on the loopback host (a
 * CLI or desktop client listening locally — OAuth 2.1 §8.4.2); or a native application's own
 * scheme, as defined above. No fragment, no credentials. Returns the normalised form, or null.
 */
export function validateRedirectUri(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.hash || url.username || url.password) return null;
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:") return isLoopbackHost(url.hostname) ? url.href : null;
  return isApplicationScheme(url.protocol) ? url.href : null;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function isLoopbackRedirect(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "http:" && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The registered address an authorization request's redirect_uri matches, normalised — or null.
 * Exact match, with the one relaxation OAuth 2.1 §8.4.2 (RFC 8252 §7.3) requires: a loopback
 * redirect may use any port at request time, because a native client cannot know in advance
 * which port will be free when it starts listening. The address actually requested is what gets
 * stored and redirected to, so the code reaches the port the client is really listening on.
 */
export function matchRedirectUri(registered: readonly string[], requested: unknown): string | null {
  const candidate = validateRedirectUri(requested);
  if (!candidate) return null;
  if (registered.includes(candidate)) return candidate;
  if (!isLoopbackRedirect(candidate)) return null;
  const portless = (href: string) => { const url = new URL(href); url.port = ""; return url.href; };
  const wanted = portless(candidate);
  return registered.some((entry) => isLoopbackRedirect(entry) && portless(entry) === wanted) ? candidate : null;
}

/** The client-host allow-list (console, else ARTIFACT_OAUTH_CLIENT_HOSTS), when set: the host
 *  itself or a subdomain of a listed entry. */
function hostAllowed(hostname: string): boolean {
  const allowed = policy.oauth.clientHosts;
  if (allowed.size === 0) return true;
  const host = hostname.toLowerCase();
  for (const entry of allowed) if (host === entry || host.endsWith(`.${entry}`)) return true;
  return false;
}

/** With an allow-list configured, only https redirects to listed hosts pass: a loopback listener
 *  or a private-use scheme is by definition not one of the named hosts. Checked when a client
 *  registers AND on every authorization request, so a list tightened from the console applies
 *  to clients registered — or documents cached — before the change. */
export function redirectAllowed(href: string): boolean {
  if (policy.oauth.clientHosts.size === 0) return true;
  const url = new URL(href);
  return url.protocol === "https:" && hostAllowed(url.hostname);
}

function isPrivateV4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("::ffff:")) {
    const tail = lower.slice("::ffff:".length);
    return isIP(tail) === 4 ? isPrivateV4(tail) : true;
  }
  // fe80::/10 link-local (fe80–febf), fc00::/7 unique-local, fec0::/10 site-local (fec0–feff).
  return /^(fe[89ab]|f[cd]|fe[c-f])/.test(lower);
}

/**
 * The host a client_id points at has to be somewhere on the public internet: not an address
 * literal, not a name that means "this machine" or "this network", and not a name that resolves
 * to a private range. The lookup happens before the fetch; a rebinding host that answers
 * differently the second time is the residual risk, contained by the size and time limits below.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  const refuse = () => new OauthError("invalid_client", "The client_id must be a public https address", 400);
  if (isIP(name) || name.startsWith("[") || !name.includes(".")) throw refuse();
  if (name === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(name)) throw refuse();
  let addresses: { address: string }[];
  try {
    addresses = await hostLookup(name);
  } catch {
    throw new OauthError("invalid_client", "The client_id host could not be resolved", 400);
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address))) throw refuse();
}

const CONTROL_CHARS = /[\p{Cc}]/gu;

function cleanName(raw: unknown, fallback: string): string {
  const text = typeof raw === "string" ? raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim() : "";
  return (text || fallback).slice(0, MAX_NAME_CHARS);
}

// --- (1) Client ID Metadata Documents ------------------------------------------------------------

/** An https URL with a real path: the shape a metadata-document client_id must have. */
export function isMetadataDocumentClientId(clientId: string): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.pathname.length > 1 && !url.hash && !url.username && !url.password;
}

function cacheTtl(res: Response): number {
  const control = res.headers.get("cache-control") ?? "";
  if (/no-store|no-cache/i.test(control)) return CACHE_MIN_MS;
  const maxAge = control.match(/max-age=(\d+)/i);
  const ttl = maxAge ? Number(maxAge[1]) * 1000 : CACHE_DEFAULT_MS;
  return Math.min(CACHE_MAX_MS, Math.max(CACHE_MIN_MS, ttl));
}

function clientFromDocument(clientId: string, doc: unknown): OauthClient {
  const unusable = (why: string) => new OauthError("invalid_client", `The client metadata document is not usable: ${why}`, 400);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw unusable("it is not a JSON object");
  const d = doc as Record<string, unknown>;
  // Exact string equality, per the draft: the document must claim the very address it lives at.
  if (d.client_id !== clientId) throw unusable("its client_id does not match the document address");
  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0 || d.redirect_uris.length > MAX_REDIRECT_URIS) throw unusable("redirect_uris is missing");
  const redirectUris: string[] = [];
  for (const raw of d.redirect_uris) {
    const uri = validateRedirectUri(raw);
    if (!uri) throw unusable("a redirect_uri is not an https address, a loopback http address or an application scheme");
    redirectUris.push(uri);
  }
  return { id: clientId, name: cleanName(d.client_name, new URL(clientId).hostname), redirectUris, tokenEndpointAuthMethod: "none", secretHash: null, kind: "metadata-document" };
}

/** Fetch, validate and cache the document behind a URL-shaped client_id. Throws OauthError. */
export async function fetchClientDocument(clientId: string, now = Date.now()): Promise<OauthClient> {
  const url = new URL(clientId);
  // The allow-list is consulted BEFORE the cache: it can change from the console at any time, and a document fetched while a host was allowed must not outlive its welcome.
  if (!hostAllowed(url.hostname)) throw new OauthError("invalid_client", `Clients from ${url.hostname} are not allowed on this server`, 400);
  const cached = documentCache.get(clientId);
  if (cached && cached.expiresAt > now) return cached.client;
  await assertPublicHost(url.hostname);
  let res: Response;
  try {
    res = await documentFetch(clientId, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) });
  } catch {
    throw new OauthError("invalid_client", "The client metadata document could not be fetched", 400);
  }
  if (!res.ok) throw new OauthError("invalid_client", `The client metadata document could not be fetched (HTTP ${res.status})`, 400);
  if (Number(res.headers.get("content-length") ?? 0) > DOCUMENT_MAX_BYTES) throw new OauthError("invalid_client", "The client metadata document is too large", 400);
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new OauthError("invalid_client", "The client metadata document could not be read", 400);
  }
  if (text.length > DOCUMENT_MAX_BYTES) throw new OauthError("invalid_client", "The client metadata document is too large", 400);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OauthError("invalid_client", "The client metadata document is not valid JSON", 400);
  }
  const client = clientFromDocument(clientId, doc);
  documentCache.set(clientId, { client, expiresAt: now + cacheTtl(res) });
  return client;
}

// --- (2) Dynamic client registration (RFC 7591) --------------------------------------------------

function toClient(record: OauthClientRecord): OauthClient {
  return { id: record.id, name: record.name, redirectUris: record.redirectUris, tokenEndpointAuthMethod: record.tokenEndpointAuthMethod, secretHash: record.secretHash, kind: "registered" };
}

function stringList(value: unknown, fallback: string[]): string[] | null {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value as string[];
}

/**
 * Register a client from the metadata it sent. The response body of RFC 7591 §3.2.1 is returned
 * alongside, and the secret — when the client asked for one — exists only there.
 */
export async function registerOauthClient(input: unknown, now = Date.now()): Promise<{ client: OauthClient; registration: Record<string, unknown> }> {
  const bad = (why: string, code = "invalid_client_metadata") => new OauthError(code, why, 400);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("The registration request must be a JSON object");
  const body = input as Record<string, unknown>;
  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) throw bad("redirect_uris is required", "invalid_redirect_uri");
  if (body.redirect_uris.length > MAX_REDIRECT_URIS) throw bad(`At most ${MAX_REDIRECT_URIS} redirect_uris are accepted`, "invalid_redirect_uri");
  const redirectUris: string[] = [];
  for (const raw of body.redirect_uris) {
    const uri = validateRedirectUri(raw);
    if (!uri) throw bad("Every redirect_uri must be an https address, http on localhost, or the application's own scheme", "invalid_redirect_uri");
    if (!redirectAllowed(uri)) throw bad("Redirects to that address are not allowed on this server", "invalid_redirect_uri");
    redirectUris.push(uri);
  }
  const method = body.token_endpoint_auth_method === undefined ? "none" : body.token_endpoint_auth_method;
  if (typeof method !== "string" || !(AUTH_METHODS as readonly string[]).includes(method)) throw bad(`token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`);
  const grantTypes = stringList(body.grant_types, ["authorization_code"]);
  if (!grantTypes || grantTypes.some((g) => g !== "authorization_code" && g !== "refresh_token")) throw bad("Only the authorization_code and refresh_token grant types are supported");
  const responseTypes = stringList(body.response_types, ["code"]);
  if (!responseTypes || responseTypes.some((r) => r !== "code")) throw bad("Only response_type=code is supported");

  const id = CLIENT_ID_PREFIX + randomBytes(16).toString("base64url");
  const secret = method === "none" ? null : CLIENT_SECRET_PREFIX + randomBytes(32).toString("base64url");
  const first = new URL(redirectUris[0]);
  const record: OauthClientRecord = {
    id, secretHash: secret ? sha256hex(secret) : null,
    name: cleanName(body.client_name, first.hostname || first.protocol.slice(0, -1)),
    redirectUris, tokenEndpointAuthMethod: method as OauthTokenEndpointAuthMethod, createdAt: now, lastUsedAt: null,
  };
  await insertOauthClient(record);
  const registration: Record<string, unknown> = {
    client_id: id,
    client_id_issued_at: Math.floor(now / 1000),
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_name: record.name,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPES.join(" "),
  };
  return { client: toClient(record), registration };
}

// --- lookup and authentication --------------------------------------------------------------------

/** The client behind a client_id, whichever way it is known; null when it is simply unknown.
 *  Throws OauthError when it is a metadata-document client whose document cannot be accepted. */
export async function resolveOauthClient(clientId: string, now = Date.now()): Promise<OauthClient | null> {
  if (!clientId || clientId.length > 2048) return null;
  if (isMetadataDocumentClientId(clientId)) return fetchClientDocument(clientId, now);
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const record = await getOauthClient(clientId);
  return record ? toClient(record) : null;
}

/** Registered clients record when they were last seen, so abandoned registrations can be swept. */
export async function noteClientUse(client: OauthClient, now = Date.now()): Promise<void> {
  if (client.kind === "registered") await touchOauthClient(client.id, now);
}

function basicCredentials(request: Request): { id: string; secret: string } | null {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  const at = decoded.indexOf(":");
  if (at < 0) return null;
  const part = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
  return { id: part(decoded.slice(0, at)), secret: part(decoded.slice(at + 1)) };
}

/**
 * Who is calling the token (or revocation) endpoint. A public client — every metadata-document
 * client, and a registered one that chose `none` — proves nothing here and relies on PKCE; a
 * client registered with a secret must present it, in the body or as HTTP Basic. Any failure is
 * `invalid_client` (401), including a metadata document that cannot be accepted right now.
 */
export async function authenticateClient(request: Request, body: URLSearchParams, now = Date.now()): Promise<OauthClient> {
  const basic = basicCredentials(request);
  const bodyId = body.get("client_id")?.trim() ?? "";
  if (basic && bodyId && basic.id !== bodyId) throw new OauthError("invalid_client", "client_id in the body and in the Authorization header differ", 401);
  const id = basic?.id || bodyId;
  const secret = basic?.secret ?? body.get("client_secret") ?? "";
  if (!id) throw new OauthError("invalid_client", "client_id is required", 401);
  let client: OauthClient | null;
  try {
    client = await resolveOauthClient(id, now);
  } catch (error) {
    if (error instanceof OauthError) throw new OauthError("invalid_client", error.message, 401);
    throw error;
  }
  if (!client) throw new OauthError("invalid_client", "Unknown client", 401);
  if (client.secretHash && (!secret || !safeEqual(sha256hex(secret), client.secretHash))) throw new OauthError("invalid_client", "Client authentication failed", 401);
  return client;
}
