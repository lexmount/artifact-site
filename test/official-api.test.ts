import { describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/ratelimit";
import { createId, getSite, rbacQuery, upsertUser, createShare, listAudit } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { setOfficialVersion } from "@/lib/official-version";
import { apiAuditContext, auditRow } from "@/lib/audit";
import { commitAuthorizedVersion } from "@/lib/authorized-commit";
import { GET as siteInfo } from "@/app/api/sites/[slug]/route";
import { mintSession } from "@/lib/session";
import { hashToken, canReadVersion } from "@/lib/share";
import { GET, PUT, DELETE } from "@/app/api/sites/[slug]/official/route";
import { POST as replace } from "@/app/api/sites/[slug]/versions/route";
import { POST as edit } from "@/app/api/sites/[slug]/edit/route";
import { GET as editFrame } from "@/app/api/sites/[slug]/edit-frame/route";
import { readScopedPreviewKey } from "@/lib/preview-key";
import { GET as exportZip } from "@/app/api/sites/[slug]/export/route";
import { POST as openUpload } from "@/app/api/uploads/route";
import { PUT as uploadFile } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { POST as commitUpload } from "@/app/api/uploads/[versionId]/commit/route";
import { committed, folderFiles, testAudit } from "./helpers";
import { unzipSync, strFromU8 } from "fflate";

const origin = "https://official.example";
const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
async function identity() {
  const user = await upsertUser({ authProvider: "official", providerSubject: createId("subject") });
  const { cookie } = await mintSession(new Request(origin), user.id);
  return { user, cookie: cookie.split(";")[0] };
}
function req(cookie: string, method = "GET", body?: unknown, query = "", extra: Record<string, string> = {}) {
  return new Request(origin + "/api/test" + query, { method, headers: { cookie, origin, "content-type": "application/json", ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function setup() {
  const owner = await identity();
  const result = await createSite({ mode: "paste", html: "<h1>First</h1>" }, { ownerId: owner.user.id }, testAudit());
  return { ...result, ...owner };
}
describe("official API authorization and publication", () => {
  it("rejects request-less designation and authorized commits before writing", async () => {
    const a = await setup();
    // @ts-expect-error Request-less designation must also be rejected at the type boundary.
    await expect(setOfficialVersion(a.site.id, a.version.id, testAudit())).rejects.toThrow("authorizationRequest is required");
    const id = createId("ver");
    await expect(commitAuthorizedVersion(a.site.id, { id, siteId: a.site.id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload", official: true }, auditRow(testAudit(), a.site.id, id, "edit"))).rejects.toThrow("authorizationRequest is required");
    expect((await getSite(a.site.id))!.officialVersionId).toBeNull();
    expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [id])).toEqual([]);
  });
  it("rate-limits repeated official metadata reads", async () => {
    const a = await setup();
    vi.stubEnv("ARTIFACT_RATE_LIMIT", "on");
    vi.stubEnv("ARTIFACT_RATE_LIMIT_BURST", "1");
    vi.stubEnv("ARTIFACT_RATE_LIMIT_PER_MIN", "1");
    __resetRateLimitForTests();
    try {
      expect((await GET(req(a.cookie), params(a.site.slug))).status).toBe(200);
      expect((await GET(req(a.cookie), params(a.site.slug))).status).toBe(429);
    } finally { vi.unstubAllEnvs(); __resetRateLimitForTests(); }
  });
  it("rechecks official management after ownership changes and keeps failed uploads atomic", async () => {
    const a = await setup(), next = await identity();
    const ctx = apiAuditContext(req(a.cookie, "PUT"), { kind: "user", userId: a.user.id, anonId: null });
    await rbacQuery("UPDATE sites SET owner_id=$1 WHERE id=$2", [next.user.id, a.site.id]);
    await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'editor',1)", [a.site.id, a.user.id]);
    await expect(setOfficialVersion(a.site.id, a.version.id, ctx)).rejects.toThrow();
    const id = createId("ver");
    await expect(commitAuthorizedVersion(a.site.id, { id, siteId: a.site.id, entry: "index.html", fileCount: 1, byteSize: 1, source: "upload", official: true }, auditRow(ctx, a.site.id, id, "edit"))).rejects.toThrow();
    expect((await getSite(a.site.id))!.officialVersionId).toBeNull();
    expect((await getSite(a.site.id))!.currentVersionId).toBe(a.version.id);
    expect(await rbacQuery("SELECT id FROM versions WHERE id=$1", [id])).toEqual([]);
    expect((await listAudit(a.site.id)).filter(row => row.action === "official.set")).toEqual([]);
  });
  it("reads the selected historical source through the current read authorization path", async () => {
    const a = await setup();
    await editSite(a.site.slug, { content: "new source" }, testAudit());
    const response = await siteInfo(req(a.cookie, "GET", undefined, `?version=${a.version.id}`), params(a.site.slug));
    expect(response.status).toBe(200);
    expect((await response.json()).content).toContain("First");
  });
  it("requires management, rejects cross-site writes and does not disclose setter credentials", async () => {
    const a = await setup(), editor = await identity();
    await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'editor',$3)", [a.site.id, editor.user.id, Date.now()]);
    expect((await PUT(req(editor.cookie, "PUT", { versionId: a.version.id }), params(a.site.slug))).status).toBe(403);
    expect((await PUT(req(a.cookie, "PUT", { versionId: a.version.id }, "", { origin: "https://attacker.example" }), params(a.site.slug))).status).toBe(401);
    expect((await PUT(req(a.cookie, "PUT", { versionId: a.version.id }, "", { origin: "https://attacker.example", "x-edit-token": "unverified-token" }), params(a.site.slug))).status).toBe(401);
    const result = await PUT(req(a.cookie, "PUT", { versionId: a.version.id, expectedRevision: 0 }), params(a.site.slug));
    expect(result.status).toBe(200);
    expect(JSON.stringify(await (await GET(req(a.cookie), params(a.site.slug))).json())).not.toContain('"officialSetBy":');
    expect((await DELETE(req(editor.cookie, "DELETE", {}), params(a.site.slug))).status).toBe(403);
  });
  it("discloses setter names only to managers, including on public sites", async () => {
    const a = await setup();
    await rbacQuery("UPDATE users SET display_name=$1 WHERE id=$2", ["Official manager", a.user.id]);
    await PUT(req(a.cookie, "PUT", { versionId: a.version.id }), params(a.site.slug));
    await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1", [a.site.id]);
    const manager = await (await GET(req(a.cookie), params(a.site.slug))).json();
    expect(manager.officialSetByName).toBe("Official manager");
    const reader = await (await GET(req(""), params(a.site.slug))).json();
    expect(reader.officialVersionId).toBe(a.version.id);
    expect(reader).not.toHaveProperty("officialSetByName");
  });
  it("allows a site administrator to designate and clear", async () => {
    const a = await setup(), admin = await identity();
    await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'admin',$3)", [a.site.id, admin.user.id, Date.now()]);
    expect((await PUT(req(admin.cookie, "PUT", { versionId: a.version.id }), params(a.site.slug))).status).toBe(200);
    expect((await DELETE(req(admin.cookie, "DELETE", {}), params(a.site.slug))).status).toBe(200);
  });
  it("makes exactly one concurrent designation succeed for an observed revision", async () => {
    const a = await setup();
    const b = committed(await editSite(a.site.slug, { content: "second" }, testAudit()));
    const results = await Promise.all([a.version.id, b.version.id].map(versionId => PUT(req(a.cookie, "PUT", { versionId, expectedRevision: 0 }), params(a.site.slug))));
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await getSite(a.site.id))!.officialRevision).toBe(1);
  });
  it("designates an uploaded replacement atomically and rejects editors or stale writes", async () => {
    const a = await setup(), editor = await identity();
    await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_at) VALUES($1,$2,'editor',$3)", [a.site.id, editor.user.id, Date.now()]);
    const body = { mode: "paste", html: "<h1>Second</h1>", official: true };
    expect((await replace(req(editor.cookie, "POST", body), params(a.site.slug))).status).toBe(403);
    const response = await replace(req(a.cookie, "POST", body, `?expected_version=${a.version.id}`), params(a.site.slug));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.officialVersionId).toBe(result.versionId);
    expect((await replace(req(a.cookie, "POST", body, `?expected_version=${a.version.id}`), params(a.site.slug))).status).toBe(409);
    expect((await getSite(a.site.id))!.officialVersionId).toBe(result.versionId);
    expect((await listAudit(a.site.id)).filter(a => a.action === "official.set")).toHaveLength(1);
  });
  it("keeps fixed share grants bounded and gives ordinary readers access to the formal snapshot", async () => {
    const a = await setup();
    const b = committed(await editSite(a.site.slug, { content: "second" }, testAudit()));
    await PUT(req(a.cookie, "PUT", { versionId: a.version.id }), params(a.site.slug));
    await rbacQuery("UPDATE sites SET visibility='public' WHERE id=$1", [a.site.id]);
    const site = (await getSite(a.site.id))!;
    expect(await canReadVersion(req(""), site, a.version.id)).toBe(true);
    const token = createId("token");
    await createShare({ id: createId("share"), siteId: site.id, tokenHash: hashToken(token), policy: "public", mode: "view", versionId: b.version.id, passcodeHash: null, label: null, createdBy: a.user.id, createdAnonId: null, expiresAt: null });
    const fixed = req("", "GET", undefined, "", { "x-artifact-share": token });
    expect(await canReadVersion(fixed, site, a.version.id)).toBe(false);
    const info = await (await GET(fixed, params(site.slug))).json();
    expect(info.officialVersionId).toBeNull();
    expect(info.versions.map((v: { id: string }) => v.id)).toEqual([b.version.id]);
  });
  it("uses the selected historical tree for edits and exports, preserving unedited files", async () => {
    const owner = await identity();
    const a = await createSite({ mode: "folder", files: folderFiles({ "index.html": "first", "a.txt": "original" }) }, { ownerId: owner.user.id });
    const b = committed(await editSite(a.site.slug, { path: "a.txt", content: "latest" }, testAudit()));
    const response = await edit(req(owner.cookie, "POST", { path: "index.html", content: "third", baseVersionId: a.version.id }, `?expected_version=${b.version.id}`), params(a.site.slug));
    expect(response.status).toBe(200);
    const zip = await exportZip(req(owner.cookie, "GET", undefined, `?version=${a.version.id}`), params(a.site.slug));
    expect(zip.headers.get("x-artifact-version")).toBe(a.version.id);
    expect(strFromU8(unzipSync(new Uint8Array(await zip.arrayBuffer()))["index.html"])).toBe("first");
    const latest = await exportZip(req(owner.cookie), params(a.site.slug));
    const files = unzipSync(new Uint8Array(await latest.arrayBuffer()));
    expect(strFromU8(files["a.txt"])).toBe("original");
    expect(strFromU8(files["index.html"])).toBe("third");
  });
  it("pins visual editor resources to its historical source snapshot", async () => {
    const owner = await identity();
    const a = await createSite({ mode: "folder", files: folderFiles({ "index.html": "<html><head><link rel=stylesheet href=style.css></head><body>First</body></html>", "style.css": "body { color: red }" }) }, { ownerId: owner.user.id });
    await editSite(a.site.slug, { path: "style.css", content: "body { color: blue }" }, testAudit());
    const frame = await editFrame(req(owner.cookie, "GET", undefined, `?version=${a.version.id}`), params(a.site.slug));
    expect(frame.status).toBe(200);
    const key = (await frame.text()).match(/<base href="[^"~]+~([^/]+)\//)?.[1];
    expect(key).toBeTruthy();
    expect((await readScopedPreviewKey(key!, a.site))?.versionId).toBe(a.version.id);
  });
  it.each([true, undefined])("commits chunked uploads with optional official flag %s", async (official) => {
    const owner = await identity();
    const opened = await openUpload(req(owner.cookie, "POST", { title: "Chunked" }));
    expect(opened.status).toBe(201);
    const { versionId } = await opened.json();
    const put = await uploadFile(new Request(origin + "/api/upload", { method: "PUT", headers: { cookie: owner.cookie, origin }, body: "<h1>Chunked</h1>" }), { params: Promise.resolve({ versionId, relpath: ["index.html"] }) });
    expect(put.status).toBe(200);
    const result = await commitUpload(req(owner.cookie, "POST", official ? { official } : undefined), { params: Promise.resolve({ versionId }) });
    expect(result.status).toBe(201);
    const data = await result.json();
    expect(data.officialVersionId).toBe(official ? versionId : null);
  });
});
