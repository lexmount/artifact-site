// The re-edit loop — export → edit → whole-tree write-back, as the storage layer sees it.
// Pinned as the loop's guarantees, not CRUD coverage:
//
//   one snapshot   · export hands back the tree AND the version id it came from — the lock base
//                    can never drift from the bytes
//   round trip     · what zipSync packed, unzipSync opens; content survives byte-for-byte
//   one version    · a whole-tree write-back lands exactly ONE new immutable version
//   honest loss    · with expected_version, a concurrent save answers conflict + the real current
//                    id, and the loser's just-written tree is swept, not left as an orphan
//   shape is law   · a folder drop onto a single site is refused loudly; document files never
//                    become an html site's version
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDbForTests, getSite, getVersion, listVersions } from "@/lib/db";
import { createSite, editSite, exportSiteZip, replaceSiteContent } from "@/lib/sites";
import { type AuditContext } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-roundtrip-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

const CTX: AuditContext = { actor: { kind: "anon", userId: null, anonId: "anon_agent" }, method: "api", ip: null, userAgent: "vitest" };

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

async function publishFolder() {
  return createSite({
    mode: "folder",
    files: [
      { relpath: "index.html", bytes: Buffer.from("<html><head></head><body>v1</body></html>") },
      { relpath: "assets/app.css", bytes: Buffer.from("body{color:red}") },
    ],
    title: "往返站",
  }, {}, CTX);
}

describe("exportSiteZip — one snapshot, tree + lock base together", () => {
  it("zips the CURRENT tree and names the version it came from", async () => {
    const { site, version } = await publishFolder();
    const exported = (await exportSiteZip(site.slug))!;
    expect(exported.versionId).toBe(version.id);
    const files = unzipSync(exported.bytes);
    expect(Object.keys(files).sort()).toEqual(["assets/app.css", "index.html"]);
    expect(text(files["index.html"])).toContain("v1");
    expect(exported.filename).toBe(`${site.slug}-${version.id}.zip`);
  });

  it("answers null for a missing or deleted site", async () => {
    expect(await exportSiteZip("no-such-slug")).toBeNull();
  });
});

describe("replaceSiteContent — the write-back", () => {
  it("lands the whole tree as ONE new current version; the old one stays rollback-able", async () => {
    const { site, version: v1 } = await publishFolder();
    const result = await replaceSiteContent(site.slug, {
      mode: "folder",
      files: [
        { relpath: "index.html", bytes: Buffer.from("<html><head></head><body>v2</body></html>") },
        { relpath: "assets/app.css", bytes: Buffer.from("body{color:blue}") },
        { relpath: "assets/new.js", bytes: Buffer.from("console.log(2)") },
      ],
    }, CTX, v1.id);

    expect(result && "site" in result).toBe(true);
    const v2 = (result as { version: { id: string } }).version;
    expect((await getSite(site.id))?.currentVersionId).toBe(v2.id);
    expect((await listVersions(site.id)).map((v) => v.id).sort()).toEqual([v1.id, v2.id].sort());
    expect(await getVersion(v1.id)).not.toBeNull(); // the old snapshot survives for rollback

    const reexport = (await exportSiteZip(site.slug))!;
    const files = unzipSync(reexport.bytes);
    expect(text(files["index.html"])).toContain("v2");
    expect(Object.keys(files)).toContain("assets/new.js");
  });

  it("with expected_version, a concurrent save loses HONESTLY: conflict + real current id + no orphan tree", async () => {
    const { site, version: v1 } = await publishFolder();
    // Someone else commits first (unconditional write, like the web editor).
    const other = await replaceSiteContent(site.slug, {
      mode: "folder",
      files: [{ relpath: "index.html", bytes: Buffer.from("<html><head></head><body>theirs</body></html>") }],
    }, CTX);
    const theirs = (other as { version: { id: string } }).version;

    const stale = await replaceSiteContent(site.slug, {
      mode: "folder",
      files: [{ relpath: "index.html", bytes: Buffer.from("<html><head></head><body>mine</body></html>") }],
    }, CTX, v1.id);

    expect(stale).toEqual({ conflict: true, currentVersionId: theirs.id });
    expect((await getSite(site.id))?.currentVersionId).toBe(theirs.id); // nothing was buried
    // The loser's just-written files were swept — only the two real versions hold storage.
    const stored = (await getStorage().listStoredVersions()).filter((v) => v.siteId === site.id);
    expect(stored.map((v) => v.versionId).sort()).toEqual([v1.id, theirs.id].sort());
  });

  it("refuses a shape change and document bytes, loudly", async () => {
    const { site } = await publishFolder();
    await expect(replaceSiteContent(site.slug, {
      mode: "paste", html: "<html><head></head><body>single now?</body></html>",
    }, CTX)).rejects.toThrow(/shape cannot change/);
  });

  it("answers a NUMERIC expected_version with directions, not an endless 409", async () => {
    // The one mistake the contract invites: artifactHub.version (ordinal) instead of versionId.
    const { POST } = await import("@/app/api/sites/[slug]/versions/route");
    const { site } = await publishFolder();
    const res = await POST(new Request(`https://x/api/sites/${site.slug}/versions?expected_version=4`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-edit-token": site.editToken },
      body: JSON.stringify({ mode: "folder", files: [{ path: "index.html", content: "<html><head></head><body>n</body></html>" }] }),
    }), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(400);
    const body = await res.json() as { code?: string; error?: string };
    expect(body.code).toBe("expected_version_not_an_id");
    expect(body.error).toContain("artifactHub.versionId");
  });
});

