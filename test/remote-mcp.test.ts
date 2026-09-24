import { putUserSiteRole } from "@/lib/role-bindings";
import { mcpTools } from "@/lib/mcp-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { POST as mcp, GET as mcpGet } from "@/app/mcp/route";
import { POST as mint, GET as tokens } from "@/app/api/me/tokens/route";
import { DELETE as revoke } from "@/app/api/me/tokens/[id]/route";
import { upsertUser, closeDbForTests } from "@/lib/db";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { mintSession } from "@/lib/session";
const origin = "http://test.local";
let dir: string;
const clients: Client[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remote-mcp-")); process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_OIDC_ISSUER = "https://identity.test"; process.env.ARTIFACT_OIDC_CLIENT_ID = "test"; process.env.ARTIFACT_OIDC_CLIENT_SECRET = "test";
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on"; process.env.ARTIFACT_CREATE_POLICY = "open"; process.env.ARTIFACT_DEFAULT_VISIBILITY = "private";
});
afterEach(async () => { for (const c of clients.splice(0)) await c.close(); await closeDbForTests(); rmSync(dir, { recursive: true, force: true }); for (const k of ["ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET", "ARTIFACT_ENFORCE_OWNERSHIP", "ARTIFACT_CREATE_POLICY", "PUBLISH_API_TOKEN", "ARTIFACT_DEFAULT_VISIBILITY", "ARTIFACT_PUBLIC_URL"]) delete process.env[k]; });
async function identity(subject: string) {
  const user = await upsertUser({ authProvider: "test", providerSubject: subject, email: `${subject}@example.test`, emailVerified: true });
  const { cookie } = await mintSession(new Request(origin), user.id);
  const headers = { cookie: cookie.split(";")[0], origin, "content-type": "application/json" };
  const response = await mint(new Request(`${origin}/api/me/tokens`, { method: "POST", headers, body: JSON.stringify({ name: subject }) }));
  expect(response.status).toBe(201); expect(response.headers.get("cache-control")).toBe("no-store");
  return { ...await response.json(), headers };
}
async function connect(token: string) {
  const c = new Client({ name: "acceptance", version: "1" }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: async (input, init) => {
    const request = new Request(input, init); return request.method === "POST" ? mcp(request) : mcpGet();
  } }));
  return c;
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name: `artifact_site_${name}`, arguments: args });
  const content = result.content as { text: string }[];
  return { error: Boolean(result.isError), data: (() => { try { return JSON.parse(content[0].text); } catch { return { error: content[0].text }; } })() };
}

it("runs publication, ownership, versions, edit, share, fork, export and delete over HTTP MCP", async () => {
  const a = await identity("alice"), b = await identity("bob"); const ca = await connect(a.token), cb = await connect(b.token);
  const created = await call(ca, "publish", { html: "<html><body>Remote MCP report</body></html>", title: "report", share: false }); expect(created.error).toBe(false);
  const slug = created.data.slug;
  expect((await call(cb, "get_site", { slug })).error).toBe(true);
  expect((await call(cb, "delete", { slug })).error).toBe(true);
  expect((await call(ca, "find")).data.owned.some((s: { slug: string }) => s.slug === slug)).toBe(true);
  const exported = await call(ca, "export", { slug }); expect(exported.error).toBe(false);
  const version = exported.data.versionId;
  const downloaded = await call(ca, "export", { slug, version_id: version, path: "index.html" });
  expect(Buffer.from(downloaded.data.base64, "base64").toString()).toContain("Remote MCP report");
  expect((await call(ca, "update", { slug, title: "Updated report" })).error).toBe(false);
  expect((await call(ca, "edit", { slug, path: "index.html", content: "<html><body>Second revision</body></html>", expected_version: version })).error).toBe(false);
  expect((await call(ca, "update", { slug, html: "stale", expected_version: version })).error).toBe(true);
  expect((await call(ca, "rollback", { slug, version_id: version })).error).toBe(false);
  expect((await call(ca, "share", { slug, policy: "public" })).error).toBe(false);
  expect((await call(cb, "read", { slug })).error).toBe(true); // A link must be supplied explicitly.
  const fork = await call(ca, "fork", { slug }); expect(fork.error).toBe(false);
  expect((await call(ca, "delete", { slug: fork.data.slug })).error).toBe(false);
  expect((await call(ca, "delete", { slug })).error).toBe(false);
});

it("transfers binary and directory files in chunks, rejects traversal and cross-user upload access", async () => {
  const a = await identity("alice"), b = await identity("bob"); const ca = await connect(a.token), cb = await connect(b.token);
  const upload = await call(ca, "upload_start", { title: "Chunk tree" }); const version_id = upload.data.versionId;
  expect((await call(cb, "upload_write", { upload_id: version_id, path: "index.html", index: 0, base64: "YQ==", final: true })).error).toBe(true);
  expect((await call(ca, "upload_write", { upload_id: version_id, path: "../../escape", index: 0, base64: "YQ==", final: true })).error).toBe(true);
  for (const [path, bytes] of [["index.html", Buffer.from("<html><body>Binary tree</body></html>")], ["assets/data.bin", Buffer.alloc(700000, 173)]] as const) {
    let index = 0;
    for (let offset = 0; offset < bytes.length; offset += 262144) {
      const args = { upload_id: version_id, path, index: index++, base64: bytes.subarray(offset, offset + 262144).toString("base64"), final: offset + 262144 >= bytes.length };
      expect((await call(ca, "upload_write", args)).error).toBe(false);
      expect((await call(ca, "upload_write", args)).error).toBe(false);
      expect((await call(cb, "upload_write", args)).error).toBe(true);
    }
  }
  const committed = await call(ca, "publish", { upload_id: version_id, share: false }); expect(committed.error).toBe(false);
  const result = await call(ca, "export", { slug: committed.data.slug, version_id, path: "assets/data.bin", offset: 650000 });
  expect(Buffer.from(result.data.base64, "base64")).toEqual(Buffer.alloc(50000, 173));
});

it("rejects cookies, invalid and revoked tokens and cross-site origins, and protects token creation", async () => {
  const a = await identity("alice"); const c = await connect(a.token);
  expect((await tokens(new Request(`${origin}/api/me/tokens`, { headers: a.headers }))).status).toBe(200);
  const rejected = await mint(new Request(`${origin}/api/me/tokens`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, origin, "content-type": "application/json" }, body: '{"name":"bad"}' })); expect(rejected.status).toBe(401);
  for (const headers of [{}, { cookie: a.headers.cookie }, { authorization: "Bearer fake" }] as Record<string, string>[]) expect((await mcp(new Request(`${origin}/mcp`, { method: "POST", headers, body: '{}' }))).status).toBe(401);
  expect((await mcp(new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, origin: "https://evil.test" }, body: '{}' }))).status).toBe(403);
  expect((await revoke(new Request(`${origin}/api/me/tokens/${a.id}`, { method: "DELETE", headers: a.headers }), { params: Promise.resolve({ id: a.id }) })).status).toBe(200);
  await expect(call(c, "connection")).rejects.toThrow();
});

it("enforces streamed request bounds, token ownership and cancellation", async () => {
  const a = await identity("alice"), b = await identity("bob"); const ca = await connect(a.token);
  const oversized = new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body: "x".repeat(2 * 1024 * 1024 + 1) });
  expect((await mcp(oversized)).status).toBe(413);
  expect((await revoke(new Request(`${origin}/api/me/tokens/${a.id}`, { method: "DELETE", headers: b.headers }), { params: Promise.resolve({ id: a.id }) })).status).toBe(404);
  const started = await call(ca, "upload_start"); const version_id = started.data.versionId;
  const args = { upload_id: version_id, path: "index.html", index: 0, base64: "bad!", final: true };
  expect((await call(ca, "upload_write", args)).error).toBe(true);
  expect((await call(ca, "upload_cancel", { upload_id: version_id })).error).toBe(false);
  expect((await call(ca, "upload_write", { ...args, base64: "YQ==" })).error).toBe(true);
});

