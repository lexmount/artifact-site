// OAuth for remote MCP clients (lib/oauth): a real MCP SDK client — the same OAuth client code
// ChatGPT-style hosts run — discovers this server's authorization server from /mcp's 401, gets
// through consent, exchanges its code with PKCE and then works as the person, over the route
// handlers in-process. Around that: the discovery documents, what OAuth 2.1 says to refuse,
// refresh rotation, scope, the account page's connections, and the old tokens still working.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as protectedResourceMcp } from "@/app/.well-known/oauth-protected-resource/mcp/route";
import { GET as authorizationServer } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as openidConfiguration } from "@/app/.well-known/openid-configuration/route";
import { POST as tokenEndpoint } from "@/app/oauth/token/route";
import { POST as registerEndpoint } from "@/app/oauth/register/route";
import { POST as revokeEndpoint } from "@/app/oauth/revoke/route";
import { POST as decisionEndpoint } from "@/app/oauth/decision/route";
import { POST as mcp, GET as mcpGet } from "@/app/mcp/route";
import { GET as listConnections } from "@/app/api/me/connections/route";
import { DELETE as disconnect } from "@/app/api/me/connections/[id]/route";
import { POST as createSite } from "@/app/api/sites/route";
import { GET as whoami } from "@/app/api/auth/me/route";
import { POST as mintToken } from "@/app/api/me/tokens/route";
import { disableUser } from "@/lib/admin";
import { sha256hex } from "@/lib/crypto";
import { closeDbForTests, consumeOauthRefreshToken, getOauthClient, listSitesByOwner, pruneOauth, redeemOauthCode, upsertUser } from "@/lib/db";
import { prepareAuthorization } from "@/lib/oauth";
import { __setClientDocumentTransportForTests } from "@/lib/oauth-clients";
import { issuerFor, issuerFromHeaders, pkceChallenge, SCOPE_READ, SCOPE_WRITE } from "@/lib/oauth-shared";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { updateSettings } from "@/lib/settings";
import { mintSession } from "@/lib/session";
import type { Session } from "@/lib/types";

const origin = "http://test.local";
const CHATGPT_CLIENT = "https://chatgpt.com/oauth/rfZCxg7PlqRp/client.json";
const CHATGPT_REDIRECT = "https://chatgpt.com/connector/oauth/rfZCxg7PlqRp";
const chatgptDocument = {
  client_id: CHATGPT_CLIENT, client_name: "ChatGPT", client_uri: "https://chatgpt.com/",
  redirect_uris: [CHATGPT_REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
};
const CLAUDE_CLIENT = "https://claude.ai/oauth/client.json";
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const claudeDocument = { client_id: CLAUDE_CLIENT, client_name: "Claude", redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: "none" };

let dir: string;
const clients: Client[] = [];
/** The public internet, as far as this suite is concerned: one document, served to one address. */
let documents: Record<string, unknown> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oauth-")); process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_OIDC_ISSUER = "https://identity.test"; process.env.ARTIFACT_OIDC_CLIENT_ID = "test"; process.env.ARTIFACT_OIDC_CLIENT_SECRET = "test";
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on"; process.env.ARTIFACT_CREATE_POLICY = "open"; process.env.ARTIFACT_DEFAULT_VISIBILITY = "private";
  documents = { [CHATGPT_CLIENT]: chatgptDocument, [CLAUDE_CLIENT]: claudeDocument };
  __setClientDocumentTransportForTests({
    fetch: async (url) => (url in documents ? new Response(JSON.stringify(documents[url]), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } }) : new Response("not here", { status: 404 })),
    lookup: async () => [{ address: "104.18.32.47" }],
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  await closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
  __setClientDocumentTransportForTests(null);
  __resetRateLimitForTests();
  for (const k of ["ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_CREATE_POLICY", "ARTIFACT_DEFAULT_VISIBILITY", "ARTIFACT_PUBLIC_URL", "ARTIFACT_OAUTH_CLIENT_HOSTS", "ARTIFACT_OAUTH_DCR", "ARTIFACT_OAUTH_APP_SCHEMES", "PUBLISH_API_TOKEN"]) delete process.env[k];
});

// --- the wiring ------------------------------------------------------------------------------------

/** This deployment, as one fetch: every address the SDK's OAuth client and MCP transport will ask for. */
async function dispatch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  if (path === "/mcp") return request.method === "POST" ? mcp(request) : mcpGet();
  if (path === "/.well-known/oauth-protected-resource/mcp") return protectedResourceMcp(request);
  if (path === "/.well-known/oauth-protected-resource") return protectedResource(request);
  if (path === "/.well-known/oauth-authorization-server") return authorizationServer(request);
  if (path === "/.well-known/openid-configuration") return openidConfiguration(request);
  if (path === "/oauth/token") return tokenEndpoint(request);
  if (path === "/oauth/register") return registerEndpoint(request);
  if (path === "/oauth/revoke") return revokeEndpoint(request);
  throw new Error(`unexpected fetch: ${request.method} ${request.url}`);
}