// --- optimistic locking on /edit (the gap exposed by the B4 joint verification) ------------------
//
// Single-file sites change content via /edit rather than /versions, and expected_version was once
// honoured only by the latter. So the protection the skill teaches agents to pass was silently
// ignored on this path: two people editing at once, the later write overwrote the earlier one, and
// both believed there was a lock. "Believing you are protected" is more dangerous than "knowing you
// are not" — this suite pins both paths to the same semantics.
describe("optimistic locking in editSite — single-file sites must have it too", () => {
  async function publishSingle() {
    return createSite({ mode: "paste", html: "<html><head></head><body>v1</body></html>" }, {}, CTX);
  }

  it("with the correct baseline a new version lands as usual", async () => {
    const { site, version: v1 } = await publishSingle();
    const r = await editSite(site.slug, { content: "<html><head></head><body>v2</body></html>" }, CTX, v1.id);
    expect(r && "version" in r).toBe(true);
    expect((await getSite(site.id))?.currentVersionId).toBe((r as { version: { id: string } }).version.id);
  });

  it("with a stale baseline it returns a conflict instead of silently overwriting, carrying the true current version", async () => {
    const { site, version: v1 } = await publishSingle();
    const other = await editSite(site.slug, { content: "<html><head></head><body>theirs</body></html>" }, CTX);
    const theirs = (other as { version: { id: string } }).version;

    const stale = await editSite(site.slug, { content: "<html><head></head><body>mine</body></html>" }, CTX, v1.id);
    expect(stale).toEqual({ conflict: true, currentVersionId: theirs.id });
    expect((await getSite(site.id))?.currentVersionId).toBe(theirs.id); // not buried

    const stored = (await getStorage().listStoredVersions()).filter((v) => v.siteId === site.id);
    expect(stored.map((v) => v.versionId).sort()).toEqual([v1.id, theirs.id].sort()); // the loser's tree was swept
  });

  it("without a baseline the existing last-write-wins semantics are kept", async () => {
    const { site } = await publishSingle();
    const r = await editSite(site.slug, { content: "<html><head></head><body>v2</body></html>" }, CTX);
    expect(r && "version" in r).toBe(true);
  });
});

// --- the three HTTP-layer outcomes of /edit (row by row against the IF-side joint verification table) ---
//
// In production they found all three correct on /versions, then reproduced on /edit that "the number
// 2 → 200 written, a stale versionId → still 200 written" — the parameter was ignored entirely. The
// lib-level lock is pinned by the previous suite; this one pins the route layer: parsing, foolproofing
// and 409 must all hold on **this** path too, or the protection taught in the agent manual remains
// hollow for single-file sites.
describe("/edit route layer: the same expected_version semantics as /versions", () => {
  const editReq = (slug: string, token: string, content: string, expected?: string) =>
    new Request(`https://x/api/sites/${slug}/edit${expected === undefined ? "" : `?expected_version=${expected}`}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-edit-token": token },
      body: JSON.stringify({ content }),
    });

  it("correct versionId → 200", async () => {
    const { site, version } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const res = await editPOST(editReq(site.slug, site.editToken, "<html><head></head><body>2</body></html>", version.id), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(200);
  });

  it("the number 2 → 400 expected_version_not_an_id", async () => {
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const res = await editPOST(editReq(site.slug, site.editToken, "<html><head></head><body>x</body></html>", "2"), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(400);
    expect((await res.json() as { code?: string }).code).toBe("expected_version_not_an_id");
  });

  // Blocking numbers alone is not enough: any value that does not look like a version id can never
  // match, and turning that into a 409 is an inescapable loop — the caller re-exports as told, retries
  // with the same malformed parameter, gets 409 again. The REQUEST is wrong; say so clearly, once.
  it.each(["abc", "ver", "ver_", "2", "0", "999"])("malformed expected_version %s → 400 rather than an unsolvable 409", async (bad) => {
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const res = await editPOST(editReq(site.slug, site.editToken, "<html><head></head><body>x</body></html>", bad), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(400);
    expect((await res.json() as { code?: string }).code).toBe("expected_version_not_an_id");
  });

  it("a stale versionId → 409 version_conflict, with no silent overwrite", async () => {
    const { site, version: v1 } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const moved = await editSite(site.slug, { content: "<html><head></head><body>theirs</body></html>" }, CTX);
    const theirs = (moved as { version: { id: string } }).version;

    const res = await editPOST(editReq(site.slug, site.editToken, "<html><head></head><body>mine</body></html>", v1.id), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(409);
    const body = await res.json() as { code?: string; currentVersionId?: string };
    expect(body.code).toBe("version_conflict");
    expect(body.currentVersionId).toBe(theirs.id);
    expect((await getSite(site.id))?.currentVersionId).toBe(theirs.id); // the earlier write is still there
  });

  it("no parameter → existing behaviour is kept (last write wins, not suddenly enforced)", async () => {
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const res = await editPOST(editReq(site.slug, site.editToken, "<html><head></head><body>2</body></html>"), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(200);
  });
});
