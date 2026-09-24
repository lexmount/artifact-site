import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDbForTests, createId, createShare, revokeShare, updateSiteVisibility } from "@/lib/db";
import { createSite, editSite } from "@/lib/sites";
import { GET } from "@/app/api/preview/[slug]/[[...path]]/route";
import { mintScopedPreviewKey, PREVIEW_KEY_TTL_MS } from "@/lib/preview-key";
import { previewTarget } from "@/components/comments/anchored-workspace";
import type { Site } from "@/lib/types";

const origin = "https://preview.test";
const bytes = (s: string) => new TextEncoder().encode(s);
beforeEach(() => { process.env.ARTIFACT_DEFAULT_VISIBILITY = "public"; });
afterEach(async () => { await closeDbForTests(); delete process.env.ARTIFACT_DEFAULT_VISIBILITY; });
const make = async () => (await createSite({ mode: "folder", files: [
  { relpath: "index.html", bytes: bytes('<html><head><link rel="stylesheet" href="./styles.css?v=20260806-01"></head><body>old</body></html>') },
  { relpath: "styles.css", bytes: bytes("body { color: red; }") },
  { relpath: "app.js", bytes: bytes("window.ready = true;") },
  { relpath: "data.json", bytes: bytes('{"ok":true}') },
  { relpath: "nested/font.woff2", bytes: bytes("font") },
  { relpath: "image.svg", bytes: bytes('<svg xmlns="http://www.w3.org/2000/svg"/>') },
  { relpath: "clip.mp4", bytes: bytes("0123456789") },
] }, {})).site;
const get = (segment: string, file = "", query = "", headers: HeadersInit = {}) => GET(
  new Request(`${origin}/api/preview/${segment}/${file}${query ? `?${query}` : ""}`, { headers }),
  { params: Promise.resolve({ slug: segment, path: file ? file.split("/") : undefined }) },
);
const keyFor = (site: Site, now?: number) => mintScopedPreviewKey(site, {
  versionId: site.currentVersionId, shareId: null, userId: null, anonOwnerHash: null,
  fingerprint: "", editTokenHash: createHash("sha256").update(site.editToken).digest("hex"),
}, now);
async function shareFor(site: Site) {
  const token = createId("token");
  const share = await createShare({ id: createId("share"), siteId: site.id,
    tokenHash: createHash("sha256").update(token).digest("hex"), policy: "public", mode: "view",
    versionId: site.currentVersionId, passcodeHash: null, label: null, createdBy: null,
    createdAnonId: null, expiresAt: null });
  return { share, token };
}