it("rejects a stale chunked update at commit and preserves the newer contents", async () => {
  const a = await identity("alice"), ca = await connect(a.token);
  const published = await call(ca, "publish", { files: [{ path: "index.html", content: "<html>before</html>" }, { path: "a.txt", content: "a" }], share: false });
  const slug = published.data.slug; const original = (await call(ca, "export", { slug })).data.versionId;
  const version_id = (await call(ca, "upload_start", { slug })).data.versionId;
  await call(ca, "upload_write", { upload_id: version_id, path: "index.html", final: true, index: 0, base64: Buffer.from("<html>stale</html>").toString("base64") });
  expect((await call(ca, "edit", { slug, path: "index.html", content: "<html>newer</html>", expected_version: original })).error).toBe(false);
  const result = await call(ca, "update", { slug, upload_id: version_id, expected_version: original });
  expect(result.error).toBe(true); expect(result.data.error).toContain("Version conflict"); expect(result.data.code).toBe("version_conflict"); expect(result.data.currentVersionId).toBeTruthy();
  expect((await call(ca, "read", { slug, file: "index.html" })).data.text).toContain("newer");
  const { listUploadSessionsBefore } = await import("@/lib/db");
  expect((await listUploadSessionsBefore(Date.now() + 1)).some(s => s.targetSlug === version_id)).toBe(true);
  // Explicitly choosing the staged content after inspecting the winner can reuse its bytes.
  expect((await call(ca, "update", { slug, upload_id: version_id, expected_version: result.data.currentVersionId })).error).toBe(false);
  expect((await call(ca, "read", { slug, file: "index.html" })).data.text).toContain("stale");
});

it("publishes and exports a document via chunk tools without a local filesystem path", async () => {
  const a = await identity("alice"), ca = await connect(a.token);
  // A legacy Office fixture carries the same OLE signature used by document upload tests.
  const bytes = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1, 2]);
  const version_id = (await call(ca, "upload_start", { title: "Document" })).data.versionId;
  expect((await call(ca, "upload_write", { upload_id: version_id, path: "report.doc", final: true, index: 0, base64: bytes.toString("base64") })).error).toBe(false);
  const result = await call(ca, "publish", { upload_id: version_id, share: false }); expect(result.error).toBe(false); expect(result.data.kind).toBe("document");
  const exported = (await call(ca, "export", { slug: result.data.slug })).data;
  const downloaded = await call(ca, "export", { slug: result.data.slug, version_id: exported.versionId, path: "original/report.doc" });
  expect(Buffer.from(downloaded.data.base64, "base64")).toEqual(bytes);
});

it("uses the configured public address behind a reverse proxy", async () => {
  const a = await identity("alice"), ca = await connect(a.token);
  const created = await call(ca, "publish", { html: "<html>Proxy export</html>", share: false });
  process.env.ARTIFACT_PUBLIC_URL = "https://public.example";
  const exported = await call(ca, "export", { slug: created.data.slug });
  expect(exported.data.downloadUrl).toBe(`https://public.example/api/sites/${created.data.slug}/export?version_id=${exported.data.versionId}`);
});


it("rate limits invalid credentials before repeated authentication lookups", async () => {
  const before = process.env.ARTIFACT_RATE_LIMIT;
  const burst = process.env.ARTIFACT_RATE_LIMIT_BURST;
  process.env.ARTIFACT_RATE_LIMIT = "on";
  process.env.ARTIFACT_RATE_LIMIT_BURST = "1";
  __resetRateLimitForTests();
  try {
    const request = () => new Request(`${origin}/mcp`, { method: "POST", headers: { authorization: "Bearer invalid", "x-real-ip": "192.0.2.34" }, body: "{}" });
    for (let i = 0; i < 12; i++) expect((await mcp(request())).status).toBe(401);
    expect((await mcp(request())).status).toBe(429);
  } finally {
    if (before === undefined) delete process.env.ARTIFACT_RATE_LIMIT; else process.env.ARTIFACT_RATE_LIMIT = before;
    if (burst === undefined) delete process.env.ARTIFACT_RATE_LIMIT_BURST; else process.env.ARTIFACT_RATE_LIMIT_BURST = burst;
    __resetRateLimitForTests();
  }
});

it("keeps operator upload identities out of site ownership and anonymous expiry", async () => {
  process.env.PUBLISH_API_TOKEN = "operator-review";
  process.env.ARTIFACT_ANON_SITE_TTL_DAYS = "1";
  process.env.ARTIFACT_QUOTA_SITES_PER_ANON = "1";
  const { getSiteBySlug } = await import("@/lib/db");
  const { sha256hex } = await import("@/lib/crypto");
  const { DELETE } = await import("@/app/api/sites/[slug]/route");
  try {
    const c = await connect("operator-review");
    for (let i = 0; i < 2; i++) {
      const created = await call(c, "publish", { html: "<html>operator</html>", share: false });
      expect(created.error).toBe(false); expect(created.data.expiresAt).toBeNull();
      const site = await getSiteBySlug(created.data.slug); expect(site?.anonOwnerId).toBeNull();
      const response = await DELETE(new Request(`${origin}/api/sites/${site!.slug}`, { method: "DELETE", headers: { origin, cookie: `ah_anon=mcp_${sha256hex("Bearer operator-review")}` } }), { params: Promise.resolve({ slug: site!.slug }) });
      expect(response.status).not.toBe(200);
    }
    const version_id = (await call(c, "upload_start")).data.versionId;
    await call(c, "upload_write", { upload_id: version_id, path: "index.html", final: true, index: 0, base64: Buffer.from("<html>operator chunk</html>").toString("base64") });
    const committed = await call(c, "publish", { upload_id: version_id, share: false }); expect(committed.error).toBe(false);
    expect(committed.data.expiresAt).toBeNull(); expect((await getSiteBySlug(committed.data.slug))?.anonOwnerId).toBeNull();
  } finally { delete process.env.ARTIFACT_ANON_SITE_TTL_DAYS; delete process.env.ARTIFACT_QUOTA_SITES_PER_ANON; }
});

it("rejects unauthorized creation before allocating an upload session", async () => {
  const { POST } = await import("@/app/api/uploads/route");
  process.env.ARTIFACT_CREATE_POLICY = "login";
  expect((await POST(new Request(`${origin}/api/uploads`, { method: "POST", body: "{}" }))).status).toBe(401);
});

it("returns actionable conflicts for both inline and staged Office updates", async () => {
  const a = await identity("alice"), c = await connect(a.token);
  const content = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1, 2]).toString("base64");
  const files = [{ path: "report.doc", content, encoding: "base64" }];
  const slug = (await call(c, "publish", { files, share: false })).data.slug;
  const expected_version = (await call(c, "export", { slug })).data.versionId;
  const next = await call(c, "update", { slug, files, expected_version }); expect(next.error).toBe(false);
  const stale = await call(c, "update", { slug, files, expected_version });
  expect(stale.error).toBe(true); expect(stale.data.code).toBe("version_conflict"); expect(stale.data.currentVersionId).toBe(next.data.versionId);
  const version_id = (await call(c, "upload_start", { slug })).data.versionId;
  await call(c, "upload_write", { upload_id: version_id, path: "report.doc", final: true, index: 0, base64: content });
  const staged = await call(c, "update", { slug, upload_id: version_id, expected_version });
  expect(staged.error).toBe(true); expect(staged.data.code).toBe("version_conflict"); expect(staged.data.currentVersionId).toBe(next.data.versionId);
});

it("supports a 5 MiB transfer with limits enabled and charges dispatched operations once", async () => {
  const a = await identity("alice"), c = await connect(a.token);
  process.env.ARTIFACT_RATE_LIMIT = "on"; __resetRateLimitForTests();
  try {
    const version_id = (await call(c, "upload_start")).data.versionId;
    const block = Buffer.alloc(256 * 1024, 32).toString("base64");
    for (let index = 0; index < 20; index++) expect((await call(c, "upload_write", { upload_id: version_id, path: "index.html", index, base64: block, final: index === 19 })).error).toBe(false);
    expect((await call(c, "publish", { upload_id: version_id, share: false })).error).toBe(false);
    __resetRateLimitForTests(); process.env.ARTIFACT_RATE_LIMIT_BURST = "2";
    expect((await call(c, "find", { query: "missing" })).error).toBe(false);
    expect((await call(c, "find", { query: "missing" })).error).toBe(false);
    await expect(call(c, "find", { query: "missing" })).rejects.toThrow();
  } finally { delete process.env.ARTIFACT_RATE_LIMIT; delete process.env.ARTIFACT_RATE_LIMIT_BURST; __resetRateLimitForTests(); }
});

it("bounds personal token JSON by actual bytes without Content-Length", async () => {
  const a = await identity("alice");
  const response = await mint(new Request(`${origin}/api/me/tokens`, { method: "POST", headers: a.headers, body: JSON.stringify({ name: "x".repeat(5000) }) }));
  expect(response.status).toBe(413);
});


