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
  expect(exported.data.downloadUrl).toBe(`https://public.example/api/sites/${created.data.slug}/export`);
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
    expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([{ relpath: "index.html", bytes: 6 }]);
  } finally { marker.mockRestore(); }
  expect((await call(c, "upload_write", args)).error).toBe(false);
  // upload_file -> recordUploadedFile upserts by relative path; retry is not an append.
  expect((await db.getUploadSessionRow(upload_id))?.files).toEqual([{ relpath: "index.html", bytes: 6 }]);
  const site = await call(c, "publish", { upload_id, share: false });
  expect(site.error).toBe(false);
  const file = await call(c, "export", { slug: site.data.slug, path: "index.html", version_id: upload_id });
  expect(Buffer.from(file.data.base64, "base64").toString()).toBe("<html>");
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
      expect(reads).toHaveBeenCalledTimes(2);
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
  const { listUploadSessionsBefore, setUploadSessionFiles } = await import("@/lib/db");
  const child = (await listUploadSessionsBefore(Date.now() + 1)).find(s => s.targetSlug === upload_id)!;
  await setUploadSessionFiles(child.versionId, Array.from({ length: 2000 }, (_, i) => ({ relpath: `${i}.part`, bytes: 1 })));
  const result = await call(c, "upload_write", { ...args, index: 2000 });
  expect(result.error).toBe(true); expect(result.data.error).toContain("Too many chunks for one file");
  expect(result.data.error).not.toContain("Too many files");
});
