// The typed client against the fake server: every route it calls, the error shapes it must
// understand, and the retry it promises.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, ArtifactSiteClient } from "../src/client.js";
import { startFakeServer, type FakeServer } from "./fake-server.js";

let server: FakeServer;
let client: ArtifactSiteClient;
const noSleep = async () => {};

beforeAll(async () => {
  server = await startFakeServer();
  client = new ArtifactSiteClient({ baseUrl: server.url + "/", token: server.token(), sleep: noSleep });
});
afterAll(() => server.close());

describe("ArtifactSiteClient", () => {
  it("normalises the base URL and builds absolute links from API-relative ones", () => {
    expect(client.baseUrl).toBe(server.url);
    expect(client.absolute("/s/abc")).toBe(`${server.url}/s/abc`);
    expect(client.absolute("https://elsewhere/v/x")).toBe("https://elsewhere/v/x");
  });

  it("sends the bearer token on every request", async () => {
    await client.me();
    const last = server.state.requests.at(-1)!;
    expect(last.auth).toMatch(/^Bearer ahp_/);
  });

  it("creates a paste site, reads it back, lists versions", async () => {
    const created = await client.createPaste("<html><head></head><body>hi</body></html>", "Hello");
    expect(created.kind).toBe("single");
    expect(created.url).toBe(`/s/${created.slug}`);
    const info = await client.getSite(created.slug);
    expect(info.title).toBe("Hello");
    expect(info.files).toEqual(["index.html"]);
    const versions = await client.listVersions(created.slug);
    expect(versions.versions).toHaveLength(1);
    expect(versions.currentVersionId).toBe(info.version.id);
  });

  it("creates a document site from bytes via multipart (byte-clean)", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0xfe]);
    const created = await client.createFile("report.pdf", bytes, undefined);
    expect(created.kind).toBe("document");
    expect(created.title).toBe("report");
    const stored = server.state.sites.get(created.slug)!.versions[0].files["report.pdf"];
    expect([...stored]).toEqual([...bytes]);
  });

  it("edit honours expected_version and surfaces the 409 with the winning version id", async () => {
    const created = await client.createPaste("<html><head></head><body>v1</body></html>");
    const v1 = (await client.listVersions(created.slug)).currentVersionId;
    const v2 = await client.edit(created.slug, { content: "<html><head></head><body>v2</body></html>" }, v1);
    expect(v2.versionId).not.toBe(v1);
    const stale = client.edit(created.slug, { content: "<html><head></head><body>v3</body></html>" }, v1);
    await expect(stale).rejects.toBeInstanceOf(ApiError);
    const err = (await stale.catch((e: unknown) => e)) as ApiError;
    expect(err.status).toBe(409);
    expect(err.currentVersionId).toBe(v2.versionId);
  });

  it("export returns the zip plus the version header, and rollback mints a new version", async () => {
    const created = await client.createZip(zipOf({ "index.html": "<html><head></head><body>a</body></html>", "a.css": "body{}" }), "Tree");
    expect(created.kind).toBe("folder");
    const { zip, versionId } = await client.export(created.slug);
    expect(versionId).toBe((await client.listVersions(created.slug)).currentVersionId);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["a.css", "index.html"]);
    const first = versionId!;
    await client.edit(created.slug, { path: "a.css", content: "body{color:red}" });
    const back = await client.rollback(created.slug, first);
    expect(back.versionId).not.toBe(first);
    expect((await client.listVersions(created.slug)).versions).toHaveLength(3);
  });

  it("streams a file into a chunked upload session and commits it", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ah-client-"));
    const file = path.join(dir, "index.html");
    await writeFile(file, "<html><head></head><body>streamed</body></html>");
    const { versionId } = await client.openUpload({ title: "Streamed" });
    const put = await client.uploadFile(versionId, "index.html", file);
    expect(put).toEqual({ relpath: "index.html", bytes: 47 });
    const committed = await client.commitUpload(versionId);
    expect(committed.title).toBe("Streamed");
    expect(committed.versionId).toBe(versionId);
  });

  it("shares: policy is sent explicitly and a generated passcode comes back", async () => {
    const created = await client.createPaste("<html><head></head><body>s</body></html>");
    const pub = await client.createShare(created.slug, { policy: "public" });
    expect(pub.url).toBe(`${server.url}/v/${pub.token}`);
    expect(pub.share.policy).toBe("public");
    const code = await client.createShare(created.slug, { policy: "passcode" });
    expect(code.passcode).toBe("123456");
    await expect(client.createShare(created.slug, { policy: "public", passcode: "x" })).rejects.toMatchObject({ status: 400 });
  });

  it("rename, delete, my sites", async () => {
    const created = await client.createPaste("<html><head></head><body>m</body></html>", "Mine");
    expect((await client.rename(created.slug, "Renamed")).title).toBe("Renamed");
    expect((await client.mySites()).owned.some((s) => s.slug === created.slug && s.title === "Renamed")).toBe(true);
    expect(await client.delete(created.slug)).toEqual({ deleted: true, slug: created.slug });
    await expect(client.getSite(created.slug)).rejects.toMatchObject({ status: 404, message: "site not found" });
  });

  it("retries 429 with backoff and gives up after the configured attempts", async () => {
    server.state.rateLimitNext = 2;
    const me = await client.me(); // two 429s, then success
    expect(me.user?.email).toBe("user@example.com");
    server.state.rateLimitNext = 10;
    const strict = new ArtifactSiteClient({ baseUrl: server.url, token: server.token(), retries: 1, sleep: noSleep });
    await expect(strict.me()).rejects.toMatchObject({ status: 429, message: "rate limited" });
    server.state.rateLimitNext = 0;
  });

  it("an unauthenticated client is refused where identity is required", async () => {
    const anon = new ArtifactSiteClient({ baseUrl: server.url, sleep: noSleep });
    expect(anon.authenticated).toBe(false);
    await expect(anon.mySites()).rejects.toMatchObject({ status: 401 });
  });

  it("reads the served skill", async () => {
    expect(await client.skill()).toContain("**Base URL**");
  });
});