/** What an MCP host keeps between steps of the flow: client identity, verifier, tokens, and where it was told to send the person. */
class HostProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;
  readonly stateValue = `st-${Math.random().toString(36).slice(2)}`;
  constructor(readonly redirectUrl: string, readonly clientMetadataUrl?: string) {}
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Acceptance host", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  state() { return this.stateValue; }
  clientInformation() { return this.info; }
  saveClientInformation(info: OAuthClientInformationMixed) { this.info = info; }
  tokens() { return this.saved; }
  saveTokens(tokens: OAuthTokens) { this.saved = tokens; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(verifier: string) { this.verifier = verifier; }
  codeVerifier() { return this.verifier; }
}

interface Browser { userId: string; email: string; session: Session; cookie: string; headers: Record<string, string> }

/** A signed-in person: a real session row and the cookie a browser would send. Every call is a
 *  distinct account, so the suite also runs against one shared Postgres (`make test-pg` style). */
async function person(subject: string): Promise<Browser> {
  const id = `${subject}-${Math.random().toString(36).slice(2, 8)}`;
  const user = await upsertUser({ authProvider: "test", providerSubject: id, email: `${id}@example.test`, emailVerified: true });
  const { session, cookie } = await mintSession(new Request(origin), user.id);
  return { userId: user.id, email: `${id}@example.test`, session, cookie: cookie.split(";")[0], headers: { cookie: cookie.split(";")[0], origin } };
}

/** The consent page and its form, as the person: /oauth/authorize (lib) then POST /oauth/decision. Returns where the browser is sent. */
async function consent(browser: Browser, authorizeUrl: URL, decision: "allow" | "deny" = "allow"): Promise<URL> {
  // The page derives the issuer the same way the routes do: the configured public address, else the
  // request's — and a real browser's form post carries that address as its Origin.
  const issuer = process.env.ARTIFACT_PUBLIC_URL || origin;
  const outcome = await prepareAuthorization(authorizeUrl.searchParams, browser.session, issuer);
  if (outcome.kind !== "consent") throw new Error(`expected the consent page, got ${JSON.stringify(outcome)}`);
  const res = await decisionEndpoint(new Request(`${origin}/oauth/decision`, { method: "POST", headers: { ...browser.headers, origin: issuer }, body: new URLSearchParams({ request: outcome.requestId, decision }) }));
  expect(res.status).toBe(303);
  return new URL(res.headers.get("location")!);
}

/** The whole dance, as a host would run it: 401 → discovery → (registration) → consent → code → tokens → connected. */
async function connectThroughOauth(browser: Browser, provider: HostProvider): Promise<{ client: Client; tokens: OAuthTokens; sentTo: URL }> {
  const first = new Client({ name: "acceptance", version: "1" });
  await expect(first.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider, fetch: dispatch }))).rejects.toThrow();
  expect(provider.authorizationUrl).toBeDefined();
  const sentTo = await consent(browser, provider.authorizationUrl!);
  expect(sentTo.searchParams.get("state")).toBe(provider.stateValue);
  expect(sentTo.searchParams.get("iss")).toBe(origin);
  await new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider, fetch: dispatch }).finishAuth(sentTo.searchParams.get("code")!);
  const client = new Client({ name: "acceptance", version: "1" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { authProvider: provider, fetch: dispatch }));
  return { client, tokens: provider.saved!, sentTo };
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name: `artifact_site_${name}`, arguments: args });
  const content = result.content as { text: string }[];
  return { error: Boolean(result.isError), data: (() => { try { return JSON.parse(content[0].text); } catch { return { error: content[0].text }; } })() };
}

/** A raw JSON-RPC call on /mcp with a bearer, for what the SDK client would not send on its own. */
function rpc(bearer: string, body: unknown, headers: Record<string, string> = {}) {
  return mcp(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) }));
}
const ping = (bearer: string) => rpc(bearer, { jsonrpc: "2.0", id: 1, method: "ping" });

