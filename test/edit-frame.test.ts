// The delivery point for visual editing: the editor script is injected ONLY here and served ONLY
// to authorised visitors. The scope widened in this version — folder sites and pages that carry
// their own <script> can now enter visual editing (saving goes through text write-back and no
// longer assumes "post-run DOM == source"); these tests pin both what was opened up and the
// authorisation that did not loosen one bit.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET as editFrameGET } from "@/app/api/sites/[slug]/edit-frame/route";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";
import { closeDbForTests, listAudit } from "@/lib/db";
import { applyTextPatches, markEditableText, scanEditableText } from "@/lib/text-writeback";
import { createSite } from "@/lib/sites";
import { injectVisualEditor } from "@/lib/preview";
import { EDITOR_MARK, editorBootstrapScript } from "@/lib/editor-bootstrap";
import { NODE_ATTR, TEXTS_ATTR } from "@/lib/text-writeback";
import { folderFiles } from "./helpers";

const dirs: string[] = [];
beforeEach(() => { const d = mkdtempSync(join(tmpdir(), "ah-ef-")); dirs.push(d); process.env.ARTIFACT_DATA_DIR = d; });
afterEach(async () => { await closeDbForTests(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.ARTIFACT_DATA_DIR; });

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
function frameReq(slug: string, token?: string): Request {
  return new Request(`http://x/api/sites/${slug}/edit-frame`, { headers: token ? { "x-edit-token": token } : {} });
}
async function singleSite(html: string) {
  const { site } = await createSite({ mode: "file", filename: "index.html", bytes: new Uint8Array(Buffer.from(html, "utf8")) });
  return site;
}

describe("editorBootstrapScript", () => {
  it("is syntactically valid JS with the nonce substituted and the placeholder gone", () => {
    const s = editorBootstrapScript("nonce_abc");
    expect(() => new Function(s)).not.toThrow();
    expect(s).toContain("nonce_abc");
    expect(s).not.toContain("__NONCE__");
  });
});

describe("injectVisualEditor", () => {
  it("adds the editor script (tagged by its mark) alongside the normal bootstrap", () => {
    const out = injectVisualEditor("<html><head><title>t</title></head><body>hi</body></html>", "/api/preview/s/", "nonce_1");
    expect(out).toContain(`<script ${EDITOR_MARK}>`); // the editor script
    expect(out).toContain('<base href="/api/preview/s/">'); // relative resources still resolve (folder sites depend on it)
    expect(out).toContain("data-artifact-bootstrap"); // the storage shim is still there
  });
});

describe("GET /edit-frame", () => {
  it("403s an unauthorized viewer, with no script byte", async () => {
    const site = await singleSite("<html><head><title>A</title></head><body>hi</body></html>");
    const res = await editFrameGET(frameReq(site.slug), params(site.slug));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(EDITOR_MARK);
  });

  // The happy path must be tested too: in legacy mode the token IS the credential, and it must
  // travel in a header (never in ?t=). Testing only the 403 means CI stays green even if the whole
  // feature stops working for the real owner.
  it("serves the injected editor — plus the source-derived text markers — to a token-bearing owner", async () => {
    const site = await singleSite("<html><head><title>A</title></head><body><p>hi</p></body></html>");
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ah-editor-nonce")).toBeTruthy();
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.text();
    expect(body).toContain(EDITOR_MARK);
    expect(body).toContain(`<p ${NODE_ATTR}="`); // the locator marker landed on the body element
    expect(body).toContain(TEXTS_ATTR);
  });

  // The version must be echoed back: the source the parent page holds was rendered from some
  // version, and on a mismatch stale offsets must not be used to write the file.
  it("reports the version its markers were computed from", async () => {
    const site = await singleSite("<html><body><p>hi</p></body></html>");
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.headers.get("x-ah-editor-version")).toBe(site.currentVersionId);
  });

  // These two used to be 409 (has_script / not_single). With text write-back in place, exactly
  // these two kinds of site can use visual editing for the first time — the two sites a user
  // could not get past in practice belong here.
  it("now serves a page that carries its own script", async () => {
    const site = await singleSite("<html><head><style>p{color:red}</style></head><body><p>hi</p><script>var a = 1 < 2;</script></body></html>");
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<p ${NODE_ATTR}="`);
    expect(body).toContain("var a = 1 < 2;"); // the script is served verbatim, not polluted by markers
  });

  it("now serves a folder site (its entry HTML)", async () => {
    const { site } = await createSite({
      mode: "folder",
      files: folderFiles({ "index.html": "<html><body><h1>F</h1></body></html>", "assets/app.js": "console.log(1<2)" }),
    });
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`<h1 ${NODE_ATTR}="`);
    expect(body).toContain('<base href="/api/preview/'); // relative resources still go through the real multi-file preview
  });

  // The security of visual editing as a whole rests on "the injected bootstrap is the first script
  // to run": that positional advantage lets it register the message listener and snapshot the
  // primitives first, so that stopImmediatePropagation during the handshake keeps the artifact's
  // scripts away from the port. HTML5 allows a <script> before <html>/<head> (the browser treats it
  // as implicit head content and runs it first); such a script registers its listener first →
  // grabs the port handed over in the handshake → then impersonates the bootstrap and forges
  // patches into the user's source. So not a single byte of editor script is served here: a
  // straight 409 lets the front end degrade immediately and state the real reason, instead of
  // injecting and leaving the user staring at a spinner until the 8-second handshake timeout.
  it("409s (and ships no script) when the artifact's own <script> precedes <head>", async () => {
    const site = await singleSite(`<script>MessageEvent.prototype.__defineGetter__("ports",function(){return []})</script>\n<head></head><body><p>hi</p></body>`);
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("script_before_head");
  });

  it("409s the same way when a doctype/comment sits in front of that script", async () => {
    const site = await singleSite(`<!doctype html>\n<!-- x -->\n<script src="evil.js"></script><html><head></head><body><p>hi</p></body></html>`);
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("script_before_head");
  });

  // The negative side must be pinned too: normal artifacts (script inside head / inside body, a
  // "script" mentioned in a comment, no head at all) must not be caught by mistake.
  it("keeps serving pages whose scripts cannot outrun the bootstrap", async () => {
    for (const html of [
      `<!doctype html><html><head><script>var a=1</script></head><body><p>hi</p></body></html>`,
      `<html><head></head><body><p>hi</p><script>var a=1</script></body></html>`,
      `<!-- <script>骗人的</script> --><html><head></head><body><p>hi</p></body></html>`,
      `<script>var a=1</script><body><p>hi</p></body>`, // no head: the injection is prepended, so the bootstrap is still first
    ]) {
      const site = await singleSite(html);
      const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
      expect(res.status, html).toBe(200);
      expect(await res.text(), html).toContain(EDITOR_MARK);
    }
  });

  it("409s when the entry is not HTML (nothing to double-click)", async () => {
    const { site } = await createSite({ mode: "folder", files: folderFiles({ "index.html": "", "a.txt": "x" }) });
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("empty_entry");
  });
});

