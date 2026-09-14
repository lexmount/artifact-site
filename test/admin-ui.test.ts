// The administration console's page-level contracts, pinned at the source level (the repo has no
// DOM test runner): the gate sits in the layout, the menu entry is admin-only, the take-down
// surfaces exist on the site page, the share page and the site cards — and every string the
// console shows has a Chinese entry, so the UI never falls back to English mid-screen.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zhCN } from "@/locales/zh-CN";

const abs = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".tsx") || p.endsWith(".ts") ? [p] : [];
  });
}

describe("/admin gate and entry", () => {
  it("the layout resolves the administrator server-side and answers notFound() to everyone else", () => {
    const layout = read("src/app/admin/layout.tsx");
    expect(layout).toContain("resolveAdmin(request)");
    expect(layout).toContain("notFound()");
    expect(layout.indexOf("notFound()")).toBeLessThan(layout.indexOf("<AppShell"));
  });
  it("the account menu shows Administration only when /api/auth/me says isAdmin", () => {
    const menu = read("src/components/auth-button.tsx");
    expect(menu).toMatch(/\{isAdmin && \([\s\S]*href="\/admin"/);
    expect(read("src/lib/use-auth.ts")).toContain("isAdmin: Boolean(body.isAdmin)");
  });
  it("every console view is a client page under the gated layout", () => {
    for (const page of ["page", "users/page", "sites/page", "settings/page", "system/page"]) {
      expect(read(`src/app/admin/${page}.tsx`).startsWith('"use client"')).toBe(true);
    }
  });
});

describe("take-down surfaces outside the console", () => {
  it("the site page answers a taken-down site with the removal notice before the 404 branch, and hands the owner the reason", () => {
    const page = read("src/app/s/[slug]/page.tsx");
    const removed = page.indexOf("if (!readable && view.site.takenDownAt) return removedNotice");
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(page.indexOf("if (!readable) notFound();"));
    expect(page).toContain("takenDownReason={view.site.takenDownAt ? (view.site.takenDownReason ?? \"\") : null}");
  });
  it("the share page checks the read gate for a taken-down site instead of embedding a 410 frame", () => {
    const page = read("src/app/v/[token]/page.tsx");
    expect(page).toContain("if (target.site.takenDownAt && !(await canReadSite(request, target.site, session))) return removed(t);");
  });
  it("the viewer shows the owner a notice and the list rows say so", () => {
    expect(read("src/components/site-viewer.tsx")).toContain('className="fs-notice"');
    expect(read("src/components/my-sites.tsx")).toContain('s.takenDownAt ? ` · ${t("Taken down")}` : ""');
  });
});

describe("every console string has a Chinese translation", () => {
  const files = [
    ...walk(abs("src/app/admin")),
    ...walk(abs("src/components/admin")),
    abs("src/components/auth-button.tsx"),
    abs("src/app/s/[slug]/page.tsx"),
    abs("src/app/v/[token]/page.tsx"),
    abs("src/components/site-viewer.tsx"),
    abs("src/components/admin-activity.tsx"),
    abs("src/components/my-sites.tsx"),
  ];
  it("no t(\"…\") literal in the console or the take-down surfaces is missing from zh-CN", () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
        const key = m[1].replace(/\\"/g, '"');
        if (!(key in zhCN)) missing.push(`${file.slice(file.indexOf("src/"))}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
  it("the settings page's labels, help texts and option names resolve too (they go through t(variable))", () => {
    const page = read("src/app/admin/settings/page.tsx");
    const strings = new Set<string>();
    for (const m of page.matchAll(/(?:label|help): "([^"]+)"/g)) strings.add(m[1]);
    const options = page.match(/const OPTION_LABELS[^=]*=\s*\{([^}]*)\}/);
    for (const m of (options?.[1] ?? "").matchAll(/:\s*"([^"]+)"/g)) strings.add(m[1]);
    expect(strings.size).toBeGreaterThan(20);
    expect([...strings].filter((s) => !(s in zhCN))).toEqual([]);
  });
  it("the action-log labels and the nav / state labels resolve too (they go through t(variable))", () => {
    const labels = ["An administrator opened this site", "Taken down by an administrator", "Restored by an administrator", "Deleted by an administrator", "Deleted site restored by an administrator",
      "Disabled account", "Re-enabled account", "Took site down", "Restored site", "Deleted site", "Restored deleted site",
      "Purged deleted sites", "Swept upload sessions", "Reconciled storage", "Expired anonymous sites", "Changed settings", "Overview", "Users", "Sites", "Settings", "System", "Live", "Taken down", "Deleted", "Public", "Private", "Unlisted"];
    expect(labels.filter((l) => !(l in zhCN))).toEqual([]);
  });
});