/** A hand-rolled authorization request → code, for the token-endpoint cases the SDK would never produce. */
async function codeFor(browser: Browser, verifier: string, overrides: Record<string, string> = {}): Promise<string> {
  const params = new URLSearchParams({ response_type: "code", client_id: CHATGPT_CLIENT, redirect_uri: CHATGPT_REDIRECT, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", state: "s1", resource: `${origin}/mcp`, ...overrides });
  const sentTo = await consent(browser, new URL(`${origin}/oauth/authorize?${params}`));
  return sentTo.searchParams.get("code")!;
}

async function exchange(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await tokenEndpoint(new Request(`${origin}/oauth/token`, { method: "POST", headers, body: new URLSearchParams(form) }));
  return { status: res.status, body: await res.json() as Record<string, string | number>, headers: res.headers };
}

const verifier = () => "v".repeat(20) + Math.random().toString(36).slice(2).padEnd(30, "x");

// --- discovery ---------------------------------------------------------------------------------------

describe("discovery", () => {
  it("publishes the documents an MCP client needs, for the address it is deployed at", async () => {
    process.env.ARTIFACT_PUBLIC_URL = "https://hub.example";
    const prm = await (await protectedResource(new Request(`${origin}/.well-known/oauth-protected-resource`))).json();
    expect(prm).toMatchObject({ resource: "https://hub.example/mcp", authorization_servers: ["https://hub.example"], scopes_supported: [SCOPE_READ, SCOPE_WRITE], bearer_methods_supported: ["header"] });
    expect(await (await protectedResourceMcp(new Request(`${origin}/.well-known/oauth-protected-resource/mcp`))).json()).toEqual(prm);
    const asRes = await authorizationServer(new Request(`${origin}/.well-known/oauth-authorization-server`));
    expect(asRes.headers.get("access-control-allow-origin")).toBe("*");
    const as = await asRes.json();
    expect(as).toMatchObject({
      issuer: "https://hub.example", authorization_endpoint: "https://hub.example/oauth/authorize", token_endpoint: "https://hub.example/oauth/token",
      registration_endpoint: "https://hub.example/oauth/register", revocation_endpoint: "https://hub.example/oauth/revoke",
      code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
      grant_types_supported: ["authorization_code", "refresh_token"], response_types_supported: ["code"],
    });
    expect(as.token_endpoint_auth_methods_supported).toContain("none");
    const oidc = await (await openidConfiguration(new Request(`${origin}/.well-known/openid-configuration`))).json();
    expect(oidc).toMatchObject({ issuer: "https://hub.example", jwks_uri: "https://hub.example/oauth/jwks", code_challenge_methods_supported: ["S256"] });
  });

  it("falls back to the request's own address without ARTIFACT_PUBLIC_URL, and hides registration when it is off", async () => {
    process.env.ARTIFACT_OAUTH_DCR = "off";
    const as = await (await authorizationServer(new Request(`${origin}/.well-known/oauth-authorization-server`))).json();
    expect(as.issuer).toBe(origin);
    expect(as.registration_endpoint).toBeUndefined();
    const res = await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://client.example/cb"] }) }));
    expect(res.status).toBe(404);
  });

  it("challenges an unauthenticated /mcp request with where to authorize and what to ask for", async () => {
    const bare = await mcp(new Request(`${origin}/mcp`, { method: "POST", body: "{}" }));
    expect(bare.status).toBe(401);
    const challenge = bare.headers.get("www-authenticate")!;
    expect(challenge).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain(`scope="${SCOPE_READ} ${SCOPE_WRITE}"`);
    expect(challenge).not.toContain("invalid_token");
    const bogus = await mcp(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: "Bearer aho_nope" }, body: "{}" }));
    expect(bogus.status).toBe(401);
    expect(bogus.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await bogus.json()).code).toBe("invalid_token");
  });
});

// --- the flow ------------------------------------------------------------------------------------------

describe("connecting", () => {
  it("lets a ChatGPT-style client in through its metadata document, consent and PKCE, then acts as the person", async () => {
    const alice = await person("alice");
    const provider = new HostProvider(CHATGPT_REDIRECT, CHATGPT_CLIENT);
    const { client, tokens, sentTo } = await connectThroughOauth(alice, provider);
    // The person was sent back to the address in ChatGPT's document — nothing else was ever redirected to.
    expect(`${sentTo.origin}${sentTo.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(provider.info?.client_id).toBe(CHATGPT_CLIENT);
    expect(tokens.access_token.startsWith("aho_")).toBe(true);
    expect(tokens.refresh_token?.startsWith("ahr_")).toBe(true);
    expect(tokens.scope).toBe(`${SCOPE_READ} ${SCOPE_WRITE}`);
    // Every tool runs as Alice: identity, a publication that is hers from birth, and her own list.
    const connection = await call(client, "connection");
    expect(connection.error).toBe(false); expect(connection.data.user.email).toBe(alice.email); expect(connection.data.operator).toBe(false);
    const published = await call(client, "publish", { html: "<html><body>Through OAuth</body></html>", title: "oauth", share: false });
    expect(published.error).toBe(false);
    expect((await listSitesByOwner(alice.userId)).some((s) => s.slug === published.data.slug)).toBe(true);
    expect((await call(client, "find")).data.owned.some((s: { slug: string }) => s.slug === published.data.slug)).toBe(true);
    // The same bearer is a login on the HTTP API too.
    const me = await (await whoami(new Request(`${origin}/api/auth/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).json();
    expect(me.user.email).toBe(alice.email);
    // …and shows up as a connection the person can see and end.
    const listed = await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: alice.headers }))).json();
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]).toMatchObject({ clientName: "ChatGPT", clientHost: "chatgpt.com", scope: `${SCOPE_READ} ${SCOPE_WRITE}` });
  });

  it("registers a client dynamically when it has no metadata document", async () => {
    const bob = await person("bob");
    const provider = new HostProvider("http://localhost:6274/oauth/callback");
    const { client } = await connectThroughOauth(bob, provider);
    expect(provider.info?.client_id.startsWith("ahc_")).toBe(true);
    expect((await call(client, "connection")).data.user.email).toBe(bob.email);
    const listed = await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: bob.headers }))).json();
    expect(listed.connections[0]).toMatchObject({ clientName: "Acceptance host", clientHost: null });
  });

  it("keeps a personal token working next to OAuth", async () => {
    const carol = await person("carol");
    const minted = await (await mintToken(new Request(`${origin}/api/me/tokens`, { method: "POST", headers: { ...carol.headers, "content-type": "application/json" }, body: JSON.stringify({ name: "cli" }) }))).json();
    expect((await ping(minted.token)).status).toBe(200);
    const provider = new HostProvider(CHATGPT_REDIRECT, CHATGPT_CLIENT);
    const { tokens } = await connectThroughOauth(carol, provider);
    expect((await ping(tokens.access_token)).status).toBe(200);
    expect((await ping(minted.token)).status).toBe(200);
  });
});

