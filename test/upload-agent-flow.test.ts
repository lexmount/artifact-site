// The three-step curl sequence the manual's "chunked upload" section gives agents, replayed here
// verbatim through the route handlers: open a session → PUT each file (raw byte stream) → commit.
// Every promise the manual makes needs an assertion backing it, otherwise an agent follows it,
// hits a wall, and it is still us who get asked.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as openUpload } from "@/app/api/uploads/route";
import { PUT as putFile } from "@/app/api/uploads/[versionId]/files/[...relpath]/route";
import { POST as commitUpload } from "@/app/api/uploads/[versionId]/commit/route";
import { createSite, getSiteView, listVersions } from "@/lib/sites";
import { listAudit } from "@/lib/db";
import { getStorage } from "@/lib/storage";
import { getUploadSession, resetUploadSessionsForTests } from "@/lib/upload-session";
import { __resetRateLimitForTests } from "@/lib/ratelimit";

const BASE = "http://localhost";
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const open = (title: string, cookie = "") =>
  openUpload(new Request(`${BASE}/api/uploads`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ title }) }));
// `extra` carries the deliberate credential (x-edit-token) a client holding one sends on every
// step: on a session that targets an existing site, a cookie alone without an Origin is 401.
const put = (id: string, relpath: string, bytes: Uint8Array<ArrayBuffer>, cookie: string, extra: Record<string, string> = {}) =>
  putFile(
    new Request(`${BASE}/api/uploads/${id}/files/${relpath}`, { method: "PUT", headers: { origin: BASE, "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), cookie, ...extra }, body: bytes }),
    { params: Promise.resolve({ versionId: id, relpath: relpath.split("/") }) },
  );
const commit = (id: string, cookie: string) =>
  commitUpload(new Request(`${BASE}/api/uploads/${id}/commit`, { method: "POST", headers: { origin: BASE, "content-type": "application/json", cookie }, body: "{}" }), { params: Promise.resolve({ versionId: id }) });

beforeEach(() => __resetRateLimitForTests());
const streamOf = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
afterEach(async () => { await resetUploadSessionsForTests(); delete process.env.ARTIFACT_MAX_BYTES; });

describe("chunked upload — the contract of the manual's three curl steps", () => {
  it("open a session → PUT each file (including subdirectories) → commit, yielding the same slug/url/editToken as site creation", async () => {
    const opened = await open("agent 传的大项目");
    expect(opened.status).toBe(201);
    const cookie = cookieOf(opened);            // opening a session anonymously sets a cookie; later requests are matched by it
    expect(cookie).toMatch(/=/);
    const { versionId } = (await opened.json()) as { versionId: string };

    const html = new TextEncoder().encode("<!doctype html><title>big</title><video src=\"media/clip.bin\"></video>");
    const clip = new Uint8Array(3 * 1024 * 1024).fill(9);
    expect((await put(versionId, "index.html", html, cookie)).status).toBe(200);
    const r2 = await put(versionId, "media/clip.bin", clip, cookie);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { bytes: number }).bytes).toBe(clip.byteLength); // reports the bytes that actually streamed through

    const done = await commit(versionId, cookie);
    expect(done.status).toBe(201);
    const body = (await done.json()) as { slug: string; url: string; kind: string; editToken?: string; versionId: string };
    expect(body.slug).toBeTruthy();
    expect(body.url).toBe(`/s/${body.slug}`);
    expect(body.kind).toBe("folder");
    expect(body.editToken).toBeTruthy();        // manual: commit returns the same editToken as site creation

    // The persisted version: entry is the root index.html, two files, byte count from what really sits in storage
    const view = (await getSiteView(body.slug))!;
    expect(view.version.entry).toBe("index.html");
    const versions = (await listVersions(body.slug))!;
    expect(versions[0].fileCount).toBe(2);
    expect(versions[0].byteSize).toBe(html.byteLength + clip.byteLength);
    // The session is destroyed once used
    expect(await getUploadSession(versionId)).toBeNull();
  });

  it("a PUT under a different identity is treated as a missing session (404), not as stuffing files into someone else's", async () => {
    const opened = await open("mine");
    const mine = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    const stranger = cookieOf(await open("theirs"));   // another anonymous identity
    expect(stranger).not.toBe(mine);
    const res = await put(versionId, "index.html", new Uint8Array(16), stranger);
    expect(res.status).toBe(404);
    // The owner proceeds as normal
    expect((await put(versionId, "index.html", new Uint8Array(16), mine)).status).toBe(200);
  });

  it("committing with no entry HTML → 400, and the bytes already uploaded are reclaimed (the manual's words)", async () => {
    const opened = await open("no-entry");
    const cookie = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    await put(versionId, "media/only.bin", new Uint8Array(1024), cookie);
    const done = await commit(versionId, cookie);
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/HTML|entry/);
    expect(await getUploadSession(versionId)).toBeNull();  // session and bytes are gone together
  });

  it("a single PDF via chunked upload → document site: the entry is the generated index.html, the original stays in place and is not copied", async () => {
    const opened = await open("");  // no title given, to verify the title is taken from the filename
    const cookie = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    // Raw "PDF" bytes, PUT straight to the bare filename (the web client's single-file pick uses the filename as relpath)
    const pdf = new TextEncoder().encode("%PDF-1.7 " + "x".repeat(4096));
    expect((await put(versionId, "季度报告.pdf", pdf, cookie)).status).toBe(200);

    const done = await commit(versionId, cookie);
    expect(done.status).toBe(201);
    const body = (await done.json()) as { slug: string; kind: string; title: string };
    expect(body.kind).toBe("document");           // no longer a folder
    expect(body.title).toBe("季度报告");           // title taken from the filename, not "index"

    const view = (await getSiteView(body.slug))!;
    expect(view.site.kind).toBe("document");
    expect(view.version.entry).toBe("index.html"); // the entry becomes the generated wrapper page
    const files = await getStorage().list(view.site.id, view.version.id);
    expect(files.sort()).toEqual(["index.html", "季度报告.pdf"].sort()); // the original stays put, not moved into original/
    // The wrapper points at the original; the original's bytes are untouched (not read into memory and rewritten, which could corrupt them)
    const wrapper = new TextDecoder().decode(await getStorage().read(view.site.id, view.version.id, "index.html"));
    expect(wrapper).toContain("季度报告.pdf");  // the wrapper points at the original
    expect(new Uint8Array(await getStorage().read(view.site.id, view.version.id, "季度报告.pdf"))).toEqual(pdf); // original bytes untouched
  });

  it("a single Office file via chunked upload → a targeted error (not a silent failure), and the session is reclaimed", async () => {
    const opened = await open("大 PPT");
    const cookie = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    // Starts with PK\x03\x04, posing as a pptx OPC package
    const pptx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new Array(64).fill(0)]);
    expect((await put(versionId, "slides.pptx", pptx, cookie)).status).toBe(200);
    const done = await commit(versionId, cookie);
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/single PDF document only|convert to PDF/);
    expect(await getUploadSession(versionId)).toBeNull();
  });

  it("committing with nothing uploaded → 400 that states the reason", async () => {
    const opened = await open("empty");
    const { versionId } = (await opened.json()) as { versionId: string };
    const done = await commit(versionId, cookieOf(opened));
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/No files have been uploaded/);
  });
});