it("logs unexpected storage errors without exposing details to the caller", async () => {
  const a = await identity("alice"), c = await connect(a.token);
  const slug = (await call(c, "publish", { html: "<html>storage</html>", share: false })).data.slug;
  const version_id = (await call(c, "export", { slug })).data.versionId;
  const { getStorage } = await import("@/lib/storage");
  const fault = new Error("private storage diagnostic");
  const read = vi.spyOn(getStorage(), "readRange").mockRejectedValueOnce(fault);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await call(c, "export", { slug, version_id, path: "index.html" });
    expect(result.error).toBe(true); expect(result.data.error).toBe("Operation failed");
    expect(log).toHaveBeenCalledWith("[mcp]", "artifact_site_export", fault);
  } finally { read.mockRestore(); log.mockRestore(); }
});

it("compares upload file metadata independently of JSON object key order", async () => {
  const { insertUploadSession, compareUploadSessionFiles } = await import("@/lib/db");
  await insertUploadSession({ versionId: "ver_order", siteId: "site_order", targetSlug: null, title: null, ownerKey: "test", createdAt: Date.now(), files: [{ relpath: "a", bytes: 1 }] });
  expect(await compareUploadSessionFiles("ver_order", [{ bytes: 1, relpath: "a" }], [])).toBe(true);
  expect(await compareUploadSessionFiles("ver_order", [{ bytes: 1, relpath: "a" }], [])).toBe(false);
});


it("keeps secret-scoped limits active inside the MCP dispatch scope", async () => {
  const { checkRateLimit, withRateLimitChecked } = await import("@/lib/ratelimit");
  process.env.ARTIFACT_RATE_LIMIT = "on"; __resetRateLimitForTests();
  const request = new Request(origin);
  try {
    withRateLimitChecked(() => {
      for (let i = 0; i < 3; i++) checkRateLimit(request, 0, undefined, 1);
      checkRateLimit(request, 0, "share:secret", 1);
      expect(() => checkRateLimit(request, 0, "share:secret", 1)).toThrow("Too many requests");
    });
  } finally { delete process.env.ARTIFACT_RATE_LIMIT; __resetRateLimitForTests(); }
});

it("disables open claiming without changing private or operator site ownership", async () => {
  const a = await identity("alice");
  process.env.PUBLISH_API_TOKEN = "claim-operator";
  const operator = await connect("claim-operator");
  const personal = await connect(a.token);
  const operatorSlug = (await call(operator, "publish", { html: "<html>private operator</html>", share: false })).data.slug;
  const personalSlug = (await call(personal, "publish", { html: "<html>personal</html>", share: false })).data.slug;
  const { POST: claim } = await import("@/app/api/sites/[slug]/claim/route");
  const { getSiteBySlug } = await import("@/lib/db");
  expect((await claim()).status).toBe(410);
  expect((await getSiteBySlug(operatorSlug))?.ownerId).toBeNull();
  expect((await getSiteBySlug(personalSlug))?.ownerId).toBeTruthy();
});

it("advertises the UI tool catalog with usage context and parameter guidance", async () => {
  const c = await connect((await identity("discovery")).token);
  const tools = (await c.listTools()).tools;
  expect(tools.map(t => [t.name, t.title])).toEqual(mcpTools);
  expect(c.getInstructions()).toContain("connected remote library");
  expect(tools.find(t => t.name === "artifact_site_read")?.annotations?.readOnlyHint).toBe(true);
  expect(tools.find(t => t.name === "artifact_site_delete")?.annotations?.destructiveHint).toBe(true);
  for (const name of ["upload_write", "upload_cancel", "delete"]) expect(tools.find(t => t.name === `artifact_site_${name}`)?.annotations?.idempotentHint).toBe(true);
  const find = tools.find(t => t.name === "artifact_site_find")!;
  expect(find.description).toContain("my artifacts");
  expect(find.description).toContain("remote");
  expect(find.inputSchema.properties?.query).toHaveProperty("description");
  for (const old of ["whoami", "capabilities", "list_sites", "search", "versions", "rename", "list_shares", "download_file", "file_start", "file_chunk", "file_finish", "upload_commit"]) {
    expect(tools.some(t => t.name === `artifact_site_${old}`)).toBe(false);
  }
});

it("updates only the title explicitly and keeps optional detail permissions separate", async () => {
  const c = await connect((await identity("detail-owner")).token);
  const other = await connect((await identity("detail-reader")).token);
  const slug = (await call(c, "publish", { html: "<html>Preserve contents</html>", share: "public" })).data.slug;
  const before = (await call(c, "get_site", { slug })).data.version.id;
  expect((await call(c, "update", { slug, title: "New title" })).error).toBe(false);
  expect((await call(c, "get_site", { slug })).data.version.id).toBe(before);
  expect((await call(c, "update", { slug, title: "", html: "bad" })).error).toBe(true);
  expect((await call(c, "update", { slug, html: "missing version" })).error).toBe(true);
  expect((await call(c, "edit", { slug, path: "wrong.html", content: "wrong", expected_version: before })).error).toBe(true);
  const detail = await call(c, "get_site", { slug, include: ["versions", "shares"] });
  expect(detail.error).toBe(false); expect(detail.data.versions).toHaveLength(1); expect(detail.data.shares).toHaveLength(1);
  expect((await call(other, "get_site", { slug })).error).toBe(true);
  expect((await call(other, "get_site", { slug, include: ["shares"] })).error).toBe(true);
});

it("writes files without separate file lifecycle calls and safely retries the last chunk", async () => {
  const c = await connect((await identity("simple-upload")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: Buffer.from("<html>Simple upload</html>").toString("base64"), final: true };
  expect((await call(c, "upload_write", args)).error).toBe(false);
  const { getStorage } = await import("@/lib/storage");
  const reads = vi.spyOn(getStorage(), "read");
  try {
    expect((await call(c, "upload_write", args)).error).toBe(false);
    // Only verify the retried chunk. Do not re-read/reassemble the entire completed file.
    expect(reads).toHaveBeenCalledTimes(1);
  } finally { reads.mockRestore(); }
  expect((await call(c, "upload_write", { ...args, base64: "YQ==" })).error).toBe(true);
  expect((await call(c, "upload_write", { ...args, index: 1 })).error).toBe(true);
  expect((await call(c, "publish", { upload_id, html: "ambiguous", share: false })).error).toBe(true);
  const site = await call(c, "publish", { upload_id, share: false });
  expect(site.error).toBe(false);
  expect((await call(c, "read", { slug: site.data.slug })).data.text).toContain("Simple upload");
});

it("rejects unfinished uploads and wrong targets, and cancels only the caller's staging", async () => {
  const a = await identity("target-owner"), b = await identity("target-other");
  const c = await connect(a.token), other = await connect(b.token);
  const slug = (await call(c, "publish", { html: "<html>original</html>", share: false })).data.slug;
  const expected_version = (await call(c, "export", { slug })).data.versionId;
  const upload_id = (await call(c, "upload_start", { slug })).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: Buffer.from("<html>replacement</html>").toString("base64"), final: false };
  expect((await call(c, "upload_write", args)).error).toBe(false);
  expect((await call(c, "update", { slug, upload_id, expected_version })).error).toBe(true);
  expect((await call(c, "upload_write", { ...args, final: true })).error).toBe(false);
  expect((await call(c, "publish", { upload_id, share: false })).error).toBe(true);
  expect((await call(c, "update", { slug: "another-target", upload_id, expected_version })).error).toBe(true);
  expect((await call(other, "upload_cancel", { upload_id })).error).toBe(true);
  expect((await call(c, "read", { slug })).data.text).toContain("original");
  const { listUploadSessionsBefore } = await import("@/lib/db");
  expect((await listUploadSessionsBefore(Date.now() + 1)).some(s => s.targetSlug === upload_id)).toBe(true);
  expect((await call(c, "upload_cancel", { upload_id })).error).toBe(false);
  expect((await listUploadSessionsBefore(Date.now() + 1)).some(s => s.targetSlug === upload_id || s.versionId === upload_id)).toBe(false);
});