// --- what is refused ---------------------------------------------------------------------------------

describe("refusals", () => {
  it("renders — never redirects — when the client or its return address cannot be verified", async () => {
    const alice = await person("alice");
    const base = { response_type: "code", redirect_uri: CHATGPT_REDIRECT, code_challenge: pkceChallenge(verifier()), code_challenge_method: "S256" };
    const unknown = await prepareAuthorization(new URLSearchParams({ ...base, client_id: "https://chatgpt.com/oauth/other/client.json" }), alice.session, origin);
    expect(unknown).toMatchObject({ kind: "invalid", title: "Unknown application" });
    const elsewhere = await prepareAuthorization(new URLSearchParams({ ...base, client_id: CHATGPT_CLIENT, redirect_uri: "https://evil.example/cb" }), alice.session, origin);
    expect(elsewhere).toMatchObject({ kind: "invalid", title: "Invalid redirect address" });
    documents[CHATGPT_CLIENT] = { ...chatgptDocument, client_id: "https://chatgpt.com/oauth/somebody-else.json" };
    __setClientDocumentTransportForTests({ fetch: async (url) => new Response(JSON.stringify(documents[url]), { headers: { "content-type": "application/json" } }), lookup: async () => [{ address: "104.18.32.47" }] });
    expect(await prepareAuthorization(new URLSearchParams({ ...base, client_id: CHATGPT_CLIENT }), alice.session, origin)).toMatchObject({ kind: "invalid", title: "Unknown application" });
    // A document host that resolves to a private address is not fetched at all.
    __setClientDocumentTransportForTests({ fetch: async () => { throw new Error("must not fetch"); }, lookup: async () => [{ address: "10.0.0.8" }] });
    expect(await prepareAuthorization(new URLSearchParams({ ...base, client_id: CHATGPT_CLIENT }), alice.session, origin)).toMatchObject({ kind: "invalid", title: "Unknown application" });
    // An operator's allow-list wins over a perfectly good document.
    __setClientDocumentTransportForTests({ fetch: async () => new Response(JSON.stringify(chatgptDocument), { headers: { "content-type": "application/json" } }), lookup: async () => [{ address: "104.18.32.47" }] });
    process.env.ARTIFACT_OAUTH_CLIENT_HOSTS = "claude.ai";
    expect(await prepareAuthorization(new URLSearchParams({ ...base, client_id: CHATGPT_CLIENT }), alice.session, origin)).toMatchObject({ kind: "invalid", title: "Unknown application" });
    process.env.ARTIFACT_OAUTH_CLIENT_HOSTS = "chatgpt.com";
    expect((await prepareAuthorization(new URLSearchParams({ ...base, client_id: CHATGPT_CLIENT }), null, origin)).kind).toBe("login");
  });

  it("sends a verified client its error, with state, and honours a refusal", async () => {
    const alice = await person("alice");
    const base = { response_type: "code", client_id: CHATGPT_CLIENT, redirect_uri: CHATGPT_REDIRECT, state: "xyz" };
    const noPkce = await prepareAuthorization(new URLSearchParams(base), alice.session, origin);
    expect(noPkce.kind).toBe("redirect");
    const back = new URL((noPkce as { location: string }).location);
    expect(`${back.origin}${back.pathname}`).toBe(CHATGPT_REDIRECT);
    expect(back.searchParams.get("error")).toBe("invalid_request"); expect(back.searchParams.get("state")).toBe("xyz"); expect(back.searchParams.get("iss")).toBe(origin);
    const wrongResource = await prepareAuthorization(new URLSearchParams({ ...base, code_challenge: pkceChallenge(verifier()), code_challenge_method: "S256", resource: "https://other.example/mcp" }), alice.session, origin);
    expect(new URL((wrongResource as { location: string }).location).searchParams.get("error")).toBe("invalid_target");
    const params = new URLSearchParams({ ...base, code_challenge: pkceChallenge(verifier()), code_challenge_method: "S256" });
    const denied = await consent(alice, new URL(`${origin}/oauth/authorize?${params}`), "deny");
    expect(denied.searchParams.get("error")).toBe("access_denied"); expect(denied.searchParams.get("state")).toBe("xyz");
    // A token session cannot answer for the person, and nobody can answer somebody else's request.
    const outcome = await prepareAuthorization(params, alice.session, origin);
    const bob = await person("bob");
    const stolen = await decisionEndpoint(new Request(`${origin}/oauth/decision`, { method: "POST", headers: bob.headers, body: new URLSearchParams({ request: (outcome as { requestId: string }).requestId, decision: "allow" }) }));
    expect(stolen.status).toBe(400);
    const crossSite = await decisionEndpoint(new Request(`${origin}/oauth/decision`, { method: "POST", headers: { cookie: alice.cookie, origin: "https://evil.example" }, body: new URLSearchParams({ request: "x", decision: "allow" }) }));
    expect(crossSite.status).toBe(401);
  });

  it("holds the token endpoint to PKCE, the redirect address, the client and single use", async () => {
    const alice = await person("alice");
    const v = verifier();
    const wrongVerifier = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: verifier(), redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    expect(wrongVerifier).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    const wrongRedirect = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect", client_id: CHATGPT_CLIENT });
    expect(wrongRedirect.body.error).toBe("invalid_grant");
    const unknownClient = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: "ahc_nobody" });
    expect(unknownClient).toMatchObject({ status: 401, body: { error: "invalid_client" } });
    const code = await codeFor(alice, v);
    const ok = await exchange({ grant_type: "authorization_code", code, code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT, resource: origin });
    expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.body).toMatchObject({ token_type: "Bearer", scope: `${SCOPE_READ} ${SCOPE_WRITE}` }); expect(ok.body.expires_in).toBe(3600);
    expect((await ping(String(ok.body.access_token))).status).toBe(200);
    // The same code again: refused, and the tokens it produced are dead — the first redeemer may have been the thief.
    const replay = await exchange({ grant_type: "authorization_code", code, code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await ping(String(ok.body.access_token))).status).toBe(401);
    expect((await exchange({ grant_type: "password", client_id: CHATGPT_CLIENT })).body.error).toBe("unsupported_grant_type");
  });

  it("rotates refresh tokens and ends the connection when one is replayed", async () => {
    const alice = await person("alice");
    const v = verifier();
    const first = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    const second = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT });
    expect(second.status).toBe(200);
    expect(second.body.access_token).not.toBe(first.body.access_token); expect(second.body.refresh_token).not.toBe(first.body.refresh_token);
    expect((await ping(String(second.body.access_token))).status).toBe(200);
    // Narrowing is allowed; widening is not.
    const narrowed = await exchange({ grant_type: "refresh_token", refresh_token: String(second.body.refresh_token), client_id: CHATGPT_CLIENT, scope: SCOPE_READ });
    expect(narrowed.body.scope).toBe(SCOPE_READ);
    const widened = await exchange({ grant_type: "refresh_token", refresh_token: String(narrowed.body.refresh_token), client_id: CHATGPT_CLIENT, scope: `${SCOPE_READ} ${SCOPE_WRITE}` });
    expect(widened.body.error).toBe("invalid_scope");
    // The first refresh token was retired by its rotation: presented again, past the grace window
    // that forgives an honest parallel refresh, it is theft.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 60 * 1000);
    const replay = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await ping(String(second.body.access_token))).status).toBe(401);
    expect((await ping(String(narrowed.body.access_token))).status).toBe(401);
  });

  it("refuses an expired access token, and says so to an agent that presents one", async () => {
    const alice = await person("alice");
    const v = verifier();
    const issued = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    const bearer = String(issued.body.access_token);
    expect((await ping(bearer)).status).toBe(200);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    expect((await ping(bearer)).status).toBe(401);
    const me = await whoami(new Request(`${origin}/api/auth/me`, { headers: { authorization: `Bearer ${bearer}` } }));
    expect(me.status).toBe(401); expect((await me.json()).code).toBe("token_expired");
    // A token minted for another deployment address is nobody's here.
    vi.useRealTimers();
    process.env.ARTIFACT_PUBLIC_URL = "https://elsewhere.example";
    const fresh = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v, { resource: "https://elsewhere.example/mcp" }), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    expect(fresh.status).toBe(200);
    delete process.env.ARTIFACT_PUBLIC_URL;
    expect((await ping(String(fresh.body.access_token))).status).toBe(401);
    expect((await (await whoami(new Request(`${origin}/api/auth/me`, { headers: { authorization: `Bearer ${fresh.body.access_token}` } }))).json()).code).toBe("token_unknown");
  });
});