describe("the final check at commit — concurrent PUTs each saw a stale tally", () => {
  // Reproduces the race the review pointed out: two concurrent PUTs each read the same `files`
  // before the other writes back, both conclude "there is still room", and both sets of bytes land
  // in storage. Rather than actually running two concurrent requests, bytes are written straight
  // to storage without being tallied — the effect is equivalent.
  it("the real total in storage is over the limit → commit 400, and the session is reclaimed along with its bytes", async () => {
    process.env.ARTIFACT_MAX_BYTES = String(4096);
    const opened = await open("race");
    const cookie = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    const session = (await getUploadSession(versionId))!;
    // Both "concurrent PUTs" bypass the tally (simulating a stale tally); only index.html is PUT normally
    await getStorage().writeStreamToVersion(session.siteId, session.versionId, "a.bin", streamOf(new Uint8Array(3000)));
    await getStorage().writeStreamToVersion(session.siteId, session.versionId, "b.bin", streamOf(new Uint8Array(3000)));
    expect((await put(versionId, "index.html", new TextEncoder().encode("<title>x</title>"), cookie)).status).toBe(200);

    const done = await commit(versionId, cookie);
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/over the limit/);
    expect(await getUploadSession(versionId)).toBeNull();
    expect(await getStorage().sizeOf(session.siteId, session.versionId, "a.bin")).toBeNull(); // the over-limit half-product is not kept
  });
});

