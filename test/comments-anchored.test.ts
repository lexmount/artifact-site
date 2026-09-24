import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDbForTests, createId, createShare, rbacQuery, upsertUser, revokeShare } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { mintSession } from "@/lib/session";
import { hashToken } from "@/lib/share";
import { createComment, mutateMessage, replyComment } from "@/lib/comments/service";
import { getAgentContext } from "@/lib/comments/agent-context";
import { GET as OPTIONS } from "@/app/api/sites/[slug]/comments/options/route";
import { GET as AGGREGATE } from "@/app/api/sites/[slug]/comments/aggregate/route";
import { GET as CONTEXT } from "@/app/api/sites/[slug]/comments/[threadId]/agent-context/route";
import { POST } from "@/app/api/sites/[slug]/comments/route";
import { testAudit } from "./helpers";
import { buildCommentPdf } from "./fixtures/comment-pdf";
import { getStorage } from "@/lib/storage";
import type { CreateCommentInput } from "@/lib/comments/contracts";
const origin = "https://comments.example";
afterEach(closeDbForTests);
async function identity() {
  const user = await upsertUser({ authProvider: "anchored", providerSubject: createId("subject"), email: `${createId("mail")}@example.com`, emailVerified: true });
  const { cookie } = await mintSession(new Request(origin), user.id);
  return { user, cookie: cookie.split(";")[0] };
}
function req(cookie: string, path = "/", body?: unknown, token?: string) {
  return new Request(origin + path, { method: body === undefined ? "GET" : "POST", headers: { cookie, origin, "content-type": "application/json", ...(token ? { "x-artifact-share": token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function fixture() {
  const owner = await identity(), reader = await identity();
  const { site } = await createSite({ mode: "paste", html: '<html><body><h1>Original evidence</h1><form><input value="SECRET_FORM_VALUE"></form></body></html>' }, { ownerId: owner.user.id });
  const input: CreateCommentInput = { scope: { siteId: site.id, versionId: site.currentVersionId, entry: { kind: "main" } }, anchor: { kind: "html", schemaVersion: 1, filePath: "index.html", selector: "h1", quote: { exact: "Original evidence" }, viewport: { width: 800, height: 600 } }, body: "Please clarify this", clientRequestId: randomUUID() };
  return { owner, reader, site, input };
}
describe("anchored API and Agent integration", () => {
  it("exposes review metadata only to managers and never includes share credentials", async () => {
    const {site,owner,reader}=await fixture();
    const token=createId("share");
    await createShare({id:createId("shr"),siteId:site.id,tokenHash:hashToken(token),policy:"public",mode:"comment",passcodeHash:null,label:"Customer review",createdBy:owner.user.id,createdAnonId:null,expiresAt:null,versionId:null});
    const context={params:Promise.resolve({slug:site.slug})};
    expect((await OPTIONS(req(reader.cookie),context)).status).toBe(404);
    expect((await OPTIONS(req(owner.cookie, "/?utm_source=x"),context)).status).toBe(400);
    const response=await OPTIONS(req(owner.cookie),context),body=await response.json();
    expect(response.status).toBe(200);expect(body.shares[0].label).toBe("Customer review");expect(body.versions[0].id).toBe(site.currentVersionId);
    expect(JSON.stringify(body)).not.toContain(token);expect(JSON.stringify(body)).not.toContain("tokenHash");
  });
  it("rejects CSRF before reading any evidence bytes", async () => {
    const { site, owner, input } = await fixture();
    const read = vi.spyOn(getStorage(), "sizeOf");
    try {
      const request = new Request(origin + "/api/comments", { method: "POST", headers: { cookie: owner.cookie, origin: "https://other.example", "content-type": "application/json" }, body: JSON.stringify(input) });
      expect((await POST(request, { params: Promise.resolve({ slug: site.slug }) })).status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  it("persists server-verified evidence through the real route and removes it with the root", async () => {
    const { site, owner, input } = await fixture();
    const response = await POST(req(owner.cookie, "/", input), { params: Promise.resolve({ slug: site.slug }) });
    expect(response.status).toBe(201);
    const detail = await response.json();
    expect(detail.thread.context.excerpt).toBe("Original evidence");
    const bundle = await getAgentContext(req(owner.cookie), site.slug, detail.thread.id);
    expect(bundle.capabilities).toEqual({ canEditContent: true, canExportSource: true });
    expect(bundle.artifact.originalVersionId).toBe(site.currentVersionId);
    expect(bundle.evidence.captureStatus).toBe("unsupported");
    expect(JSON.stringify(bundle)).not.toMatch(/SECRET_FORM_VALUE|requestFingerprint|storageKey|claimToken|editToken/);
    await replyComment(req(owner.cookie), site.slug, detail.thread.id, { body: "Keep this reply", clientRequestId: randomUUID() });
    await mutateMessage(req(owner.cookie), site.slug, detail.thread.id, detail.messages.items[0].id, { expectedRevision: 1 }, "delete");
    const deleted = await getAgentContext(req(owner.cookie), site.slug, detail.thread.id);
    expect(JSON.stringify(deleted)).not.toContain("Original evidence");
    expect(deleted.threads[0].messages.items[1].content).toEqual({ state: "visible", body: "Keep this reply" });
  });
  it("keeps share-context bundles isolated and rechecks revoked credentials", async () => {
    const { site, owner, reader, input } = await fixture();
    const token = createId("share-secret");
    const share = await createShare({ siteId: site.id, passcodeHash: null, label: null, createdAnonId: null, versionId: null, id: createId("shr"), tokenHash: hashToken(token), policy: "public", mode: "comment", expiresAt: null, createdBy: owner.user.id });
    const first = await createComment(req(reader.cookie, "/", undefined, token), site.slug, { ...input, scope: { ...input.scope, entry: { kind: "share", shareId: share.id } } });
    const allowed = await getAgentContext(req(reader.cookie, "/", undefined, token), site.slug, first.detail.thread.id);
    expect(allowed.capabilities).toEqual({ canEditContent: false, canExportSource: false });
    expect(JSON.stringify(allowed)).not.toContain(token);
    // A verified browser participant now retains revocable, version-scoped access.
    expect((await CONTEXT(req(reader.cookie), { params: Promise.resolve({ slug: site.slug, threadId: first.detail.thread.id }) })).status).toBe(200);
    await revokeShare(share.id);
    expect((await CONTEXT(req(reader.cookie, "/", undefined, token), { params: Promise.resolve({ slug: site.slug, threadId: first.detail.thread.id }) })).status).toBe(404);
    expect((await getAgentContext(req(owner.cookie), site.slug, first.detail.thread.id)).scope.entry).toEqual({ kind: "share", shareId: share.id });
  });
  it("aggregates with author/sort cursor binding without exposing manager results to readers", async () => {
    const { site, owner, reader, input } = await fixture();
    const a = await createComment(req(owner.cookie), site.slug, input);
    const b = await createComment(req(owner.cookie), site.slug, { ...input, clientRequestId: randomUUID(), body: "Second" });
    await rbacQuery("UPDATE comment_threads SET created_at=$1 WHERE id=$2", [1, a.detail.thread.id]);
    await rbacQuery("UPDATE comment_threads SET created_at=$1 WHERE id=$2", [2, b.detail.thread.id]);
    const params = { params: Promise.resolve({ slug: site.slug }) };
    const result = await AGGREGATE(req(owner.cookie, `/?sort=oldest&authorUserId=${owner.user.id}&limit=1`), params);
    const page = await result.json();
    expect(page.items[0].thread.id).toBe(a.detail.thread.id);
    expect(page.total).toBe(2);
    expect(page.nextCursor).toBeTruthy();
    const next = await AGGREGATE(req(owner.cookie, `/?sort=oldest&authorUserId=${owner.user.id}&limit=1&cursor=${encodeURIComponent(page.nextCursor)}`), params);
    const secondPage = await next.json();
    expect(secondPage.items[0].thread.id).toBe(b.detail.thread.id);
    expect(secondPage.total).toBeUndefined();
    expect((await AGGREGATE(req(owner.cookie, `/?sort=newest&cursor=${encodeURIComponent(page.nextCursor)}`), params)).status).toBe(400);
    expect((await AGGREGATE(req(reader.cookie), params)).status).toBe(404);
    expect((await AGGREGATE(req(owner.cookie, "/?sort=newest&sort=oldest"), params)).status).toBe(400);
    expect((await AGGREGATE(req(owner.cookie, "/?unknown=1"), params)).status).toBe(400);
  });
  it("replays a saved PDF comment without rereading evidence and rejects changed content", async () => {
    const { site, owner, input } = await fixture();
    await getStorage().writeFileToVersion(site.id, site.currentVersionId, "preview.pdf", buildCommentPdf(1));
    const payload = { ...input, anchor: { kind: "pdf" as const, schemaVersion: 1 as const, filePath: "preview.pdf", page: 1, region: { kind: "point" as const, point: { x: .5, y: .5 } } } };
    const first = await createComment(req(owner.cookie), site.slug, payload);
    const reads = vi.spyOn(getStorage(), "sizeOf").mockRejectedValue(new Error("Evidence must not run on retry"));
    try {
      const replay = await createComment(req(owner.cookie), site.slug, payload);
      expect(replay.replayed).toBe(true); expect(replay.detail.thread.id).toBe(first.detail.thread.id);
      await expect(createComment(req(owner.cookie), site.slug, { ...payload, body: "Different" })).rejects.toMatchObject({ statusCode: 409 });
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
  });
  it("validates actual PDF pages before storing and never moves an old anchor to a new version", async () => {
    const { site, owner, input } = await fixture();
    await getStorage().writeFileToVersion(site.id, site.currentVersionId, "preview.pdf", buildCommentPdf(1));
    const anchor = { kind: "pdf" as const, schemaVersion: 1 as const, filePath: "preview.pdf", page: 2, region: { kind: "point" as const, point: { x: .5, y: .5 } } };
    expect((await POST(req(owner.cookie, "/", { ...input, anchor }), { params: Promise.resolve({ slug: site.slug }) })).status).toBe(400);
    const first = await createComment(req(owner.cookie), site.slug, input);
    await editSite(site.slug, { content: "<html><body>Updated version</body></html>" }, testAudit());
    await rbacQuery("UPDATE sites SET official_version_id=$1 WHERE id=$2", [input.scope.versionId, site.id]);
    const bundle = await getAgentContext(req(owner.cookie), site.slug, first.detail.thread.id);
    expect(bundle.artifact.originalVersionId).toBe(input.scope.versionId);
    expect(bundle.scope.versionId).toBe(input.scope.versionId);
    expect(bundle.artifact.latestVersionId).not.toBe(input.scope.versionId);
    expect(bundle.threads[0].thread.anchor).toEqual(input.anchor);
  });
});