// --- scope, the account page, and the end of a connection ------------------------------------------

describe("scope and lifecycle", () => {
  it("lets a read-only grant read and refuses it every change, in OAuth's own words", async () => {
    const alice = await person("alice");
    const v = verifier();
    const issued = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v, { scope: `${SCOPE_READ} openid email` }), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    expect(issued.body.scope).toBe(SCOPE_READ);
    const bearer = String(issued.body.access_token);
    const forbidden = await rpc(bearer, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "artifact_site_publish", arguments: { html: "<html></html>", share: false } } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect((await forbidden.json()).code).toBe("insufficient_scope");
    const rest = await createSite(new Request(`${origin}/api/sites`, { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "paste", html: "<html></html>" }) }));
    expect(rest.status).toBe(403); expect((await rest.json()).code).toBe("insufficient_scope");
    expect((await whoami(new Request(`${origin}/api/auth/me`, { headers: { authorization: `Bearer ${bearer}` } }))).status).toBe(200);
    const listing = await rpc(bearer, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "artifact_site_find", arguments: {} } });
    expect(listing.status).toBe(200);
  });

  it("cannot mint tokens or approve devices from an OAuth session", async () => {
    const alice = await person("alice");
    const { tokens } = await connectThroughOauth(alice, new HostProvider(CHATGPT_REDIRECT, CHATGPT_CLIENT));
    const minted = await mintToken(new Request(`${origin}/api/me/tokens`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}`, origin, "content-type": "application/json" }, body: JSON.stringify({ name: "escalate" }) }));
    expect(minted.status).toBe(401);
    const listed = await listConnections(new Request(`${origin}/api/me/connections`, { headers: { authorization: `Bearer ${tokens.access_token}` } }));
    expect(listed.status).toBe(401);
  });

  it("disconnects from the account page, on revocation by the client, and when the account is disabled", async () => {
    const alice = await person("alice");
    // Three different applications: approving the SAME one again would replace its connection (tested below).
    const one = await connectThroughOauth(alice, new HostProvider(CHATGPT_REDIRECT, CHATGPT_CLIENT));
    const two = await connectThroughOauth(alice, new HostProvider("http://localhost:6274/oauth/callback"));
    const three = await connectThroughOauth(alice, new HostProvider(CLAUDE_REDIRECT, CLAUDE_CLIENT));
    const rows = (await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: alice.headers }))).json()).connections as { id: string; clientName: string }[];
    expect(rows).toHaveLength(3);
    // Disconnect from My sites: owner-scoped, immediate.
    const bob = await person("bob");
    const target = rows.find((r) => r.clientName === "Acceptance host")!;
    expect((await disconnect(new Request(`${origin}/api/me/connections/${target.id}`, { method: "DELETE", headers: bob.headers }), { params: Promise.resolve({ id: target.id }) })).status).toBe(404);
    expect((await disconnect(new Request(`${origin}/api/me/connections/${target.id}`, { method: "DELETE", headers: alice.headers }), { params: Promise.resolve({ id: target.id }) })).status).toBe(200);
    expect((await ping(two.tokens.access_token)).status).toBe(401);
    expect((await ping(one.tokens.access_token)).status).toBe(200);
    // The client hands its refresh token back (RFC 7009): the whole grant goes.
    const revoked = await revokeEndpoint(new Request(`${origin}/oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: one.tokens.refresh_token!, client_id: CHATGPT_CLIENT }) }));
    expect(revoked.status).toBe(200);
    expect((await ping(one.tokens.access_token)).status).toBe(401);
    expect((await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: alice.headers }))).json()).connections).toHaveLength(1);
    // Disabling the account ends what is left.
    process.env.PUBLISH_API_TOKEN = "operator-secret";
    await disableUser(new Request(`${origin}/api/admin/users`, { headers: { authorization: "Bearer operator-secret" } }), { kind: "token", userId: null }, alice.userId, "test");
    expect((await ping(three.tokens.access_token)).status).toBe(401);
    // And the sweep leaves nothing behind once everything has aged out.
    expect(await pruneOauth(Date.now() + 100 * 24 * 60 * 60 * 1000)).toBeGreaterThan(0);
  });
});