it("handles empty files, rejects changed retries, and removes parts after successful publication", async () => {
  const c = await connect((await identity("empty-files")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  expect((await call(c, "upload_write", { upload_id, path: "empty.txt", index: 0, base64: "", final: true })).error).toBe(false);
  const write = { upload_id, path: "index.html", index: 0, base64: "PGh0bWw+", final: false };
  expect((await call(c, "upload_write", write)).error).toBe(false);
  expect((await call(c, "upload_write", { ...write, base64: "YQ==" })).data).toMatchObject({ code: "chunk_mismatch", nextIndex: 1, retryable: false });
  expect((await call(c, "upload_write", { ...write, index: 2 })).data).toMatchObject({ code: "chunk_index", nextIndex: 1, retryable: false });
  expect((await call(c, "upload_write", { ...write, index: 1, base64: "PC9odG1sPg==", final: true })).data).toMatchObject({ bytes: 13, complete: true });
  expect((await call(c, "upload_write", { ...write, index: 2 })).data).toMatchObject({ code: "file_finalized", nextIndex: 2, retryable: false });
  const result = await call(c, "publish", { upload_id });
  expect(result.error).toBe(false); expect(result.data.share.url).toBeTruthy();
  const file = await call(c, "export", { slug: result.data.slug, path: "empty.txt", version_id: upload_id });
  expect(file.error).toBe(false); expect(file.data.base64).toBe(""); expect(file.data.done).toBe(true);
  const { listUploadSessionsBefore } = await import("@/lib/db");
  expect((await listUploadSessionsBefore(Date.now() + 1)).some(s => s.targetSlug === upload_id)).toBe(false);
});

it("reuses one file draft when first-chunk requests race, without duplicating bytes", async () => {
  const c = await connect((await identity("retry-race")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: "PGh0bWw+", final: false };
  const attempts = await Promise.all([call(c, "upload_write", args), call(c, "upload_write", args)]);
  expect(attempts.some(a => !a.error)).toBe(true);
  expect((await call(c, "upload_write", { ...args, final: true })).error).toBe(false);
  const { listUploadSessionsBefore } = await import("@/lib/db");
  expect((await listUploadSessionsBefore(Date.now() + 1)).filter(s => s.targetSlug === upload_id)).toHaveLength(1);
  const site = await call(c, "publish", { upload_id, share: false });
  expect(site.error).toBe(false);
  const file = await call(c, "export", { slug: site.data.slug, version_id: upload_id, path: "index.html" });
  expect(Buffer.from(file.data.base64, "base64").toString()).toBe("<html>");
});

it("cleans project and chunk staging on non-conflict tree and ZIP commit failures", async () => {
  const c = await connect((await identity("failed-commit")).token);
  const { listUploadSessionsBefore } = await import("@/lib/db");
  for (const path of ["notes.txt", "broken.zip"]) {
    const upload_id = (await call(c, "upload_start")).data.versionId;
    expect((await call(c, "upload_write", { upload_id, path, index: 0, base64: "YQ==", final: true })).error).toBe(false);
    expect((await call(c, "publish", { upload_id, share: false })).error).toBe(true);
    expect((await listUploadSessionsBefore(Date.now() + 1)).filter(s => s.versionId === upload_id || s.targetSlug === upload_id)).toEqual([]);
  }
});

it("retries assembly after a failed final write instead of mistaking sealed chunks for a completed file", async () => {
  const c = await connect((await identity("assembly-failure")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: "PGh0bWw+", final: true };
  const { getStorage } = await import("@/lib/storage");
  const read = vi.spyOn(getStorage(), "read").mockRejectedValueOnce(new Error("temporary read failure"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try { expect((await call(c, "upload_write", args)).error).toBe(true); }
  finally { read.mockRestore(); log.mockRestore(); }
  expect((await call(c, "publish", { upload_id, share: false })).error).toBe(true);
  expect((await call(c, "upload_write", args)).error).toBe(false);
  expect((await call(c, "publish", { upload_id, share: false })).error).toBe(false);
});

it("safely re-registers the same file if writing its assembled marker fails after upload", async () => {
  const c = await connect((await identity("assembly-marker-failure")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: "PGh0bWw+", final: true };
  const db = await import("@/lib/db");
  const compare = db.compareUploadSessionFiles;
  const marker = vi.spyOn(db, "compareUploadSessionFiles").mockImplementation(async (id, before, after) => {
    if (after.some(f => f.relpath === "mcp-assembled")) return false;
    return compare(id, before, after);
  });
  try {
    expect((await call(c, "upload_write", args)).error).toBe(true);
    expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([{ relpath: "index.html", bytes: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  } finally { marker.mockRestore(); }
  expect((await call(c, "upload_write", args)).error).toBe(false);
  // upload_file -> recordUploadedFile upserts by relative path; retry is not an append.
  expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([{ relpath: "index.html", bytes: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  const site = await call(c, "publish", { upload_id, share: false });
  expect(site.error).toBe(false);
  const file = await call(c, "export", { slug: site.data.slug, path: "index.html", version_id: upload_id });
  expect(Buffer.from(file.data.base64, "base64").toString()).toBe("<html>");
});

it("exposes retryable upload conflicts and accepts the same final chunk after contention", async () => {
  const c = await connect((await identity("receipt-conflict")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: Buffer.from("<html>").toString("base64"), final: true };
  const db = await import("@/lib/db");
  const compare = db.compareUploadSessionFiles;
  const contention = vi.spyOn(db, "compareUploadSessionFiles").mockImplementation((id, before, after) => {
    if (id === upload_id && after.some(file => file.relpath === "index.html")) return Promise.resolve(false);
    return compare(id, before, after);
  });
  try {
    const result = await call(c, "upload_write", args);
    expect(result.error).toBe(true);
    expect(result.data).toMatchObject({ code: "upload_conflict", retryable: true });
    expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([]);
  } finally { contention.mockRestore(); }
  expect((await call(c, "upload_write", args)).error).toBe(false);
  expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([
    { relpath: "index.html", bytes: 6, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
  ]);
});

it("counts published files rather than chunks against maxFiles", async () => {
  const c = await connect((await identity("chunk-limits")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const previous = process.env.ARTIFACT_MAX_FILES;
  process.env.ARTIFACT_MAX_FILES = "1";
  try {
    for (let index = 0; index < 3; index++) {
      expect((await call(c, "upload_write", { upload_id, path: "index.html", index, base64: "YQ==", final: index === 2 })).error).toBe(false);
    }
    expect((await call(c, "publish", { upload_id, share: false })).error).toBe(false);
  } finally { if (previous === undefined) delete process.env.ARTIFACT_MAX_FILES; else process.env.ARTIFACT_MAX_FILES = previous; }
});
it("ignores search-only limits when listing my artifacts", async () => {
  const c = await connect((await identity("find-limit")).token);
  expect((await call(c, "find", { limit: 2 })).data).toMatchObject({ scope: "mine", owned: [], collaborating: [] });
});

it("bounds hot-path owner resolution and session reads per non-final chunk", async () => {
  const token = (await identity("hot-path")).token;
  const c = await connect(token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const sessions = await import("@/lib/upload-session");
  const db = await import("@/lib/db");
  const owner = vi.spyOn(sessions, "ownerKeyFor");
  const reads = vi.spyOn(db, "getUploadSessionRow");
  try {
    for (let index = 0; index < 2; index++) {
      owner.mockClear(); reads.mockClear();
      expect((await call(c, "upload_write", { upload_id, path: "index.html", index, base64: "YQ==", final: false })).error).toBe(false);
      expect(owner).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(3);
    }
  } finally { owner.mockRestore(); reads.mockRestore(); }
});
it("reports discarded oversized Office drafts and rejects private child IDs for cancellation", async () => {
  const c = await connect((await identity("office-cap")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  expect((await call(c, "upload_write", { upload_id, path: "report.doc", index: 0, base64: "YQ==", final: true })).error).toBe(false);
  const { listUploadSessionsBefore } = await import("@/lib/db");
  const child = (await listUploadSessionsBefore(Date.now() + 1)).find(s => s.targetSlug === upload_id)!;
  expect((await call(c, "upload_cancel", { upload_id: child.versionId })).error).toBe(true);
  const previous = process.env.ARTIFACT_INLINE_UPLOAD_MAX_BYTES;
  process.env.ARTIFACT_INLINE_UPLOAD_MAX_BYTES = "4096";
  try {
    const result = await call(c, "publish", { upload_id, share: false });
    expect(result.error).toBe(true); expect(result.data.error).toContain("upload has been discarded");
    expect((await listUploadSessionsBefore(Date.now() + 1)).some(s => s.versionId === upload_id || s.targetSlug === upload_id)).toBe(false);
  } finally { if (previous === undefined) delete process.env.ARTIFACT_INLINE_UPLOAD_MAX_BYTES; else process.env.ARTIFACT_INLINE_UPLOAD_MAX_BYTES = previous; }
});

it("bounds staging metadata independently of the project-file limit", async () => {
  const c = await connect((await identity("chunk-count-cap")).token);
  const upload_id = (await call(c, "upload_start")).data.versionId;
  const args = { upload_id, path: "index.html", index: 0, base64: "YQ==", final: false };
  expect((await call(c, "upload_write", args)).error).toBe(false);
  const { listUploadSessionsBefore, compareUploadSessionFiles } = await import("@/lib/db");
  const child = (await listUploadSessionsBefore(Date.now() + 1)).find(s => s.targetSlug === upload_id)!;
  expect(await compareUploadSessionFiles(child.versionId, child.files, Array.from({ length: 2000 }, (_, i) => ({ relpath: `${i}.part`, bytes: 1 })))).toBe(true);
  const result = await call(c, "upload_write", { ...args, index: 2000 });
  expect(result.error).toBe(true); expect(result.data.error).toContain("Too many chunks for one file");
  expect(result.data.error).not.toContain("Too many files");
});

it("forwards tenant and share context with existing MCP credentials", async () => {
  const owner = await identity("context-owner"), guest = await identity("context-guest");
  const ownerClient = await connect(owner.token), guestClient = await connect(guest.token);
  const {rbacQuery,getSiteBySlug,createId} = await import("@/lib/db");
  const account = (await call(ownerClient,"connection")).data.user;
  const tenant = createId("tenant");
  await rbacQuery("INSERT INTO tenants(id,name) VALUES($1,'MCP destination')",[tenant]);
  await rbacQuery("INSERT INTO tenant_members(tenant_id,user_id) VALUES($1,$2)",[tenant,account.id]);
  const published = await call(ownerClient,"publish",{html:"<html>Shared context</html>",share:false,tenant_id:tenant});
  expect(published.error).toBe(false); const slug=published.data.slug;
  expect((await getSiteBySlug(slug))!.tenantId).toBe(tenant);
  expect(published.data).not.toHaveProperty("editToken");
  const shared = await call(ownerClient,"share",{slug,policy:"login",mode:"edit"});
  expect(shared.error).toBe(false);
  const edit = await call(guestClient,"edit",{slug,share_token:shared.data.token,path:"index.html",content:"<html>Updated through share</html>",expected_version:(await getSiteBySlug(slug))!.currentVersionId});
  expect(edit.error).toBe(false);
  expect((await call(guestClient,"update",{slug,share_token:shared.data.token,title:"Not permitted"})).error).toBe(true);
  const emailAlias = await call(ownerClient,"share",{slug,policy:"email",mode:"view",versionId:edit.data.versionId});
  expect(emailAlias.error).toBe(false); expect(emailAlias.data.share.policy).toBe("people");
  expect(emailAlias.data.share.versionId).toBe(edit.data.versionId);
});

it("rejects further MCP chunks immediately after an editor is removed", async () => {
  const owner = await identity("chunk-owner"), editor = await identity("chunk-editor");
  const ca=await connect(owner.token), ce=await connect(editor.token);
  const slug=(await call(ca,"publish",{html:"<html>Original</html>",share:false})).data.slug;
  const {getSiteBySlug,rbacQuery}=await import("@/lib/db"); const site=(await getSiteBySlug(slug))!;
  const user=(await call(ce,"connection")).data.user;
  await putUserSiteRole(rbacQuery, site.id, user.id, 'editor', null);
  const upload_id=(await call(ce,"upload_start",{slug})).data.versionId;
  expect((await call(ce,"upload_write",{upload_id,path:"index.html",index:0,base64:"YQ==",final:false})).error).toBe(false);
  await rbacQuery("DELETE FROM role_bindings WHERE resource_site_id=$1 AND subject_user_id=$2",[site.id,user.id]);
  expect((await call(ce,"upload_write",{upload_id,path:"index.html",index:1,base64:"Yg==",final:false})).data.status).toBe(403);
  expect((await getSiteBySlug(slug))!.currentVersionId).toBe(site.currentVersionId);
});

it("manages the unique official designation through publish, update, set and clear", async () => {
  const a = await identity("official-owner"), b = await identity("official-other");
  const ca = await connect(a.token), cb = await connect(b.token);
  const created = await call(ca, "publish", { html: "<h1>Official one</h1>", official: true, share: false });
  expect(created.error).toBe(false);
  const { slug, versionId } = created.data;
  expect(created.data.officialVersionId).toBe(versionId);
  expect((await call(cb, "set_official", { slug, version_id: versionId })).error).toBe(true);
  const update = await call(ca, "update", { slug, html: "<h1>Official two</h1>", expected_version: versionId, official: true });
  expect(update.error).toBe(false);
  expect(update.data.officialVersionId).toBe(update.data.versionId);
  const info = await call(ca, "get_site", { slug });
  expect(info.data).not.toHaveProperty("versions");
  expect((await call(ca, "get_site", { slug, include: ["versions"] })).data.versions).toHaveLength(2);
  const set = await call(ca, "set_official", { slug, version_id: versionId, expected_revision: info.data.officialRevision });
  expect(set.error).toBe(false);
  expect(set.data.currentVersionId).toBe(update.data.versionId);
  expect((await call(ca, "set_official", { slug, version_id: update.data.versionId, expected_revision: info.data.officialRevision })).error).toBe(true);
  expect((await call(ca, "clear_official", { slug })).error).toBe(false);
  expect((await call(ca, "get_site", { slug })).data.officialVersionId).toBeNull();
});

it("recovers keyed publication and a completed upload after cleanup", async () => {
  const c = await connect((await identity("recovery-owner")).token);
  const operation_key = "mcp-recovery-create";
  const args = { html: "<h1>Recovery</h1>", share: false, operation_key };
  const first = await call(c, "publish", args); expect(first.error).toBe(false);
  expect((await call(c, "publish", args)).data).toEqual(first.data);
  expect((await call(c, "publish", { ...args, html: "different" })).error).toBe(true);
  expect((await call(c, "operation_status", { key: operation_key })).data.result).toEqual(first.data);
  const start = await call(c, "upload_start", { operation_key: "mcp-recovery-start" }); expect(start.error).toBe(false);
  const upload_id = start.data.versionId;
  expect((await call(c, "upload_start", { operation_key: "mcp-recovery-start" })).data.versionId).toBe(upload_id);
  await call(c, "upload_write", { upload_id, path: "index.html", index: 0, base64: Buffer.from("<h1>Uploaded recovery</h1>").toString("base64"), final: true });
  expect((await call(c, "upload_status", { upload_id })).data.files).toHaveLength(1);
  const commit = { upload_id, share: false, operation_key: "mcp-recovery-commit" };
  const published = await call(c, "publish", commit); expect(published.error).toBe(false);
  expect((await call(c, "publish", commit)).data).toEqual(published.data);
});

it("automatically moves an inline MCP tree to file uploads on a confirmed 413", async () => {
  const c = await connect((await identity("fallback-owner")).token);
  vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "500");
  try {
    const args = { html: `<h1>${"x".repeat(2000)}</h1>`, share: false, operation_key: "mcp-fallback-operation" };
    const result = await call(c, "publish", args); expect(result.error).toBe(false);
    expect(result.data.slug).toBeTruthy(); expect((await call(c, "publish", args)).data).toEqual(result.data);
  } finally { vi.unstubAllEnvs(); }
});

it("verifies the content hash before skipping a file during fallback recovery", async () => {
  const identity_ = await identity("hash-owner"); const c = await connect(identity_.token);
  const { getStorage } = await import("@/lib/storage");
  const { rbacQuery } = await import("@/lib/db");
  const { PUT } = await import("@/app/api/uploads/[versionId]/files/[...relpath]/route");
  vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "500");
  const measure = vi.spyOn(getStorage(), "measureVersion").mockRejectedValueOnce(new Error("temporary storage failure"));
  try {
    const args = { html: `<h1>${"x".repeat(2000)}</h1>`, share: false, operation_key: "mcp-hash-operation" };
    expect((await call(c, "publish", args)).error).toBe(true); measure.mockRestore();
    const [row] = await rbacQuery("SELECT version_id FROM upload_sessions ORDER BY created_at DESC LIMIT 1"); const versionId = String(row.version_id);
    await PUT(new Request(`${origin}/api/uploads/${versionId}/files/index.html`, { method: "PUT", headers: { authorization: `Bearer ${identity_.token}`, origin }, body: args.html.replaceAll("x", "y") }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
    const result = await call(c, "publish", args); expect(result.error).toBe(false);
    const exported = await call(c, "export", { slug: result.data.slug, path: "index.html", version_id: result.data.versionId });
    expect(Buffer.from(exported.data.base64, "base64").toString()).toBe(args.html);
  } finally { measure.mockRestore(); vi.unstubAllEnvs(); }
});

it.each(["html", "multipart"])("recovers %s fallback publication and update through the original key", async format => {
  const c = await connect((await identity(`fallback-${format}`)).token);
  const { rbacQuery } = await import("@/lib/db");
  const content = (text: string) => format === "html" ? { html: `<h1>${text.repeat(2000)}</h1>` } : { files: [
    { path: "index.html", content: `<h1>${text.repeat(2000)}</h1>`, encoding: "utf8" },
    { path: "asset.txt", content: text, encoding: "utf8" },
  ] };
  vi.stubEnv("ARTIFACT_INLINE_UPLOAD_MAX_BYTES", "500");
  try {
    const args = { ...content("a"), share: false, operation_key: `fallback-create-${format}` };
    const created = await call(c, "publish", args); expect(created.error).toBe(false);
    const { slug, versionId } = created.data;
    expect((await call(c, "operation_status", { key: args.operation_key })).data.result).toEqual(created.data);
    expect((await call(c, "publish", args)).data).toEqual(created.data);
    const update = { slug, ...content("b"), expected_version: versionId, operation_key: `fallback-update-${format}` };
    const updated = await call(c, "update", update); expect(updated.error).toBe(false);
    expect(updated.data.slug).toBe(slug); expect(updated.data.versionId).not.toBe(versionId);
    expect((await call(c, "operation_status", { key: update.operation_key })).data.result.versionId).toBe(updated.data.versionId);
    expect((await call(c, "update", update)).data.versionId).toBe(updated.data.versionId);
    expect(await rbacQuery("SELECT id FROM sites WHERE slug=$1", [slug])).toHaveLength(1);
    expect(await rbacQuery("SELECT id FROM versions WHERE site_id=(SELECT id FROM sites WHERE slug=$1)", [slug])).toHaveLength(2);
  } finally { vi.unstubAllEnvs(); }
});

it("reads isolated feedback and immutable evidence before an idempotent same-site revision", async () => {
  const { createComment, replyComment } = await import("@/lib/comments/service");
  const { rbacQuery } = await import("@/lib/db");
  const a = await identity("feedback-owner"), b = await identity("feedback-reader");
  const ca = await connect(a.token), cb = await connect(b.token);
  const created = await call(ca,"publish",{html:"<html><body>Original evidence</body></html>",share:false});
  const slug=created.data.slug;
  const info=(await call(ca,"get_site",{slug})).data;
  const original=info.version.id;
  const share=(await call(ca,"share",{slug,policy:"public",mode:"comment",versionId:original})).data;
  const second=(await call(ca,"share",{slug,policy:"public",mode:"comment",versionId:original})).data;
  const request = (token?:string) => new Request(`${origin}/api/comments`,{method:"POST",headers:{...a.headers,...(token?{"x-artifact-share":token}:{})}});
  const main=await createComment(request(),slug,{scope:{siteId:info.site.id,versionId:original,entry:{kind:"main"}},anchor:{schemaVersion:1,kind:"html",filePath:"index.html",selector:"body",quote:{exact:"Original evidence"},viewport:{width:1200,height:800}},body:"Correct the evidence",clientRequestId:crypto.randomUUID()});
  const { uploadCommentAttachment } = await import("@/lib/comments/attachments");
  const sharp = (await import("sharp")).default;
  const bytes=await sharp({create:{width:160,height:90,channels:3,background:"green"}}).png().toBuffer();
  const attachment=await uploadCommentAttachment(request(share.token),slug,{siteId:info.site.id,versionId:original,entry:{kind:"share",shareId:share.share.id}},new File([new Uint8Array(bytes)],"expected-design.png"));
  const shared=await createComment(request(share.token),slug,{scope:{siteId:info.site.id,versionId:original,entry:{kind:"share",shareId:share.share.id}},anchor:{schemaVersion:1,kind:"document",filePath:"index.html"},body:"Private link feedback",attachmentIds:[attachment.id],clientRequestId:crypto.randomUUID()});
  for(let i=0;i<32;i++) { __resetRateLimitForTests(); await replyComment(request(),slug,main.detail.thread.id,{body:`Reply ${i}`,clientRequestId:crypto.randomUUID()}); }
  __resetRateLimitForTests();
  const list=await call(ca,"comments_list",{slug});
  expect(list.error).toBe(false);expect(list.data.items).toHaveLength(1);
  expect(list.data.scope.versionId).toBe(original);expect(list.data.items[0].summary).toBe("Correct the evidence");
  const aggregate=await call(ca,"comments_list",{slug,aggregate:true,all_versions:true,limit:1});
  expect(aggregate.data.hasMore).toBe(true);
  const next=await call(ca,"comments_list",{slug,aggregate:true,all_versions:true,limit:1,cursor:aggregate.data.nextCursor});
  expect(next.data.items).toHaveLength(1);expect(next.data.items[0].threadId).not.toBe(aggregate.data.items[0].threadId);
  expect((await call(cb,"comments_list",{slug,share_token:share.token})).data.items[0].threadId).toBe(shared.detail.thread.id);
  expect((await call(cb,"comments_list",{slug,share_token:share.token,aggregate:true})).error).toBe(true);
  expect((await call(cb,"comment_read",{slug,thread_id:shared.detail.thread.id,share_token:second.token})).error).toBe(true);
  const context=await call(cb,"comment_context",{slug,thread_id:shared.detail.thread.id,share_token:share.token});
  expect(context.data.capabilities).toEqual({canExportSource:false,canEditContent:false});
  const detail=await call(ca,"comment_read",{slug,thread_id:main.detail.thread.id});
  expect(detail.data.messages.nextCursor).toBeTruthy();
  const rest=await call(ca,"comment_read",{slug,thread_id:main.detail.thread.id,cursor:detail.data.messages.nextCursor});
  expect(detail.data.messages.items.length+rest.data.items.length).toBe(33);expect(rest.data.nextCursor).toBeNull();
  expect(await rbacQuery("SELECT * FROM comment_read_scopes WHERE site_id=$1",[info.site.id])).toHaveLength(0);
  const nativeImage=await ca.callTool({name:"artifact_site_comment_image",arguments:{slug,attachment_id:attachment.id}});
  expect(nativeImage.isError).not.toBe(true);
  expect((nativeImage.content as {type:string}[])[1].type).toBe("image");
  const intermediate=await call(ca,"update",{slug,expected_version:original,html:"<html><body>Intervening change</body></html>"});
  expect(intermediate.error).toBe(false);
  const evidence=await call(ca,"read",{slug,version_id:original,file:"index.html"});expect(evidence.data.text).toContain("Original evidence");
  const manifest=await call(ca,"export",{slug,version_id:original});expect(manifest.data.versionId).toBe(original);
  expect((await call(ca,"export",{slug,version_id:original,path:"index.html"})).error).toBe(false);
  expect((await call(cb,"read",{slug,share_token:share.token,version_id:intermediate.data.versionId})).error).toBe(true);
  expect((await call(cb,"export",{slug,share_token:share.token,version_id:original})).error).toBe(true);
  const historical=await call(ca,"comment_context",{slug,thread_id:main.detail.thread.id});
  expect(historical.data.artifact).toMatchObject({originalVersionId:original,latestVersionId:intermediate.data.versionId});
  expect(historical.data.location.verification).toBe("not-checked");
  expect((await call(ca,"update",{slug,expected_version:original,html:"stale"})).error).toBe(true);
  const args={slug,expected_version:intermediate.data.versionId,html:"<html><body>Intervening change + fixed feedback</body></html>",operation_key:"feedback-same-site-update"};
  const updated=await call(ca,"update",args), replay=await call(ca,"update",args);
  expect(updated.error).toBe(false);expect(updated.data.slug).toBe(slug);expect(replay.data.versionId).toBe(updated.data.versionId);
  const threadId=shared.detail.thread.id;
  const revision=(await call(ca,"comment_read",{slug,thread_id:threadId})).data.thread.revision;
  expect((await call(cb,"comment_result",{slug,thread_id:threadId,version_id:updated.data.versionId,expected_revision:revision,share_token:share.token})).error).toBe(true);
  expect((await call(ca,"comment_result",{slug,thread_id:threadId,version_id:updated.data.versionId,expected_revision:revision})).error).toBe(false);
  const linked=(await call(ca,"comment_read",{slug,thread_id:threadId})).data;
  expect(linked.space.versionId).toBe(original);
  expect(linked.thread.resolution.status).toBe("open");
  expect(linked.thread.resultVersionId).toBe(updated.data.versionId);
  expect(linked.thread.resultAssociation.actorKind).toBe("agent");
  const audits=await rbacQuery("SELECT actor_id,reason FROM rbac_audit WHERE action='comment.result.associate' AND target_id=$1",[threadId]);
  expect(audits).toHaveLength(1);
  expect(audits[0].actor_id).toBe(linked.thread.resultAssociation.userId);
  expect(JSON.parse(audits[0].reason as string)).toMatchObject({versionId:updated.data.versionId,actorKind:"agent"});
  expect((await call(ca,"comment_result",{slug,thread_id:threadId,version_id:null,expected_revision:revision})).error).toBe(true);
  expect((await call(ca,"find")).data.owned).toHaveLength(1);
  expect((await call(cb,"comments_list",{slug,share_token:share.token})).data.scope.versionId).toBe(original);
  expect((await call(ca,"comment_read",{slug,thread_id:main.detail.thread.id})).data.thread.resolution.status).toBe("open");
});

it("runs CLI feedback -> historical read -> same-site update through real API handlers", async () => {
  const { run } = await import("../cli/src/cli");
  const { ArtifactSiteClient } = await import("../cli/src/client");
  const { callApi } = await import("@/lib/mcp/api");
  const { createComment, replyComment } = await import("@/lib/comments/service");
  const { writeFileSync } = await import("node:fs");
  const a=await identity("cli-feedback");const ca=await connect(a.token);
  const created=(await call(ca,"publish",{html:"<h1>Before feedback</h1>",share:false})).data;
  const { rbacQuery } = await import("@/lib/db");
  // Base64url slugs can begin with a dash; always exercise CLI option termination.
  const slug = "-cli-feedback";
  await rbacQuery("UPDATE sites SET slug=$1 WHERE slug=$2", [slug, created.slug]);
  const info=(await call(ca,"get_site",{slug})).data;
  const thread=await createComment(new Request(`${origin}/api/comments`,{method:"POST",headers:a.headers}),slug,{scope:{siteId:info.site.id,versionId:info.version.id,entry:{kind:"main"}},anchor:{schemaVersion:1,kind:"document",filePath:"index.html"},body:"Change the heading",clientRequestId:crypto.randomUUID()});
  for (let i = 0; i < 31; i++) {
    __resetRateLimitForTests();
    await replyComment(new Request(`${origin}/api/comments`, { method: "POST", headers: a.headers }), slug, thread.detail.thread.id, { body: `CLI reply ${i}`, clientRequestId: crypto.randomUUID() });
  }
  __resetRateLimitForTests();
  const output:string[]=[], errors:string[]=[];
  const file=join(dir,"revision.html");writeFileSync(file,"<h1>After feedback</h1>");
  const transport:typeof fetch=async(input,init)=>{
    const request=new Request(input,init), u=new URL(request.url), parts=u.pathname.split("/");
    const op=parts[2]==="operations" ? "operation_status" : parts[2]==="auth" ? "whoami" : parts[4]==="edit" ? "edit" : parts[4]==="text" ? "read" : parts[5]==="agent-list" ? "comments_list" : parts[6]==="agent-context" ? "comment_context" : parts[6]==="messages" ? "comment_messages" : parts[4]==="comments" ? "comment_read" : "get";
    try {const value=await callApi(request,op,{slug:parts[3],key:decodeURIComponent(parts[3]),threadId:parts[5],query:Object.fromEntries(u.searchParams),...(request.method==="POST"?{body:await request.json()}:{})});return Response.json(value);}
    catch(error){const e=error as {statusCode?:number;data?:unknown};return Response.json(e.data ?? {error:String(error)},{status:e.statusCode??500});}
  };
  vi.stubEnv("ARTIFACT_SITE_TOKEN",a.token);vi.stubEnv("ARTIFACT_SITE_CONFIG_DIR",join(dir,"cli-config"));
  const exec=(...args:string[])=>run(["--base",origin,"--json",...args],{out:l=>output.push(l),err:l=>errors.push(l),stdin:async()=>""},baseUrl=>new ArtifactSiteClient({baseUrl,token:a.token,fetch:transport,retries:0}));
  try {
    expect(await exec("comments","list","--",slug), errors.join("\n")).toBe(0);expect(JSON.parse(output.at(-1)!).items[0].threadId).toBe(thread.detail.thread.id);
    expect(await exec("comments","context","--",slug,thread.detail.thread.id), errors.join("\n")).toBe(0);expect(JSON.parse(output.at(-1)!).artifact.originalVersionId).toBe(info.version.id);
    expect(await exec("comments", "read", "--", slug, thread.detail.thread.id)).toBe(0);
    const firstPage = JSON.parse(output.at(-1)!).messages;
    expect(firstPage.nextCursor).toBeTruthy();
    expect(await exec("comments", "read", "--cursor", firstPage.nextCursor, "--", slug, thread.detail.thread.id)).toBe(0);
    const lastPage = JSON.parse(output.at(-1)!);
    expect(lastPage.nextCursor).toBeNull();
    // Replies can share a timestamp; their random IDs break ties, not insertion order.
    const messages = [...firstPage.items, ...lastPage.items] as { id: string; content: { body: string } }[];
    expect(messages).toHaveLength(32);
    expect(new Set(messages.map(message => message.id)).size).toBe(32);
    expect(messages.map(message => message.content.body).sort()).toEqual([
      "Change the heading", ...Array.from({ length: 31 }, (_, i) => `CLI reply ${i}`),
    ].sort());
    expect(await exec("read","--version-id",info.version.id,"--file","index.html","--",slug)).toBe(0);
    const args=["update","--expected-version",info.version.id,"--operation-key","cli-feedback-revision","--",slug,file];
    expect(await exec(...args),errors.join("\n")).toBe(0);const result=JSON.parse(output.at(-1)!);
    expect(result.slug).toBe(slug);expect(result.versionId).not.toBe(info.version.id);
    expect(await exec(...args),errors.join("\n")).toBe(0);expect(JSON.parse(output.at(-1)!).versionId).toBe(result.versionId);
    expect(await exec("update","--expected-version",info.version.id,"--operation-key","cli-feedback-conflict","--",slug,file)).toBe(4);
    expect((await call(ca,"find")).data.owned).toHaveLength(1);
    expect(await exec("read","--version-id",info.version.id,"--file","index.html","--",slug)).toBe(0);expect(JSON.parse(output.at(-1)!).text).toContain("Before feedback");
  } finally {vi.unstubAllEnvs();}
});

// Trust classification belongs to the tool boundary even if an API adds a same-named field.
it("keeps comment detail and continuation untrusted regardless of API labels", async () => {
  const api = await import("@/lib/mcp/api");
  const a = await identity("comment-trust");
  const client = await connect(a.token);
  const spy = vi.spyOn(api, "callApi").mockResolvedValue({ dataTrust: "trusted", items: [] });
  try {
    for (const cursor of [undefined, "next-page"]) {
      const result = await call(client, "comment_read", { slug: "site", thread_id: "thread", ...(cursor ? { cursor } : {}) });
      expect(result.error).toBe(false);
      expect(result.data.dataTrust).toBe("untrusted");
    }
  } finally { spy.mockRestore(); }
});

it("returns native comment image content and rechecks access on every MCP read", async () => {
  const a = await identity("image-owner"), b = await identity("image-reader");
  const ca = await connect(a.token), cb = await connect(b.token);
  const created = await call(ca, "publish", {html:"<p>Image feedback</p>",share:false});
  const { getSiteBySlug } = await import("@/lib/db");
  const { uploadCommentAttachment, discardCommentAttachment } = await import("@/lib/comments/attachments");
  const sharp = (await import("sharp")).default;
  const site = (await getSiteBySlug(created.data.slug))!;
  const request = new Request(`${origin}/api/comments`, {method:"POST",headers:a.headers});
  const bytes = await sharp({create:{width:1800,height:1200,channels:3,background:"red"}}).png().toBuffer();
  const image = await uploadCommentAttachment(request,site.slug,{siteId:site.id,versionId:site.currentVersionId,entry:{kind:"main"}},new File([new Uint8Array(bytes)],"feedback.png"));
  const args = {slug:site.slug,attachment_id:image.id};
  const result = await ca.callTool({name:"artifact_site_comment_image",arguments:args});
  expect(result.isError).not.toBe(true);
  const content = result.content as {type:string;data?:string;mimeType?:string;text?:string}[];
  expect(content[1]).toMatchObject({type:"image",mimeType:"image/png"});
  expect((await sharp(Buffer.from(content[1].data!,"base64")).metadata()).width).toBe(1568);
  expect(JSON.parse(content[0].text!)).toMatchObject({dataTrust:"untrusted",attachment:{id:image.id,width:1800,height:1200},image:{width:1568,height:1045,resized:true}});
  const smaller=await ca.callTool({name:"artifact_site_comment_image",arguments:{...args,max_edge:256}});
  expect(JSON.parse((smaller.content as {text:string}[])[0].text).image.width).toBe(256);
  expect((await call(ca,"comment_image",{...args,max_edge:8192})).error).toBe(true);
  expect((await call(cb,"comment_image",args)).error).toBe(true);
  await discardCommentAttachment(request,site.slug,image.id);
  expect((await call(ca,"comment_image",args)).error).toBe(true);
  const {createComment}=await import("@/lib/comments/service");
  const {revokeShare}=await import("@/lib/db");
  const share=(await call(ca,"share",{slug:site.slug,policy:"public",mode:"comment"})).data;
  const other=(await call(ca,"share",{slug:site.slug,policy:"public",mode:"comment"})).data;
  const scoped=new Request(request.url,{method:"POST",headers:{...a.headers,"x-artifact-share":share.token}});
  const scope={siteId:site.id,versionId:site.currentVersionId,entry:{kind:"share" as const,shareId:share.share.id}};
  const attached=await uploadCommentAttachment(scoped,site.slug,scope,new File([new Uint8Array(bytes)],"shared.png"));
  await createComment(scoped,site.slug,{scope,anchor:{kind:"document",schemaVersion:1,filePath:"index.html"},body:"Screenshot",attachmentIds:[attached.id],clientRequestId:crypto.randomUUID()});
  const sharedArgs={slug:site.slug,attachment_id:attached.id,share_token:share.token};
  expect((await call(cb,"comment_image",sharedArgs)).error).toBe(false);
  expect((await call(cb,"comment_image",{...sharedArgs,share_token:other.token})).error).toBe(true);
  await revokeShare(share.share.id);
  expect((await call(cb,"comment_image",sharedArgs)).error).toBe(true);

});

it("lists personal folders and moves artifacts without changing sharing", async () => {
  const { POST: createFolder } = await import("@/app/api/me/folders/route");
  const { getSiteBySlug } = await import("@/lib/db");
  const a = await identity("folders-a"), b = await identity("folders-b");
  const ca = await connect(a.token), cb = await connect(b.token);
  const folder = (await (await createFolder(new Request(`${origin}/api/me/folders`, {
    method: "POST", headers: a.headers, body: JSON.stringify({ name: "Reports" }),
  }))).json()).folder;
  expect((await call(ca, "folders")).data.folders).toEqual([expect.objectContaining({ id: folder.id, name: "Reports" })]);
  expect((await call(cb, "folders")).data.folders).toEqual([]);
  const site = (await call(ca, "publish", { html: "<html>Filed report</html>", share: false })).data;
  const foreignFolder = (await (await createFolder(new Request(`${origin}/api/me/folders`, {
    method: "POST", headers: b.headers, body: JSON.stringify({ name: "Other reports" }),
  }))).json()).folder;
  expect((await call(ca, "move", { slug: site.slug, folder_id: foreignFolder.id })).error).toBe(true);
  const before = await getSiteBySlug(site.slug);
  expect((await call(cb, "move", { slug: site.slug, folder_id: folder.id })).error).toBe(true);
  expect((await call(ca, "move", { slug: site.slug, folder_id: "missing" })).error).toBe(true);
  for (let i = 0; i < 2; i++) expect((await call(ca, "move", { slug: site.slug, folder_id: folder.id })).data).toMatchObject({ ok: true, slug: site.slug, folderId: folder.id });
  expect(await getSiteBySlug(site.slug)).toEqual(before);
  expect((await call(ca, "move", { slug: site.slug, folder_id: null })).data.folderId).toBeNull();
  process.env.PUBLISH_API_TOKEN = "folder-operator";
  const operator = await connect("folder-operator");
  expect((await call(operator, "folders")).error).toBe(true);
  expect((await call(operator, "move", { slug: site.slug, folder_id: folder.id })).error).toBe(true);
});

it("keeps CLI, MCP and HTTP personal folders and public lookup consistent", async () => {
  const { run } = await import("../cli/src/cli");
  const { ArtifactSiteClient } = await import("../cli/src/client");
  const { callApi } = await import("@/lib/mcp/api");
  const { POST: createFolder, GET: listFolders } = await import("@/app/api/me/folders/route");
  const { updateSiteVisibility } = await import("@/lib/db");
  const a = await identity("cli-library"), b = await identity("other-library");
  const ca = await connect(a.token), cb = await connect(b.token);
  const folder = (await (await createFolder(new Request(`${origin}/api/me/folders`, { method: "POST", headers: a.headers, body: JSON.stringify({ name: "Reports" }) }))).json()).folder;
  const site = (await call(ca, "publish", { html: "<h1>Library report</h1>", share: false })).data;
  const { getSiteBySlug } = await import("@/lib/db");
  await updateSiteVisibility((await getSiteBySlug(site.slug))!.id, "public");
  expect((await call(cb, "find")).data).toMatchObject({ scope: "mine", owned: [], collaborating: [] });
  expect((await call(cb, "find", { scope: "public" })).data).toMatchObject({ scope: "public", sites: [expect.objectContaining({ slug: site.slug })] });
  expect((await call(cb, "find", { scope: "public", query: "report" })).error).toBe(true);
  const output: string[] = [], errors: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init), u = new URL(request.url);
    const op = u.pathname.endsWith("/assignments") ? "move" : u.pathname.endsWith("/folders") ? "folders" : u.pathname === "/api/sites" ? "public_list" : u.pathname === "/api/me/sites" ? "list" : "whoami";
    try { return Response.json(await callApi(request, op, { ...(request.method === "PUT" ? { body: await request.json() } : {}) })); }
    catch (error) { const e = error as { statusCode?: number; data?: unknown }; return Response.json(e.data ?? { error: String(error) }, { status: e.statusCode ?? 500 }); }
  };
  vi.stubEnv("ARTIFACT_SITE_TOKEN", a.token); vi.stubEnv("ARTIFACT_SITE_CONFIG_DIR", join(dir, "cli-library-config"));
  const exec = (...args: string[]) => run(["--base", origin, "--json", ...args], { out: l => output.push(l), err: l => errors.push(l), stdin: async () => "" }, (baseUrl, token) => new ArtifactSiteClient({ baseUrl, token, fetch: transport, retries: 0 }));
  try {
    expect(await exec("folders", "list")).toBe(0);
    expect(JSON.parse(output.at(-1)!)).toEqual((await call(ca, "folders")).data);
    expect(await exec("move", site.slug, "--folder", folder.id)).toBe(0);
    const state = await (await listFolders(new Request(`${origin}/api/me/folders`, { headers: a.headers }))).json();
    expect(state.assign[site.slug]).toBe(folder.id);
    expect(await exec("move", site.slug, "--folder", "missing")).toBe(1);
    expect(await exec("move", site.slug, "--unfiled")).toBe(0);
    expect(JSON.parse(output.at(-1)!).folderId).toBeNull();
    expect(await exec("find", "--public")).toBe(0); expect(JSON.parse(output.at(-1)!).scope).toBe("public");
    process.env.PUBLISH_API_TOKEN = "library-operator"; vi.stubEnv("ARTIFACT_SITE_TOKEN", "library-operator");
    expect(await exec("whoami")).toBe(0); expect(JSON.parse(output.at(-1)!)).toMatchObject({ operator: true, tokenStatus: "operator", user: null });
    expect(await exec("folders", "list")).toBe(3);
    expect(await exec("find")).toBe(3);
  } finally { vi.unstubAllEnvs(); }
});
