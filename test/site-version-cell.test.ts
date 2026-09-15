import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SiteVersionCell from "@/components/site-version-cell";
import type { SiteSummary } from "@/lib/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const site: SiteSummary = { slug: "report", title: "Report", kind: "single", entry: "index.html", versionCount: 3, createdAt: 1, updatedAt: 2, officialVersionId: "version-two", officialVersionNumber: 2 };

describe("read-only version cell", () => {
  it("keeps a direct link to the official snapshot without management controls", () => {
    const html = renderToStaticMarkup(createElement(SiteVersionCell, { site, canManage: false }));
    expect(html).toContain('href="/s/report?version=version-two"');
    expect(html).toContain("Official v2");
    expect(html).toContain("3 versions total");
    expect(html).not.toContain("<button");
  });
  it("does not invent a snapshot link when there is no official version", () => {
    const html = renderToStaticMarkup(createElement(SiteVersionCell, { site: { ...site, officialVersionId: null, officialVersionNumber: null }, canManage: false }));
    expect(html).toContain("No official version");
    expect(html).not.toContain("href=");
  });
});