// --- what the review asked for -----------------------------------------------------------------------

describe("review follow-ups", () => {
  it("derives the same issuer for the consent page as for the routes", () => {
    const bag = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });
    const route = (url: string, h: Record<string, string>) => issuerFor(new Request(url, { headers: h }));
    // A plain-http checkout without ARTIFACT_PUBLIC_URL: both sides say http, or the token would be bound to an https resource /mcp never sees.
    expect(issuerFromHeaders(bag({ host: "localhost:4300" }))).toBe(route("http://localhost:4300/oauth/token", { host: "localhost:4300" }));
    expect(issuerFromHeaders(bag({ host: "hub.example", "x-forwarded-proto": "https" }))).toBe(route("http://10.0.0.5:4300/oauth/token", { host: "hub.example", "x-forwarded-proto": "https" }));
    process.env.ARTIFACT_PUBLIC_URL = "https://public.example";
    expect(issuerFromHeaders(bag({ host: "whatever" }))).toBe("https://public.example");
    expect(route("http://localhost:4300/x", {})).toBe("https://public.example");
    delete process.env.ARTIFACT_PUBLIC_URL;
    expect(issuerFromHeaders(bag({}))).toBeNull();
  });

  it("accepts a loopback client on whichever port it could open, and a native application's own scheme", async () => {
    const alice = await person("alice");
    const registered = await (await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Inspector", redirect_uris: ["http://127.0.0.1:6274/oauth/callback", "cursor://anysphere.cursor-mcp/oauth/callback"] }) }))).json();
    expect(registered.client_id.startsWith("ahc_")).toBe(true);
    const v = verifier();
    const base = { response_type: "code", client_id: registered.client_id, code_challenge: pkceChallenge(v), code_challenge_method: "S256", state: "p" };
    const sentTo = await consent(alice, new URL(`${origin}/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "http://127.0.0.1:53211/oauth/callback" })}`));
    expect(sentTo.port).toBe("53211");
    const issued = await exchange({ grant_type: "authorization_code", code: sentTo.searchParams.get("code")!, code_verifier: v, redirect_uri: "http://127.0.0.1:53211/oauth/callback", client_id: registered.client_id });
    expect(issued.status).toBe(200);
    // The port is the only thing that may vary: a different path on the loopback host is still unregistered.
    expect(await prepareAuthorization(new URLSearchParams({ ...base, redirect_uri: "http://127.0.0.1:53211/other" }), alice.session, origin)).toMatchObject({ kind: "invalid", title: "Invalid redirect address" });
    const app = await consent(alice, new URL(`${origin}/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: "cursor://anysphere.cursor-mcp/oauth/callback" })}`));
    expect(app.protocol).toBe("cursor:"); expect(app.searchParams.get("code")).toBeTruthy();
    const refused = await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) }));
    expect((await refused.json()).error).toBe("invalid_redirect_uri");
  });

  it("lists one connection per grant after a narrowing refresh, and retires the wider access token at once", async () => {
    const alice = await person("alice");
    const v = verifier();
    const first = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    const narrowed = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT, scope: SCOPE_READ });
    expect(narrowed.status).toBe(200);
    const rows = (await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: alice.headers }))).json()).connections;
    expect(rows).toHaveLength(1); expect(rows[0].scope).toBe(SCOPE_READ);
    expect((await ping(String(first.body.access_token))).status).toBe(401);
    expect((await ping(String(narrowed.body.access_token))).status).toBe(200);
  });

  it("reports a lost race as the replay it is, for codes and refresh tokens alike", async () => {
    const alice = await person("alice");
    const v = verifier();
    const code = await codeFor(alice, v);
    expect((await redeemOauthCode(sha256hex(code)))?.reused).toBe(false);
    expect((await redeemOauthCode(sha256hex(code)))?.reused).toBe(true);
    expect(await redeemOauthCode(sha256hex("never-issued"))).toBeNull();
    const issued = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    const id = sha256hex(String(issued.body.refresh_token));
    expect((await consumeOauthRefreshToken(id))?.reused).toBe(false);
    expect((await consumeOauthRefreshToken(id))?.reused).toBe(true);
    expect(await consumeOauthRefreshToken(sha256hex(String(issued.body.access_token)))).toBeNull();
  });

  it("refuses a code or a refresh token once the account is disabled", async () => {
    const alice = await person("alice");
    const v = verifier();
    const pending = await codeFor(alice, v);
    const live = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    process.env.PUBLISH_API_TOKEN = "operator-secret";
    await disableUser(new Request(`${origin}/api/admin/users`, { headers: { authorization: "Bearer operator-secret" } }), { kind: "token", userId: null }, alice.userId, "test");
    const late = await exchange({ grant_type: "authorization_code", code: pending, code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    expect(late).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
    expect((await exchange({ grant_type: "refresh_token", refresh_token: String(live.body.refresh_token), client_id: CHATGPT_CLIENT })).body.error).toBe("invalid_grant");
  });

  it("supersedes a registered client's previous connection, and lets an application's installs coexist", async () => {
    const alice = await person("alice");
    const list = async () => (await (await listConnections(new Request(`${origin}/api/me/connections`, { headers: alice.headers }))).json()).connections as { clientName: string }[];
    // A dynamically registered client_id is one install: approving it again is a replacement.
    const installed = new HostProvider("http://localhost:6274/oauth/callback");
    const first = await connectThroughOauth(alice, installed);
    const again = new HostProvider("http://localhost:6274/oauth/callback");
    again.info = installed.info; // the same registration, consenting a second time
    const second = await connectThroughOauth(alice, again);
    expect((await ping(second.tokens.access_token)).status).toBe(200);
    expect((await ping(first.tokens.access_token)).status).toBe(401);
    expect(await list()).toHaveLength(1);
    // A metadata document is one per APPLICATION, shared by every machine the person runs it on:
    // the laptop's consent must not revoke the desktop's grant.
    const laptop = await connectThroughOauth(alice, new HostProvider(CLAUDE_REDIRECT, CLAUDE_CLIENT));
    const desktop = await connectThroughOauth(alice, new HostProvider(CLAUDE_REDIRECT, CLAUDE_CLIENT));
    expect((await ping(laptop.tokens.access_token)).status).toBe(200);
    expect((await ping(desktop.tokens.access_token)).status).toBe(200);
    expect((await list()).filter((r) => r.clientName === "Claude")).toHaveLength(2);
  });

  it("forgives a parallel refresh from the same client inside the grace window, and nothing else", async () => {
    const alice = await person("alice");
    const v = verifier();
    const first = await exchange({ grant_type: "authorization_code", code: await codeFor(alice, v), code_verifier: v, redirect_uri: CHATGPT_REDIRECT, client_id: CHATGPT_CLIENT });
    const rotated = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT });
    expect(rotated.status).toBe(200);
    // The honest loser of a refresh race: refused, but the winner's pair survives.
    const raced = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT });
    expect(raced.body.error).toBe("invalid_grant");
    expect((await ping(String(rotated.body.access_token))).status).toBe(200);
    // Well after the window the same replay is theft, and the grant ends.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 5 * 60 * 1000);
    const late = await exchange({ grant_type: "refresh_token", refresh_token: String(first.body.refresh_token), client_id: CHATGPT_CLIENT });
    expect(late.body.error).toBe("invalid_grant");
    expect((await ping(String(rotated.body.access_token))).status).toBe(401);
  });

  it("accepts an application scheme only in the reverse-domain shape or from a known client", async () => {
    const register = async (uri: string) => (await (await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) }))).json());
    for (const uri of ["com.example.app:/oauth/callback", "cursor://anysphere.cursor-mcp/oauth/callback", "vscode-insiders://ms.mcp/callback"]) expect((await register(uri)).client_id).toBeTruthy();
    for (const uri of ["ms-msdt:/id", "search-ms:query", "x-apple.systempreferences:com.apple.preference", "javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd"]) expect((await register(uri)).error).toBe("invalid_redirect_uri");
  });

  it("sweeps registrations nobody ever used after a day, and keeps the ones in use", async () => {
    const register = async (name: string) => (await (await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: ["http://127.0.0.1:6274/oauth/callback"] }) }))).json()).client_id as string;
    const abandoned = await register("abandoned");
    const used = await register("used");
    const alice = await person("alice");
    await prepareAuthorization(new URLSearchParams({ response_type: "code", client_id: used, redirect_uri: "http://127.0.0.1:6274/oauth/callback", code_challenge: pkceChallenge(verifier()), code_challenge_method: "S256" }), alice.session, origin);
    await pruneOauth(Date.now() + 2 * 24 * 60 * 60 * 1000);
    expect(await getOauthClient(abandoned)).toBeNull();
    expect(await getOauthClient(used)).not.toBeNull();
  });

  it("refuses to be framed, and refuses loopback or native redirects under a host allow-list", async () => {
    const rules = await (await import("../next.config")).default.headers!();
    for (const source of ["/oauth/:path*", "/activate"]) {
      expect(rules.find((r) => r.source === source)?.headers).toEqual(expect.arrayContaining([
        { key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ]));
    }
    process.env.ARTIFACT_OAUTH_CLIENT_HOSTS = "chatgpt.com";
    for (const uri of ["http://127.0.0.1:6274/oauth/callback", "cursor://anysphere.cursor-mcp/oauth/callback", "https://evil.example/cb"]) {
      const refused = await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) }));
      expect((await refused.json()).error).toBe("invalid_redirect_uri");
    }
    const allowed = await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector/oauth/x"] }) }));
    expect(allowed.status).toBe(201);
  });
});