// One complete visual save: the marker indices served to the frame must match the indices
// recomputed on the ORIGINAL source at save time. One step off on either side and the user's edit
// lands somewhere else — the link in this design most likely to break silently.
describe("visual save — from served markers to source write-back", () => {
  const SRC = `<!doctype html>\n<html><head><style>h1{color:red}</style></head>\n<body>\n  <h1>旧标题</h1>\n  <p>正文 <b>重点</b> 收尾</p>\n  <script>var x = 1 < 2;</script>\n</body></html>\n`;

  it("the served el index is exactly the one the write-back side computes on the original source", async () => {
    const site = await singleSite(SRC);
    const res = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    const frame = await res.text();
    // Read the h1 marker out of the served page (this is how the bootstrap in the browser reads it)
    const el = Number(/<h1 data-ah-node="(\d+)"/.exec(frame)![1]);
    const out = applyTextPatches(SRC, [{ el, i: 0, before: "旧标题", text: "新标题" }]);
    expect(out.skipped).toHaveLength(0);
    expect(out.html).toBe(SRC.replace("旧标题", "新标题"));
    expect(out.html).toContain("var x = 1 < 2;"); // script untouched
    expect(markEditableText(out.html)).toContain(`data-ah-node="${el}"`); // index is stable, still recognised next round
  });

  // Locate (el, i) by CONTENT, not by guessing from keys() order — a wrong guess means `before`
  // does not match, the patch is skipped, and what gets POSTed is an untouched source: the case
  // would stay green forever and a total failure of applyTextPatches would go undetected.
  function locate(src: string, text: string): { el: number; i: number } {
    for (const [el, slot] of scanEditableText(src)) {
      const i = slot.texts.findIndex((t) => src.slice(t.start, t.end) === text);
      if (i >= 0) return { el, i };
    }
    throw new Error(`源码里没有内容为 ${JSON.stringify(text)} 的文本节点`);
  }

  it("the save endpoint re-authorises and records method=visual in the audit log", async () => {
    const site = await singleSite(SRC);
    const { el, i } = locate(SRC, "旧标题");
    const out = applyTextPatches(SRC, [{ el, i, before: "旧标题", text: "新标题" }]);
    const html = out.html;
    // Pin first that this save really carries a change; otherwise the 200 below proves only
    // authorisation, not write-back
    expect(out.applied).toHaveLength(1);
    expect(out.skipped).toHaveLength(0);
    expect(html).not.toBe(SRC);
    expect(html).toContain("<h1>新标题</h1>");

    // No credential → 403, and not a single audit row should be left behind
    const denied = await editPOST(new Request(`http://x/api/sites/${site.slug}/edit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: html, method: "visual" }),
    }), params(site.slug));
    expect(denied.status).toBe(403);
    expect(await listAudit(site.id)).toHaveLength(0); // a rejected save must leave no trace

    const ok = await editPOST(new Request(`http://x/api/sites/${site.slug}/edit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-edit-token": site.editToken },
      body: JSON.stringify({ content: html, method: "visual" }),
    }), params(site.slug));
    expect(ok.status).toBe(200);
    const rows = await listAudit(site.id);
    expect(rows.find((r) => r.action === "edit")).toMatchObject({ method: "visual" });

    // The change really hit disk: requesting the edit frame again already returns the new copy
    const again = await editFrameGET(frameReq(site.slug, site.editToken), params(site.slug));
    const served = await again.text();
    expect(served).toContain("新标题");
    expect(served).not.toContain("旧标题");
  });
});
