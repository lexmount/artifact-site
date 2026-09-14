// GET /edit-frame?version=<id> — when editing on top of a historical version, the whole editing
// surface must switch to that version: the served entry HTML, the source used for marking and
// x-ah-editor-version must all be the same version, or text write-back offsets will not line up.
//
// The most important case here is the **security boundary**: lib/db's getVersion(id) is a global
// lookup by id that ignores siteId; without the target.siteId !== site.id check, site B's source
// could be served under site A's slug (and to someone who only has edit rights on A).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as editFrameGET } from "@/app/api/sites/[slug]/edit-frame/route";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";
import { closeDbForTests } from "@/lib/db";
import { createSite, listVersions } from "@/lib/sites";
import { EDITOR_MARK } from "@/lib/editor-bootstrap";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "ah-efv-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => { await closeDbForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.ARTIFACT_DATA_DIR; });

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

function frameReq(slug: string, token?: string, version?: string): Request {
  const url = new URL(`http://x/api/sites/${slug}/edit-frame`);
  if (version !== undefined) url.searchParams.set("version", version);
  return new Request(url, { headers: token ? { "x-edit-token": token } : {} });
}

const doc = (body: string) => `<html><head><title>t</title></head><body><p>${body}</p></body></html>`;

async function singleSite(html: string) {
  const { site } = await createSite({ mode: "file", filename: "index.html", bytes: new Uint8Array(Buffer.from(html, "utf8")) });
  return site;
}

/** Saves once → the site gains a version. Returns the new version id. */
async function saveOnce(slug: string, token: string, html: string): Promise<string> {
  const res = await editPOST(new Request(`http://x/api/sites/${slug}/edit`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-edit-token": token },
    body: JSON.stringify({ content: html }),
  }), params(slug));
  expect(res.status).toBe(200);
  return (await res.json()).versionId as string;
}

describe("GET /edit-frame?version= · serves the requested version", () => {
  it("without version it still serves the current version (the default path is unchanged)", async () => {
    const site = await singleSite(doc("一版"));
    const v2 = await saveOnce(site.slug, site.editToken, doc("二版"));

    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ah-editor-version")).toBe(v2);
    expect(await res.text()).toContain("二版");
  });

  it("with a historical version → serves that version's body and x-ah-editor-version echoes it", async () => {
    const site = await singleSite(doc("一版"));
    await saveOnce(site.slug, site.editToken, doc("二版"));
    const versions = (await listVersions(site.slug))!;
    const v1 = versions[versions.length - 1]; // the oldest version
    expect(v1.current).toBe(false);

    const res = await editFrameGET(frameReq(site.slug, site.editToken, v1.id), params(site.slug));
    expect(res.status).toBe(200);
    // All three must switch together, or the marker numbers will not match the source the parent
    // page holds → write-back lands in the wrong place
    expect(res.headers.get("x-ah-editor-version")).toBe(v1.id);
    const body = await res.text();
    expect(body).toContain("一版");
    expect(body).not.toContain("二版");
    expect(body).toContain(EDITOR_MARK); // the editor script is still injected
  });

  it("explicitly passing the current version's id → same as passing none", async () => {
    const site = await singleSite(doc("一版"));
    const v2 = await saveOnce(site.slug, site.editToken, doc("二版"));

    const res = await editFrameGET(frameReq(site.slug, site.editToken, v2), params(site.slug));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ah-editor-version")).toBe(v2);
    expect(await res.text()).toContain("二版");
  });

  it("a nonexistent version id → 404, never silently substituting the current version (the user would think they are editing the old one while editing the new one)", async () => {
    const site = await singleSite(doc("一版"));
    await saveOnce(site.slug, site.editToken, doc("二版"));

    const res = await editFrameGET(frameReq(site.slug, site.editToken, "ver_nope"), params(site.slug));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(EDITOR_MARK);
    expect(body).not.toContain("二版");
  });
});

describe("GET /edit-frame?version= · cross-site access", () => {
  it("another site's version id → 404, and not one byte of their source is sent", async () => {
    const mine = await singleSite(doc("我的内容"));
    const theirs = await singleSite(doc("别人的机密"));
    const theirVersion = (await listVersions(theirs.slug))![0];

    // I have edit rights on mine (correct token), but the version id belongs to theirs
    const res = await editFrameGET(frameReq(mine.slug, mine.editToken, theirVersion.id), params(mine.slug));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("别人的机密");
    expect(body).not.toContain(EDITOR_MARK);
  });

  it("someone without edit rights gets 403 even with the right version — authorisation precedes version handling", async () => {
    const site = await singleSite(doc("一版"));
    await saveOnce(site.slug, site.editToken, doc("二版"));
    const versions = (await listVersions(site.slug))!;
    const v1 = versions[versions.length - 1];

    const res = await editFrameGET(frameReq(site.slug, undefined, v1.id), params(site.slug));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).not.toContain(EDITOR_MARK);
    expect(body).not.toContain("一版");
  });

  it("no edit rights + a guessed version id is also 403 (the 404/403 difference must not reveal whether a version exists)", async () => {
    const site = await singleSite(doc("一版"));
    const res = await editFrameGET(frameReq(site.slug, undefined, "ver_nope"), params(site.slug));
    expect(res.status).toBe(403);
  });
});
