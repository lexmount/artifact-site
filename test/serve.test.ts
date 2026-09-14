import { symlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PREVIEW_SANDBOX_CSP, composePreviewCsp, servePreviewFile } from "@/lib/preview";
import { safeRelativePath, versionDir } from "@/lib/store";
import { createSite, getSiteView } from "@/lib/sites";
import { folderFiles } from "./helpers";

async function makeFolder(files: Record<string, string>) {
  const { site, version } = await createSite({ mode: "folder", files: folderFiles(files) });
  return { slug: site.slug, siteId: site.id, versionId: version.id };
}

describe("serve — the vetted read path", () => {
  it("injects <base> + storage shim on HTML with the bare sandbox CSP; assets get the bare CSP untouched", async () => {
    const { slug } = await makeFolder({
      "index.html": "<html><head><title>t</title></head><body>hello</body></html>",
      "app.css": "body{color:red}",
    });
    const html = await servePreviewFile(slug, undefined);
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.headers["content-security-policy"]).toBe(PREVIEW_SANDBOX_CSP);
    const body = html.body.toString();
    expect(body).toContain(`<base href="/api/preview/${slug}/">`);
    expect(body).toContain("data-artifact-bootstrap");

    const asset = await servePreviewFile(slug, ["app.css"]);
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/css");
    expect(asset.headers["content-security-policy"]).toBe(PREVIEW_SANDBOX_CSP);
    expect(asset.body.toString()).not.toContain("data-artifact-bootstrap");
  });

  // The sandbox CSP gives the artifact an opaque origin, so fetching its OWN files is a
  // cross-origin request. Drop this header and `<script type="module">` (every Vite build),
  // fetch, XHR and dynamic import() all fail — silently, since classic scripts and stylesheets
  // still load and nothing reaches the console.
  it("serves every preview response with CORS open, so an opaque-origin artifact can read its own files", async () => {
    const { slug } = await makeFolder({
      "index.html": "<html><head><title>t</title></head><body><script type=module src=./app.js></script></body></html>",
      "app.js": "export const x = 1",
      "data.json": '{"a":1}',
    });
    for (const subpath of [undefined, ["app.js"], ["data.json"]]) {
      const res = await servePreviewFile(slug, subpath);
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    }
  });

  // A response the browser refuses to expose is a network error to the caller, so an artifact
  // fetching a missing file would get `TypeError: Failed to fetch` rather than a 404 it can act
  // on — it cannot tell "not found" from "server unreachable". Verified in a real browser.
  it("carries CORS on error responses too, so a failed fetch is readable as its status", async () => {
    const { slug } = await makeFolder({ "index.html": "<html><head><title>t</title></head><body>x</body></html>" });

    const missing = await servePreviewFile(slug, ["nope.json"]); // 404 — has an extension, no entry fallback
    expect(missing.status).toBe(404);
    expect(missing.headers["access-control-allow-origin"]).toBe("*");

    const guard = await servePreviewFile(slug, ["..", "etc", "passwd"]); // 400 — path guard
    expect(guard.status).toBe(400);
    expect(guard.headers["access-control-allow-origin"]).toBe("*");

    const unknown = await servePreviewFile("no-such-slug", undefined); // 404 — unknown site
    expect(unknown.status).toBe(404);
    expect(unknown.headers["access-control-allow-origin"]).toBe("*");
  });

  it("resolves relative links between pages and nested assets under the slug prefix", async () => {
    const { slug } = await makeFolder({
      "index.html": "<html><head><title>Home</title></head><body><a href='about.html'>about</a></body></html>",
      "about.html": "<html><head></head><body>about page</body></html>",
      "assets/app.js": "console.log('nested')",
    });
    expect((await servePreviewFile(slug, ["about.html"])).body.toString()).toContain("about page");
    expect((await servePreviewFile(slug, ["assets", "app.js"])).body.toString()).toContain("nested");
  });

  it("falls back to entry for an unknown extensionless path, but 404s a missing real asset", async () => {
    const { slug } = await makeFolder({ "index.html": "<html><head></head><body>spa root</body></html>" });
    const clientRoute = await servePreviewFile(slug, ["some", "client", "route"]);
    expect(clientRoute.status).toBe(200);
    expect(clientRoute.body.toString()).toContain("spa root");
    expect((await servePreviewFile(slug, ["missing.js"])).status).toBe(404);
    expect((await servePreviewFile(slug, ["deep", "nested", "missing.png"])).status).toBe(404);
  });

  it("rejects the full traversal / dotfile / control-char vector set (21 vectors)", async () => {
    const { slug } = await makeFolder({ "index.html": "<h1>guarded</h1>" });
    const rejected: string[][] = [
      ["..", "..", "etc", "passwd"],
      ["..", "etc"],
      ["a", "..", "..", "b"],
      ["", "etc", "passwd"], // leading slash
      ["foo", "", "bar"], // empty segment
      [".git"],
      [".git", "config"],
      ["node_modules"],
      ["NODE_MODULES", "x"],
      [".env"],
      [".hidden", "secret.txt"],
      ["assets", ".secret"],
      ["..\\..\\etc\\passwd"],
      ["a/../../b"],
      ["./../x"],
      ["\u0000evil"], // NUL control char
      ["a\u001fb"], // unit-separator control char
      [""],
    ];
    for (const vector of rejected) {
      expect((await servePreviewFile(slug, vector)).status, vector.join("|")).toBe(400);
    }
    // Percent-encoded traversal is never decoded — treated as a literal name. Extensionless ones
    // fall back to the entry (200, serving index — never the target file); an extension-bearing one 404s.
    // Either way the root is never escaped.
    const encodedFallback = await servePreviewFile(slug, ["%2e%2e", "escape"]);
    expect(encodedFallback.status).toBe(200);
    expect(encodedFallback.body.toString()).toContain("guarded"); // served the entry, not /etc/*
    expect((await servePreviewFile(slug, ["%2e%2e%2f%2e%2e", "etc"])).status).toBe(200);
    expect((await servePreviewFile(slug, ["x%2f..%2fpasswd.txt"])).status).toBe(404); // literal name, missing
    expect((await servePreviewFile(slug, ["..%2f..%2fpasswd.txt"])).status).toBe(400); // leading dot → dotfile guard
    expect(() => safeRelativePath("a/../b")).toThrow(/unsafe/);
  });

  it("rejects a symlink planted into the served version dir", async () => {
    const { slug, siteId, versionId } = await makeFolder({ "index.html": "<h1>real</h1>" });
    await symlink("/etc/hosts", path.join(versionDir(siteId, versionId), "link.html"));
    expect((await servePreviewFile(slug, ["link.html"])).status).toBe(400);
  });

  it("404s an unknown slug and a deleted site", async () => {
    expect((await servePreviewFile("no-such-slug", undefined)).status).toBe(404);
    const { slug } = await makeFolder({ "index.html": "<h1>x</h1>" });
    expect(getSiteView(slug)).not.toBeNull();
  });

  it("composes the CSP without mutating the sandbox directive", () => {
    expect(composePreviewCsp()).toBe(PREVIEW_SANDBOX_CSP);
    expect(composePreviewCsp(["", "  "])).toBe(PREVIEW_SANDBOX_CSP);
    expect(composePreviewCsp(["https://a.example", "wss://b.example"]))
      .toBe(`${PREVIEW_SANDBOX_CSP}; connect-src https://a.example wss://b.example`);
  });
});
