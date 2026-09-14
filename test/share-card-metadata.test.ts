// The link preview a READER gets. The bug this pins: /s/[slug] set only a title, so Next merged the
// root layout's description down into it — the platform's own tagline, written for whoever is
// publishing. Someone shared a quarterly report and the card underneath it explained how to drag
// .zip files in. Nothing reader-facing may inherit that copy.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { extractDescription } from "@/lib/upload";
import { platformCopy as rootMetadata } from "@/app/layout";
import { generateMetadata } from "@/app/s/[slug]/page";

// generateMetadata resolves this deployment's origin, which needs a request scope Next only provides
// while serving. The origin itself is covered by resolvePublicBase's own tests; here it just has to
// exist so the page can be exercised at all.
// `cookies` too: the page's copy is resolved through getT(), which reads the locale cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "artifacts.example.net" }),
  cookies: async () => ({ get: () => undefined }),
}));

const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "sharecard-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = "https://artifacts.example.net";
  // These tests are about metadata rendering, not visibility. A new site's default visibility now
  // follows the deployment (see config.defaultVisibility), and the public URL above would push the
  // default to private — a stranger would not even get the title, and there would be nothing left
  // to test. Pin the posture so an unrelated default cannot decide this group of assertions.
  process.env.ARTIFACT_DEFAULT_VISIBILITY = "public";
});
afterEach(async () => {
  await closeDbForTests();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.ARTIFACT_PUBLIC_URL;
  delete process.env.ARTIFACT_DEFAULT_VISIBILITY;
});

const meta = (slug: string) => generateMetadata({ params: Promise.resolve({ slug }) });
const publish = async (html: string) => (await createSite({ mode: "paste", html }, {})).site;

describe("extractDescription", () => {
  it("reads a plain meta description", () => {
    expect(extractDescription('<meta name="description" content="季度经营分析">')).toBe("季度经营分析");
  });

  it("does not care about attribute order", () => {
    expect(extractDescription('<meta content="倒着写的" name="description">')).toBe("倒着写的");
  });

  it("accepts single quotes and og:description", () => {
    expect(extractDescription("<meta name='description' content='单引号'>")).toBe("单引号");
    expect(extractDescription('<meta property="og:description" content="OG 版">')).toBe("OG 版");
  });

  it("collapses whitespace and ignores an empty one", () => {
    expect(extractDescription('<meta name="description" content="  多   空格 ">')).toBe("多 空格");
    expect(extractDescription('<meta name="description" content="   ">')).toBeNull();
  });

  it("returns null when the document says nothing about itself", () => {
    expect(extractDescription("<html><head><title>只有标题</title></head></html>")).toBeNull();
    // A description belonging to something else entirely must not be picked up.
    expect(extractDescription('<meta name="author" content="张三">')).toBeNull();
  });
});

describe("GET /s/[slug] metadata", () => {
  it("uses the artifact's own description, not the platform's", async () => {
    const site = await publish(
      '<html><head><title>Acme Quarterly Review</title>'
      + '<meta name="description" content="2026 上半年企业 RSI 指标复盘"></head><body>x</body></html>',
    );
    const m = await meta(site.slug);

    expect(m.title).toBe("Acme Quarterly Review — artifact-site");
    expect(m.description).toBe("2026 上半年企业 RSI 指标复盘");
    // og:/twitter: descriptions are left unset so Next derives them from the resolved top-level
    // one — asserted end-to-end on the rendered HTML, which is the only place the merge is visible.
    expect(m.openGraph?.description).toBeUndefined();
  });

  // The whole point, and the subtle part: Next MERGES with the parent layout, so an ABSENT
  // description means "inherit the platform tagline" — exactly the bug. Only an explicit null
  // removes it. Assert on null, not on undefined: `toBeUndefined()` passes for the broken version
  // too, which is how the first cut of this fix shipped a still-leaking card past a green suite.
  it("NEVER falls back to the platform tagline", async () => {
    const site = await publish("<html><head><title>没写描述的产物</title></head><body>x</body></html>");
    const m = await meta(site.slug);

    expect(m.description).toBeNull();               // silent beats borrowed
    expect(m.description).not.toBeUndefined();      // undefined would mean "inherit"
    expect(JSON.stringify(m)).not.toContain(rootMetadata.description);
  });

  it("emits Open Graph + canonical so the card renders as a card", async () => {
    const site = await publish("<html><head><title>看板</title></head><body>x</body></html>");
    const m = await meta(site.slug);
    const url = `https://artifacts.example.net/s/${site.slug}`;

    expect(m.openGraph?.title).toBe("看板 — artifact-site");
    expect(m.openGraph).toMatchObject({ type: "article", siteName: "artifact-site", url });
    expect(m.alternates?.canonical).toBe(url);
  });

  it("still renders a card when the entry cannot be read", async () => {
    const site = await publish("<html><head><title>会被弄坏的</title></head><body>x</body></html>");
    rmSync(process.env.ARTIFACT_DATA_DIR!, { recursive: true, force: true }); // storage yanked away
    const m = await meta(site.slug);

    expect(m.title).toBe("会被弄坏的 — artifact-site"); // title comes from the DB, so the card survives
    expect(m.description).toBeNull();
  });

  it("404s with a plain title for an unknown slug", async () => {
    expect((await meta("no-such-slug")).title).toBe("Site not found — artifact-site");
  });
});

// A dead share link is still a reader-facing page. Reaching it goes through notFound(), which swaps
// in the not-found boundary — so generateMetadata's own 404 branch is DISCARDED and the boundary
// inherits the root layout's description instead. Verified by serving it: adding `description: null`
// to that branch changed the rendered output not at all. The metadata has to live on the boundary.
describe("not-found boundary", () => {
  it("carries its own title and kills the inherited description", async () => {
    const metadata = await (await import("@/app/not-found")).generateMetadata();
    expect(metadata.title).toBe("Site not found — artifact-site");
    expect(metadata.description).toBeNull();      // null, not absent — absent means inherit
    expect(metadata.description).not.toBeUndefined();
    expect(JSON.stringify(metadata)).not.toContain(rootMetadata.description);
  });
});