describe("adding a version to an existing site — whatever the site is, the new version must still be that", () => {
  const PDF = (tag: string) => new TextEncoder().encode(`%PDF-1.7 ${tag} ` + "x".repeat(2048));

  it("a document site updated with a single PDF via chunked upload → the new version becomes current, still a document site, wrapper points at the new file, audit records edit", async () => {
    const created = await createSite({ mode: "file", filename: "白皮书v1.pdf", bytes: PDF("v1") }, { anonOwnerId: "anon_doc_owner" });
    expect(created.site.kind).toBe("document");
    const cookie = "ah_anon=anon_doc_owner";
    const headers = { "content-type": "application/json", cookie, "x-edit-token": created.site.editToken };

    const opened = await openUpload(new Request(`${BASE}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ slug: created.site.slug }) }));
    expect(opened.status).toBe(201);
    const { versionId } = (await opened.json()) as { versionId: string };
    expect((await put(versionId, "白皮书v2.pdf", PDF("v2"), cookie, { "x-edit-token": created.site.editToken })).status).toBe(200);
    const done = await commitUpload(new Request(`${BASE}/api/uploads/${versionId}/commit`, { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ versionId }) });
    expect(done.status).toBe(201);
    const body = (await done.json()) as { kind: string; slug: string };
    expect(body.kind).toBe("document");
    expect(body.slug).toBe(created.site.slug);                  // same address

    const view = (await getSiteView(created.site.slug))!;
    expect(view.version.id).toBe(versionId);                     // became the current version
    expect(view.version.entry).toBe("index.html");
    const files = await getStorage().list(view.site.id, versionId);
    expect(files.sort()).toEqual(["index.html", "白皮书v2.pdf"].sort());
    const wrapper = new TextDecoder().decode(await getStorage().read(view.site.id, versionId, "index.html"));
    expect(wrapper).toContain("白皮书v2.pdf");
    expect(wrapper).not.toContain("白皮书v1.pdf");
    const audit = await listAudit(created.site.id);
    expect(audit.find((a) => a.versionId === versionId)?.action).toBe("edit");
  });

  it("a document site updated with a set of HTML files → 400 saying 'must still be a single PDF', not 'No HTML file found'", async () => {
    const created = await createSite({ mode: "file", filename: "报告.pdf", bytes: PDF("v1") }, { anonOwnerId: "anon_doc_owner2" });
    const cookie = "ah_anon=anon_doc_owner2";
    const headers = { "content-type": "application/json", cookie, "x-edit-token": created.site.editToken };
    const opened = await openUpload(new Request(`${BASE}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ slug: created.site.slug }) }));
    const { versionId } = (await opened.json()) as { versionId: string };
    await put(versionId, "index.html", new TextEncoder().encode("<title>x</title>"), cookie, { "x-edit-token": created.site.editToken });
    const done = await commitUpload(new Request(`${BASE}/api/uploads/${versionId}/commit`, { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ versionId }) });
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/must still be a single PDF/);
    expect(await getUploadSession(versionId)).toBeNull();
    expect((await getSiteView(created.site.slug))!.version.id).toBe(created.version.id); // the original version is untouched
  });

  it("an HTML site updated with a single PDF → 400 'cannot be replaced with a document', instead of swapping the whole site for a wrapper page", async () => {
    const created = await createSite({ mode: "paste", html: "<title>site</title><body>site</body>" }, { anonOwnerId: "anon_site_owner" });
    const cookie = "ah_anon=anon_site_owner";
    const headers = { "content-type": "application/json", cookie, "x-edit-token": created.site.editToken };
    const opened = await openUpload(new Request(`${BASE}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ slug: created.site.slug }) }));
    const { versionId } = (await opened.json()) as { versionId: string };
    await put(versionId, "偷换.pdf", PDF("x"), cookie, { "x-edit-token": created.site.editToken });
    const done = await commitUpload(new Request(`${BASE}/api/uploads/${versionId}/commit`, { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ versionId }) });
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/cannot be replaced with a document/);
    expect((await getSiteView(created.site.slug))!.version.id).toBe(created.version.id);
  });

  it("the original is already gone from storage at commit → 400 with the reason and the session reclaimed, instead of a document site pointing at an empty file", async () => {
    const opened = await open("");
    const cookie = cookieOf(opened);
    const { versionId } = (await opened.json()) as { versionId: string };
    expect((await put(versionId, "ghost.pdf", PDF("g"), cookie)).status).toBe(200);
    const session = (await getUploadSession(versionId))!;
    await getStorage().removeVersion(session.siteId, session.versionId);   // simulates expiry cleanup / a write that never landed
    const done = await commit(versionId, cookie);
    expect(done.status).toBe(400);
    expect(((await done.json()) as { error: string }).error).toMatch(/not in storage/);
    expect(await getUploadSession(versionId)).toBeNull();
  });
});

describe("adding a version to an existing site — audit and version in the same transaction", () => {
  it("after commit the version is current, and the audit table has an edit row pointing at it", async () => {
    // The site was created by anonymous browser anon_owner_1; later requests carry both its cookie
    // (what enforceOwnership relies on) and the editToken (what legacy mode relies on) — either
    // deployment shape should recognise edit permission
    const created = await createSite({ mode: "paste", html: "<title>v1</title><body>v1</body>" }, { anonOwnerId: "anon_owner_1" });
    const cookie = "ah_anon=anon_owner_1";
    const headers = { "content-type": "application/json", cookie, "x-edit-token": created.site.editToken };

    const opened = await openUpload(new Request(`${BASE}/api/uploads`, { method: "POST", headers, body: JSON.stringify({ slug: created.site.slug }) }));
    expect(opened.status).toBe(201);
    const { versionId } = (await opened.json()) as { versionId: string };
    expect((await put(versionId, "index.html", new TextEncoder().encode("<title>v2</title><body>v2</body>"), cookie, { "x-edit-token": created.site.editToken })).status).toBe(200);
    const done = await commitUpload(new Request(`${BASE}/api/uploads/${versionId}/commit`, { method: "POST", headers, body: "{}" }), { params: Promise.resolve({ versionId }) });
    expect(done.status).toBe(201);

    const view = (await getSiteView(created.site.slug))!;
    expect(view.version.id).toBe(versionId);                       // became the current version
    const audit = await listAudit(created.site.id);
    const row = audit.find((a) => a.versionId === versionId);
    expect(row?.action).toBe("edit");                              // the audit row points at this new version
  });
});
