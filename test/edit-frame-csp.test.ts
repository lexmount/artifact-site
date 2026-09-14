// A7: the edit frame must be constrained by CSP_CONNECT_SRC.
//
// The editing surface is fetched by the parent page and stuffed into an iframe as srcDoc — and a
// srcDoc document **does not inherit the CSP from the response headers**, so the route's
// content-security-policy header does nothing for the document actually rendered. The preview path
// wraps artifacts in a connect-src allowlist via composePreviewCsp; without an equivalent on the edit
// frame, clicking "Edit visually" would hand a scripted artifact a way around the egress limits. This
// file pins that <meta>.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as editFrameGET } from "@/app/api/sites/[slug]/edit-frame/route";
import { withConnectSrcMeta } from "@/lib/preview";
import { closeDbForTests } from "@/lib/db";
import { createSite } from "@/lib/sites";
import { EDITOR_MARK } from "@/lib/editor-bootstrap";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "ah-efcsp-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
  delete process.env.CSP_CONNECT_SRC;
});

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const frameReq = (slug: string, token: string) =>
  new Request(`http://x/api/sites/${slug}/edit-frame`, { headers: { "x-edit-token": token } });

const HTML = "<html><head><title>t</title></head><body><p>hi</p></body></html>";

describe("withConnectSrcMeta", () => {
  it("adds no meta when no allowlist is configured (consistent with preview: unrestricted)", () => {
    expect(withConnectSrcMeta(HTML, [])).toBe(HTML);
    expect(withConnectSrcMeta(HTML, ["", "   "])).toBe(HTML);
  });

  it("inserts the meta right after <head>, as early as possible", () => {
    const out = withConnectSrcMeta(HTML, ["https://api.example.com", "wss://rt.example.com"]);
    expect(out).toContain('<head><meta http-equiv="Content-Security-Policy" content="connect-src https://api.example.com wss://rt.example.com">');
  });

  it("a document without <head> still gets it", () => {
    const out = withConnectSrcMeta("<p>bare</p>", ["'self'"]);
    expect(out.startsWith('<meta http-equiv="Content-Security-Policy" content="connect-src \'self\'">')).toBe(true);
  });

  it("writes only connect-src — adding default-src would ban the injected inline bootstrap as well", () => {
    const out = withConnectSrcMeta(HTML, ["https://a.example.com"]);
    expect(out).not.toContain("default-src");
    expect(out).not.toContain("script-src");
  });

  it("drops any source containing quotes or angle brackets — it goes into an HTML attribute and must not become an injection point", () => {
    const out = withConnectSrcMeta(HTML, ['https://ok.example.com', 'x"><script>alert(1)</script>']);
    expect(out).toContain('content="connect-src https://ok.example.com"');
    expect(out).not.toContain("alert(1)");
    expect(out).not.toContain("<script>alert");
  });

  it("an allowlist with no valid entry falls back to 'none' (block all) rather than counting as unconfigured", () => {
    const out = withConnectSrcMeta(HTML, ['bad"source', "<evil>"]);
    expect(out).toContain(`content="connect-src 'none'"`);
  });
});

describe("egress limits on GET /edit-frame", () => {
  it("with CSP_CONNECT_SRC configured, the served editing surface carries an equivalent connect-src meta", async () => {
    process.env.CSP_CONNECT_SRC = "https://api.example.com, https://cdn.example.com";
    const { site } = await createSite({ mode: "file", filename: "index.html", bytes: new Uint8Array(Buffer.from(HTML, "utf8")) });
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('content="connect-src https://api.example.com https://cdn.example.com"');
    expect(body).toContain(EDITOR_MARK); // the meta did not block the editor script
    // The meta must precede the injected bootstrap, or the script could start sending requests first.
    expect(body.indexOf("Content-Security-Policy")).toBeLessThan(body.indexOf(EDITOR_MARK));
  });

  it("adds no meta at all when unconfigured", async () => {
    const { site } = await createSite({ mode: "file", filename: "index.html", bytes: new Uint8Array(Buffer.from(HTML, "utf8")) });
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    const body = await res.text();
    expect(body).not.toContain("http-equiv");
  });
});