describe("artifact query parameters are not preview controls", () => {
  it.each(["public", "private"] as const)("serves all resource types with cache queries on %s artifacts", async (visibility) => {
    const site = await make();
    await updateSiteVisibility(site.id, visibility);
    const segment = visibility === "private" ? `${site.slug}~${await keyFor(site)}` : site.slug;
    for (const [file, type] of [["styles.css", "text/css"], ["app.js", "javascript"], ["data.json", "application/json"], ["nested/font.woff2", "font/woff2"], ["image.svg", "image/svg+xml"], ["index.html", "text/html"]]) {
      const response = await get(segment, file, "v=20260806-01&share=asset&t=timestamp&comment-image=1");
      expect(response.status, file).toBe(200);
      expect(response.headers.get("content-type"), file).toContain(type);
      expect(response.headers.get("location")).toBeNull();
    }
    const range = await get(segment, "clip.mp4", "v=cache", { range: "bytes=2-4" });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("234");
  });

  it("does not redirect public assets whose query includes share", async () => {
    const site = await make();
    const response = await get(site.slug, "styles.css", "share=social&t=123");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("body { color: red; }");
  });

  it("keeps image bytes intact for an ordinary comment-image query", async () => {
    const site = await make();
    expect((await get(site.slug, "image.svg", "comment-image=1")).headers.get("content-type")).toContain("image/svg+xml");
    expect((await get(site.slug, "image.svg", "__artifact_image=1")).headers.get("content-type")).toContain("text/html");
  });

  it("pins keyed requests even when queries name another existing version", async () => {
    const site = await make();
    const key = await keyFor(site);
    const updated = await editSite(site.slug, { path: "styles.css", content: "body { color: blue; }" }, { actor: { kind: "legacy-token", userId: null, anonId: null }, method: "api", ip: null, userAgent: null });
    if (!updated || "conflict" in updated) throw new Error("Edit failed");
    for (const file of ["styles.css", "", "nested/client-route"]) {
      const response = await get(`${site.slug}~${key}`, file, `v=${updated.version.id}&share=anything&__artifact_version=${updated.version.id}&__artifact_share=anything`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(file === "styles.css" ? "color: red" : "<body>old</body>");
    }
    // An unkeyed resource query cannot select history either, even with a real version id.
    expect(await (await get(site.slug, "styles.css", `v=${site.currentVersionId}`)).text()).toContain("color: blue");
    const history = await get(site.slug, "", `v=${site.currentVersionId}`, { "x-edit-token": site.editToken });
    expect(history.status).toBe(200);
    expect(await history.text()).toContain("~v3.");
  });

  it("supports explicit resource version/share controls and preserves image mode through exchange", async () => {
    const site = await make();
    await updateSiteVisibility(site.id, "private");
    const { token, share } = await shareFor(site);
    const target = new URL(previewTarget(site.slug, site.currentVersionId, "image.svg", token), origin);
    const response = await get(site.slug, "image.svg", `${target.search.slice(1)}&v=cache&theme=dark`);
    expect(response.status).toBe(307);
    const location = response.headers.get("location")!;
    expect(location).not.toContain(token);
    expect(location).toContain("__artifact_image=1");
    expect(location).toContain("v=cache");
    expect(location).toContain("theme=dark");
    expect(location).not.toContain("__artifact_version");
    const url = new URL(location, origin);
    const segment = url.pathname.split("/")[3];
    const image = await get(segment, "image.svg", url.search.slice(1));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toContain("text/html");
    await revokeShare(share.id, Date.now());
    expect((await get(segment, "image.svg", "v=cache")).status).toBe(404);
    expect((await get(site.slug, "", `share=${token}`)).status).toBe(404);
  });

  it("keeps root share exchange and rejects invalid root versions", async () => {
    const site = await make();
    const { token } = await shareFor(site);
    const exchange = await get(site.slug, "", `share=${token}&v=${site.currentVersionId}&t=secret&theme=dark`);
    expect(exchange.status).toBe(307);
    const redirected = new URL(exchange.headers.get("location")!, origin);
    expect([...redirected.searchParams]).toEqual([["theme", "dark"]]);
    expect((await get(site.slug, "", "v=missing")).status).toBe(404);
    expect((await get(site.slug, "styles.css", "__artifact_version=missing")).status).toBe(404);
  });

  it("honors namespaced entry versions and gives them precedence over legacy controls", async () => {
    const site = await make();
    const updated = await editSite(site.slug, { path: "index.html", content: "<html><body>new</body></html>" }, { actor: { kind: "legacy-token", userId: null, anonId: null }, method: "api", ip: null, userAgent: null });
    if (!updated || "conflict" in updated) throw new Error("Edit failed");
    const target = new URL(previewTarget(site.slug, site.currentVersionId, ""), origin);
    for (const extra of ["", `&v=${updated.version.id}`]) {
      const response = await get(site.slug, "", target.search.slice(1) + extra, { "x-edit-token": site.editToken });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<body>old</body>");
    }
    expect((await get(site.slug, "", "__artifact_version=missing")).status).toBe(404);
    const other = await make();
    expect((await get(site.slug, "", `__artifact_version=${other.currentVersionId}`, { "x-edit-token": site.editToken })).status).toBe(404);
  });

  it("exchanges namespaced shares on the private entry URL", async () => {
    const site = await make();
    await updateSiteVisibility(site.id, "private");
    const { token } = await shareFor(site);
    const target = new URL(previewTarget(site.slug, site.currentVersionId, "", token), origin);
    const response = await get(site.slug, "", target.search.slice(1) + "&share=legacy-invalid&theme=dark");
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!, origin);
    expect(location.search).toBe("?theme=dark");
    expect(location.href).not.toContain(token);
    const document = await get(location.pathname.split("/")[3], "", location.search.slice(1));
    expect(document.status).toBe(200);
    expect(await document.text()).toContain("<body>old</body>");
  });

  it.each(["", "index.html"])("preserves raw artifact query spelling during share exchange for %s", async (file) => {
    const site = await make();
    const { token } = await shareFor(site);
    const artifactQuery = "flag&text=hello%20world&plus=a+b&slash=%2f&repeat=1&repeat=2&?share=artifact";
    const control = file ? "__artifact_share" : "share";
    // Encoded and duplicate control names must be stripped without reserializing other fields.
    const encodedControl = file ? "%5f%5fartifact_share" : "%73hare";
    const response = await get(site.slug, file, `${control}=${token}&${artifactQuery}&${encodedControl}=${token}`);
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!, origin).search).toBe(`?${artifactQuery}`);
  });

  it.each(["styles.css", "data.json", "index.html"])("does not wrap non-image %s in image mode", async (file) => {
    const site = await make();
    const normal = await get(site.slug, file);
    const imageMode = await get(site.slug, file, "__artifact_image=1");
    expect(imageMode.status).toBe(200);
    expect(imageMode.headers.get("content-type")).toBe(normal.headers.get("content-type"));
    expect(await imageMode.text()).toBe(await normal.text());
  });

  it("does not let resource queries bypass private access, expired keys, or foreign grants", async () => {
    const site = await make();
    const other = await make();
    await updateSiteVisibility(site.id, "private");
    expect((await get(site.slug, "styles.css", `v=cache&t=${site.editToken}`)).status).toBe(404);
    for (const key of [await keyFor(site, Date.now() - PREVIEW_KEY_TTL_MS - 1), await keyFor(other), "invalid"]) {
      expect((await get(`${site.slug}~${key}`, "styles.css", "v=cache")).status).toBe(404);
    }
  });
});

