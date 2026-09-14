// Rename — rename a site's display title (metadata only; slug never changes). Covers the lib verb
// (trim, non-empty, length cap) and the PATCH /api/sites/:slug route.
import { describe, expect, it } from "vitest";
import { createSite, getSiteView, renameSite } from "@/lib/sites";
import { PATCH as itemPATCH } from "@/app/api/sites/[slug]/route";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const patchReq = (title: unknown, token?: string) =>
  new Request("http://x/", {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(token ? { "x-edit-token": token } : {}) },
    body: JSON.stringify({ title }),
  });

describe("rename — updates the display title only", () => {
  it("trims and sets the title while leaving the slug untouched", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>Before</title><body>x</body>" });
    const renamed = (await renameSite(site.slug, "  新标题  "));
    expect(renamed).not.toBeNull();
    expect(renamed!.title).toBe("新标题");
    expect(renamed!.slug).toBe(site.slug);
    expect((await getSiteView(site.slug))!.site.title).toBe("新标题");
  });

  it("rejects an empty / whitespace-only title", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>X</title><body>x</body>" });
    await expect(renameSite(site.slug, "   ")).rejects.toThrow();
  });

  it("rejects an over-long title (>120 chars)", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>X</title><body>x</body>" });
    await expect(renameSite(site.slug, "a".repeat(121))).rejects.toThrow();
  });

  it("renaming an unknown slug returns null", async () => {
    expect(await renameSite("no-such-slug", "x")).toBeNull();
  });

  it("PATCH /api/sites/:slug { title } → { slug, title }; empty → 400; unknown → 404; no token → 403", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>PatchMe</title><body>x</body>" });
    const ok = await itemPATCH(patchReq("重命名后", site.editToken), params(site.slug));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ slug: site.slug, title: "重命名后" });

    const empty = await itemPATCH(patchReq("   ", site.editToken), params(site.slug));
    expect(empty.status).toBe(400);

    const missing = await itemPATCH(patchReq("whatever", site.editToken), params("nope"));
    expect(missing.status).toBe(404);

    const noToken = await itemPATCH(patchReq("重命名后"), params(site.slug));
    expect(noToken.status).toBe(403);
  });
});