function zipOf(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])));
}

it("passes the optimistic version to chunked commit", async () => {
  let requested = "";
  const c = new ArtifactSiteClient({ baseUrl: "https://example.test", token: "test", fetch: async (input) => { requested = String(input); return Response.json({ versionId: "ver_new" }); } });
  await c.commitUpload("ver_upload", undefined, "ver_expected");
  expect(new URL(requested).searchParams.get("expected_version")).toBe("ver_expected");
});


it.each(["__Host-ah_anon", "ah_anon"])("preserves the server-issued %s identity for upload requests", async (cookieName) => {
  const cookies: (string | null)[] = [];
  const c = new ArtifactSiteClient({ baseUrl: "https://example.test", token: "operator", fetch: async (_input, init) => {
    cookies.push(new Headers(init?.headers).get("cookie"));
    const headers = new Headers();
    headers.append("set-cookie", `${cookieName}=anon_test; Path=/; Secure; HttpOnly`);
    headers.append("set-cookie", "session=do-not-store; Path=/; Secure");
    return Response.json({ versionId: "ver_test" }, { headers });
  } });
  await c.openUpload({});
  await c.uploadBytes("ver_test", "index.html", new TextEncoder().encode("hello"));
  await c.commitUpload("ver_test");
  expect(cookies).toEqual([null, `${cookieName}=anon_test`, `${cookieName}=anon_test`]);
});

it("preserves bearer identity while forwarding tenant and share context", async () => {
  const seen: Headers[] = [];
  const c = new ArtifactSiteClient({baseUrl:"https://context.example",token:"existing-token",tenantId:"tenant-a",shareToken:"shared-report",fetch:async (_url,init)=>{
    seen.push(new Headers(init?.headers));return Response.json({});
  }});
  await c.getSite("report");
  await c.createShare("report",{policy:"people",mode:"view",versionId:"version-a"});
  for(const h of seen){
    expect(h.get("authorization")).toBe("Bearer existing-token");
    expect(h.get("x-artifact-tenant")).toBe("tenant-a");
    expect(h.get("x-artifact-share")).toBe("shared-report");
  }
});

it("does not retry an unsafe write after a 5xx response", async () => {
  let calls = 0;
  const c = new ArtifactSiteClient({ baseUrl: "http://test.local", token: "secret", fetch: async () => { calls++; return Response.json({ error: "unavailable" }, { status: 503 }); }, sleep: async () => {} });
  await expect(c.createPaste("<h1>No duplicate</h1>")).rejects.toMatchObject({ status: 503 });
  expect(calls).toBe(1);
});
it("reopens a streamed file for each safe retry", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "upload-retry-")); const file = path.join(dir, "index.html"); await writeFile(file, "retry bytes");
  const bodies: string[] = [];
  const c = new ArtifactSiteClient({ baseUrl: "http://test.local", fetch: async (url, init) => {
    bodies.push(await new Request(url, init).text());
    return bodies.length === 1 ? Response.json({ error: "busy" }, { status: 503 }) : Response.json({ relpath: "index.html", bytes: 11 });
  }, sleep: async () => {} });
  await c.uploadFile("ver_retry", "index.html", file);
  expect(bodies).toEqual(["retry bytes", "retry bytes"]);
});

it("shares one identity request across concurrent and repeated publication preflights", async () => {
  let requests = 0;
  const uploadLimits = { maxBytes: 1000, maxFileBytes: 900, maxFiles: 50 };
  const c = new ArtifactSiteClient({ baseUrl: "http://test.invalid", token: "test", fetch: async () => {
    requests++; return Response.json({ user: { id: "owner" }, oidcEnabled: false, uploadLimits });
  } });
  const [limits, identity] = await Promise.all([c.uploadLimits(), c.recoveryIdentity()]);
  expect(limits).toEqual(uploadLimits); expect(identity).toBeTruthy();
  await c.uploadLimits(); await c.recoveryIdentity(); expect(requests).toBe(1);
  await c.me(); expect(requests).toBe(2); // Explicit identity checks remain live.
  c.setContext({ tenantId: "other-tenant" });
  expect(await c.recoveryIdentity()).not.toBe(identity); expect(requests).toBe(3);
});

it("retries identity lookup after a failed shared preflight", async () => {
  let requests = 0;
  const c = new ArtifactSiteClient({ baseUrl: "http://test.invalid", token: "test", retries: 0, fetch: async () => {
    requests++;
    return requests === 1 ? Response.json({ error: "temporarily unavailable" }, { status: 503 }) : Response.json({ user: { id: "owner" }, oidcEnabled: false });
  } });
  const failed = await Promise.allSettled([c.uploadLimits(), c.recoveryIdentity()]);
  expect(failed.map(result => result.status)).toEqual(["rejected", "rejected"]); expect(requests).toBe(1);
  await c.recoveryIdentity(); await c.uploadLimits(); expect(requests).toBe(2);
});