it("uses PDF.js only for PDF navigation, preserving bytes, downloads and ranges", async () => {
  const { site } = await createSite({ mode: "folder", files: [
    { relpath: "index.html", bytes: bytes('<a href="docs/报告.pdf">Read PDF</a>') },
    { relpath: "docs/报告.pdf", bytes: bytes("%PDF-1.4 fixture") },
  ] }, {});
  const segment = `${site.slug}~${await keyFor(site)}`;
  const nav = await get(segment, "docs/报告.pdf", "", { "sec-fetch-dest": "iframe" });
  expect(nav.headers.get("content-type")).toContain("text/html");
  expect(await nav.text()).toContain('id="doc-config"');
  expect(nav.headers.get("content-security-policy")).toContain("sandbox");
  expect(nav.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  const raw = await get(segment, "docs/报告.pdf");
  expect(raw.headers.get("content-type")).toBe("application/pdf");
  expect(await raw.text()).toBe("%PDF-1.4 fixture");
  expect(raw.headers.get("vary")).toContain("Sec-Fetch-Dest");
  const range = await get(segment, "docs/报告.pdf", "", { range: "bytes=0-3" });
  expect(range.status).toBe(206); expect(await range.text()).toBe("%PDF");
  const download = await get(segment, "docs/报告.pdf", "__artifact_download=1", { "sec-fetch-dest": "document" });
  expect(download.headers.get("content-disposition")).toContain("attachment");
  expect(await download.text()).toBe("%PDF-1.4 fixture");
  expect((await get(segment, "docs/missing.pdf", "", { "sec-fetch-dest": "iframe" })).status).toBe(404);
});
