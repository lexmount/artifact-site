import { describe, expect, it } from "vitest";
import { createSite, editSite, listSites } from "@/lib/sites";
import { testAudit } from "./helpers";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("list — my sites, newest activity first", () => {
  it("orders by most-recent activity and reports kind, entry, and version count", async () => {
    const a = await createSite({ mode: "paste", html: "<html><head><title>Alpha</title></head><body>a</body></html>" });
    await wait(5);
    const b = await createSite({ mode: "folder", files: [{ relpath: "index.html", bytes: new Uint8Array(Buffer.from("<title>Beta</title>", "utf8")) }] });
    await wait(5);
    const c = await createSite({ mode: "paste", html: "<html><head><title>Gamma</title></head><body>c</body></html>" });

    const initial = (await listSites()).filter((s) => [a, b, c].some((x) => x.site.slug === s.slug));
    expect(initial.map((s) => s.title)).toEqual(["Gamma", "Beta", "Alpha"]);
    const alpha = initial.find((s) => s.slug === a.site.slug)!;
    expect(alpha.kind).toBe("single");
    expect(alpha.entry).toBe("index.html");
    expect(alpha.versionCount).toBe(1);
    expect(initial.find((s) => s.slug === b.site.slug)!.kind).toBe("folder");

    // Editing Alpha bumps its updated_at (it jumps to the front) and grows its version count.
    await wait(5);
    await editSite(a.site.slug, { content: "<html><head><title>Alpha</title></head><body>a2</body></html>" }, testAudit());
    const after = (await listSites()).filter((s) => [a, b, c].some((x) => x.site.slug === s.slug));
    expect(after[0].slug).toBe(a.site.slug);
    expect(after[0].versionCount).toBe(2);
  });
});
