// Route-level tests: exercise the HTTP handlers directly (no server) with real Request objects,
// covering all four upload modes over both wire formats, list/get/edit/delete, serve, and auth.
import { afterEach, describe, expect, it } from "vitest";
import { GET as listGET, POST as sitesPOST } from "@/app/api/sites/route";
import { DELETE as itemDELETE, GET as itemGET } from "@/app/api/sites/[slug]/route";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";
import { GET as previewGET } from "@/app/api/preview/[slug]/[[...path]]/route";
import { makeZip } from "./helpers";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const previewParams = (slug: string, path?: string[]) => ({ params: Promise.resolve({ slug, path }) });

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api/sites", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function formRequest(form: FormData, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api/sites", { method: "POST", headers, body: form });
}

async function createPaste(html: string, title?: string) {
  const res = await sitesPOST(jsonRequest({ mode: "paste", html, title }));
  expect(res.status).toBe(200);
  return res.json() as Promise<{ slug: string; url: string; title: string; kind: string; editToken: string }>;
}

/** x-edit-token header carrying a site's edit token, for gated mutation routes. */
const withToken = (token: string): Record<string, string> => ({ "x-edit-token": token });

afterEach(() => {
  delete process.env.PUBLISH_API_TOKEN;
});

describe("POST /api/sites — upload, all modes, both wire formats", () => {
  it("json paste → 200 { slug, url, title, kind }", async () => {
    const body = await createPaste("<html><head><title>Pasted</title></head><body>hi</body></html>");
    expect(body.slug).toBeTruthy();
    expect(body.url).toBe(`/s/${body.slug}`);
    expect(body.title).toBe("Pasted");
    expect(body.kind).toBe("single");
  });

  it("json folder → folder site whose nav is browsable through the preview route", async () => {
    const res = await sitesPOST(jsonRequest({
      mode: "folder",
      files: [
        { path: "index.html", content: "<html><head><title>Home</title></head><body><a href='about.html'>about</a></body></html>" },
        { path: "about.html", content: "<html><head></head><body>about page</body></html>" },
        { path: "assets/app.js", content: "console.log('nested')" },
      ],
    }));
    expect(res.status).toBe(200);
    const { slug, kind } = await res.json();
    expect(kind).toBe("folder");

    const home = await previewGET(new Request(`http://test.local/api/preview/${slug}/`), previewParams(slug, undefined));
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("about.html");
    const about = await previewGET(new Request("http://x/"), previewParams(slug, ["about.html"]));
    expect(await about.text()).toContain("about page");
    const asset = await previewGET(new Request("http://x/"), previewParams(slug, ["assets", "app.js"]));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("nested");
  });

  it("json zip (base64) → folder site", async () => {
    const zip = makeZip({ "bundle/index.html": "<html><head><title>Zipped</title></head><body>z</body></html>", "bundle/app.css": "body{}" });
    const res = await sitesPOST(jsonRequest({ mode: "zip", base64: Buffer.from(zip).toString("base64") }));
    expect(res.status).toBe(200);
    const { slug, title, kind } = await res.json();
    expect(kind).toBe("folder");
    expect(title).toBe("Zipped");
    const asset = await previewGET(new Request("http://x/"), previewParams(slug, ["app.css"]));
    expect(asset.status).toBe(200);
  });

  it("multipart single .html file → single site", async () => {
    const form = new FormData();
    form.set("mode", "file");
    form.set("file", new File(["<html><head><title>Landing</title></head><body>x</body></html>"], "landing.html", { type: "text/html" }));
    const res = await sitesPOST(formRequest(form));
    expect(res.status).toBe(200);
    const { title, kind } = await res.json();
    expect(title).toBe("Landing");
    expect(kind).toBe("single");
  });

  it("multipart folder → relpath taken from each File's name", async () => {
    const form = new FormData();
    form.set("mode", "folder");
    form.append("files", new File(["<html><head><title>MP</title></head><body><a href='sub/page.html'>x</a></body></html>"], "index.html"));
    form.append("files", new File(["<h1>sub</h1>"], "sub/page.html"));
    const res = await sitesPOST(formRequest(form));
    expect(res.status).toBe(200);
    const { slug, kind } = await res.json();
    expect(kind).toBe("folder");
    const sub = await previewGET(new Request("http://x/"), previewParams(slug, ["sub", "page.html"]));
    expect(sub.status).toBe(200);
    expect(await sub.text()).toContain("sub");
  });

  it("multipart folder → positional `paths` field overrides file names", async () => {
    const form = new FormData();
    form.set("mode", "folder");
    form.append("files", new File(["<html><head><title>P</title></head><body>root</body></html>"], "blob"));
    form.append("paths", "index.html");
    const res = await sitesPOST(formRequest(form));
    expect(res.status).toBe(200);
    const { slug } = await res.json();
    const home = await previewGET(new Request("http://x/"), previewParams(slug, undefined));
    expect(await home.text()).toContain("root");
  });

  it("rejects a non-.html single file with 400", async () => {
    const res = await sitesPOST(jsonRequest({ mode: "file", filename: "app.js", content: "alert(1)" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.html/);
  });

  it("rejects an unknown mode with 400", async () => {
    const form = new FormData();
    form.set("mode", "nope");
    expect((await sitesPOST(formRequest(form))).status).toBe(400);
  });

  it("rejects an unsupported content-type with 400", async () => {
    const req = new Request("http://test.local/api/sites", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect((await sitesPOST(req)).status).toBe(400);
  });
});

describe("GET /api/sites — list", () => {
  it("returns my sites newest-first with kind/entry/versionCount", async () => {
    const a = await createPaste("<html><head><title>ListA</title></head><body>a</body></html>", "ListA");
    const res = await listGET();
    expect(res.status).toBe(200);
    const { sites } = await res.json();
    const mine = sites.find((s: { slug: string }) => s.slug === a.slug);
    expect(mine).toMatchObject({ title: "ListA", kind: "single", entry: "index.html", versionCount: 1 });
    expect(sites[0].slug).toBe(a.slug); // most recent activity first
  });
});

describe("GET /api/sites/:slug — viewer/editor data", () => {
  it("returns metadata, the file list, and the entry source", async () => {
    const created = await createPaste("<html><head><title>V</title></head><body>editable</body></html>");
    const res = await itemGET(new Request(`http://x/api/sites/${created.slug}`,{headers:withToken(created.editToken)}), params(created.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("single");
    expect(body.files).toEqual(["index.html"]);
    expect(body.file).toBe("index.html");
    expect(body.content).toContain("editable");
  });

  it("?file selects a folder file; a missing file → 404", async () => {
    const res = await sitesPOST(jsonRequest({
      mode: "folder",
      files: [{ path: "index.html", content: "<title>F</title>" }, { path: "about.html", content: "<h1>about-src</h1>" }],
    }));
    const { slug, editToken } = await res.json();
    const about = await itemGET(new Request(`http://x/api/sites/${slug}?file=about.html`,{headers:withToken(editToken)}), params(slug));
    expect(about.status).toBe(200);
    expect((await about.json()).content).toContain("about-src");
    const missing = await itemGET(new Request(`http://x/api/sites/${slug}?file=nope.html`,{headers:withToken(editToken)}), params(slug));
    expect(missing.status).toBe(404);
  });

  it("404s an unknown slug", async () => {
    const res = await itemGET(new Request("http://x/api/sites/nope"), params("nope"));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/sites/:slug/edit — new version", () => {
  it("single site: { content } replaces the doc and returns the new version url", async () => {
    const created = await createPaste("<html><head><title>E</title></head><body>one</body></html>");
    const res = await editPOST(
      new Request(`http://x/api/sites/${created.slug}/edit`, { method: "POST", headers: { "content-type": "application/json", ...withToken(created.editToken) }, body: JSON.stringify({ content: "<html><head><title>E</title></head><body>two</body></html>" }) }),
      params(created.slug),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe(`/s/${created.slug}`);
    expect(body.versionId).toBeTruthy();
    // the link now serves the edited content
    const served = await previewGET(new Request("http://x/"), previewParams(created.slug, undefined));
    expect(await served.text()).toContain("two");
  });

  it("folder site: { path, content } overwrites one file in a new version", async () => {
    const res = await sitesPOST(jsonRequest({ mode: "folder", files: [{ path: "index.html", content: "<title>Fld</title>" }, { path: "a.html", content: "v1" }] }));
    const { slug, editToken } = await res.json();
    const edited = await editPOST(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...withToken(editToken) }, body: JSON.stringify({ path: "a.html", content: "v2" }) }),
      params(slug),
    );
    expect(edited.status).toBe(200);
    const served = await previewGET(new Request("http://x/"), previewParams(slug, ["a.html"]));
    expect(await served.text()).toContain("v2");
  });

  it("folder edit without a path → 400 (wrong shape for kind)", async () => {
    const res = await sitesPOST(jsonRequest({ mode: "folder", files: [{ path: "index.html", content: "<title>W</title>" }] }));
    const { slug, editToken } = await res.json();
    const bad = await editPOST(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json", ...withToken(editToken) }, body: JSON.stringify({ content: "x" }) }),
      params(slug),
    );
    expect(bad.status).toBe(400);
  });

  it("editing an unknown slug → 404", async () => {
    const res = await editPOST(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "x" }) }),
      params("nope"),
    );
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/sites/:slug", () => {
  it("deletes the site, then the link 404s and delete-again → 404", async () => {
    const created = await createPaste("<html><head><title>D</title></head><body>bye</body></html>");
    const del = await itemDELETE(new Request("http://x/", { method: "DELETE", headers: withToken(created.editToken) }), params(created.slug));
    expect(del.status).toBe(200);
    expect((await del.json()).deleted).toBe(true);

    const served = await previewGET(new Request("http://x/"), previewParams(created.slug, undefined));
    expect(served.status).toBe(404);
    const again = await itemDELETE(new Request("http://x/", { method: "DELETE" }), params(created.slug));
    expect(again.status).toBe(404);
  });
});

describe("auth gate — create needs the Bearer token when PUBLISH_API_TOKEN is set; edits gate per-site", () => {
  it("401s create without the token, 200s with it; edit/delete 403 without a per-site token; admin Bearer overrides; GET stays open", async () => {
    // First create a site while auth is still open, to edit/delete under auth below.
    const created = await createPaste("<html><head><title>Auth</title></head><body>x</body></html>");

    process.env.PUBLISH_API_TOKEN = "s3cret";
    const noAuth = await sitesPOST(jsonRequest({ mode: "paste", html: "<body>y</body>" }));
    expect(noAuth.status).toBe(401);

    const withAuth = await sitesPOST(jsonRequest({ mode: "paste", html: "<body>y</body>" }, { authorization: "Bearer s3cret" }));
    expect(withAuth.status).toBe(200);

    // GET endpoints ignore the gate.
    expect((await listGET()).status).toBe(200);

    // edit + delete are per-site gated: no token (and no admin Bearer) → 403, not 401.
    const editNoAuth = await editPOST(
      new Request("http://x/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "z" }) }),
      params(created.slug),
    );
    expect(editNoAuth.status).toBe(403);
    const delNoAuth = await itemDELETE(new Request("http://x/", { method: "DELETE" }), params(created.slug));
    expect(delNoAuth.status).toBe(403);
    // The global PUBLISH_API_TOKEN acts as an admin override on the per-site gate.
    const delAuth = await itemDELETE(new Request("http://x/", { method: "DELETE", headers: { authorization: "Bearer s3cret" } }), params(created.slug));
    expect(delAuth.status).toBe(200);
  });
});