describe("console settings", () => {
  it("takes the OAuth knobs from the console first, then the environment", async () => {
    const register = async (uri: string) => (await (await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [uri] }) }))).json());
    // Extra application schemes: an operator admits an editor without a release.
    expect((await register("windsurf://oauth/callback")).error).toBe("invalid_redirect_uri");
    await updateSettings({ oauthAppSchemes: "Windsurf, zed" }, null);
    expect((await register("windsurf://oauth/callback")).client_id).toBeTruthy();
    expect((await register("zed://oauth/callback")).client_id).toBeTruthy();
    await expect(updateSettings({ oauthAppSchemes: "not a scheme!" }, null)).rejects.toThrow(/URL scheme/);
    await expect(updateSettings({ oauthClientHosts: "chatgpt.com,-bad-" }, null)).rejects.toThrow(/hostname/);
    // Dynamic registration off: the discovery document stops advertising it and the endpoint answers 404.
    await updateSettings({ oauthDcr: "off" }, null);
    expect((await (await authorizationServer(new Request(`${origin}/.well-known/oauth-authorization-server`))).json()).registration_endpoint).toBeUndefined();
    expect((await registerEndpoint(new Request(`${origin}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }))).status).toBe(404);
    // The host allow-list from the console wins over the environment, and applies to a document that was already cached.
    const alice = await person("alice");
    const ask = (clientId: string, redirect: string) => prepareAuthorization(new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: pkceChallenge(verifier()), code_challenge_method: "S256" }), alice.session, origin);
    expect((await ask(CLAUDE_CLIENT, CLAUDE_REDIRECT)).kind).toBe("consent");
    await updateSettings({ oauthDcr: null, oauthAppSchemes: null, oauthClientHosts: "chatgpt.com" }, null);
    process.env.ARTIFACT_OAUTH_CLIENT_HOSTS = "claude.ai";
    expect(await ask(CLAUDE_CLIENT, CLAUDE_REDIRECT)).toMatchObject({ kind: "invalid", title: "Unknown application" });
    expect((await ask(CHATGPT_CLIENT, CHATGPT_REDIRECT)).kind).toBe("consent");
    await updateSettings({ oauthClientHosts: null }, null);
    expect((await ask(CLAUDE_CLIENT, CLAUDE_REDIRECT)).kind).toBe("consent");
    expect(await ask(CHATGPT_CLIENT, CHATGPT_REDIRECT)).toMatchObject({ kind: "invalid", title: "Unknown application" });
  });
});
