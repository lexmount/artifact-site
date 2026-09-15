// Save as new site — fork/duplicate into an independent site. Covers the lib verb (independence,
// single-version fork, title suffix), the POST /api/sites/:slug/fork route, and — the part that
// regressed — who the copy actually belongs to afterwards.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbForTests, getSiteBySlug, listAudit, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { createSite, editSite, forkSite, getSiteView, listVersions } from "@/lib/sites";
import { POST as forkPOST } from "@/app/api/sites/[slug]/fork/route";
import { DELETE as itemDELETE } from "@/app/api/sites/[slug]/route";
import { POST as editPOST } from "@/app/api/sites/[slug]/edit/route";
import { folderFiles, readVersionFile, testAudit} from "./helpers";

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("fork — \"Save as new site\" duplicates into an independent site", () => {
  it("creates a new site+slug from the current tree, starts at v1, appends (copy) to the title", async () => {
    const source = await createSite({
      mode: "folder",
      files: folderFiles({ "index.html": "<title>Orig</title><body>home</body>", "about.html": "<h1>about orig</h1>" }),
    });

    const forked = await forkSite(source.site.slug, {});
    expect(forked).not.toBeNull();
    expect(forked!.site.slug).not.toBe(source.site.slug);
    expect(forked!.site.id).not.toBe(source.site.id);
    expect(forked!.site.title).toBe("Orig (copy)");
    expect(forked!.site.kind).toBe("folder");
    expect(forked!.version.source).toBe("fork");

    // The fork does NOT copy history — it starts at exactly one version.
    expect((await listVersions(forked!.site.slug))!.length).toBe(1);
    // …whose files are a real copy of the source's current tree.
    expect(await readVersionFile(forked!.site.id, forked!.version.id, "about.html")).toContain("about orig");
  });

  it("editing the fork does not change the original, and editing the original does not change the fork", async () => {
    const source = await createSite({
      mode: "folder",
      files: folderFiles({ "index.html": "<title>Base</title>", "page.html": "<p>base page</p>" }),
    });
    const forked = await forkSite(source.site.slug, {});

    // Edit the fork → only the fork moves.
    await editSite(forked!.site.slug, { path: "page.html", content: "<p>fork edited</p>" }, testAudit());
    const origView1 = (await getSiteView(source.site.slug))!;
    const forkView1 = (await getSiteView(forked!.site.slug))!;
    expect(await readVersionFile(origView1.site.id, origView1.version.id, "page.html")).toContain("base page");
    expect(await readVersionFile(forkView1.site.id, forkView1.version.id, "page.html")).toContain("fork edited");

    // Edit the original → the fork stays as it was.
    await editSite(source.site.slug, { path: "page.html", content: "<p>orig edited</p>" }, testAudit());
    const forkView2 = (await getSiteView(forked!.site.slug))!;
    expect(await readVersionFile(forkView2.site.id, forkView2.version.id, "page.html")).toContain("fork edited");
  });

  it("forks a single-file (paste) site too", async () => {
    const source = await createSite({ mode: "paste", html: "<title>Solo</title><body>hi</body>" });
    const forked = await forkSite(source.site.slug, {});
    expect(forked!.site.kind).toBe("single");
    expect(forked!.site.title).toBe("Solo (copy)");
    expect(await readVersionFile(forked!.site.id, forked!.version.id, "index.html")).toContain("hi");
  });

  it("forking an unknown slug returns null", async () => {
    expect(await forkSite("no-such-slug", {})).toBeNull();
  });

  it("POST /api/sites/:slug/fork → { slug, url, title, kind } for a NEW slug; unknown → 404", async () => {
    const source = await createSite({ mode: "paste", html: "<title>Route</title><body>x</body>" });
    const res = await forkPOST(new Request("http://x/", { method: "POST",headers:{"x-edit-token":source.site.editToken} }), params(source.site.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBeTruthy();
    expect(body.slug).not.toBe(source.site.slug);
    expect(body.url).toBe(`/s/${body.slug}`);
    expect(body.title).toBe("Route (copy)");
    expect(body.kind).toBe("single");

    const missing = await forkPOST(new Request("http://x/", { method: "POST",headers:{"x-edit-token":source.site.editToken} }), params("nope"));
    expect(missing.status).toBe(404);
  });
});

// The fork route used to hardcode `{ anonOwnerId }` no matter who called it, so a signed-in user's
// copy was born with ownerId = null — an orphan its own creator could not edit, rename or delete
// once ARTIFACT_ENFORCE_OWNERSHIP was on. Ownership must follow the caller's real identity, decided
// the same way POST /api/sites decides it: the two markers are exclusive, session wins.
describe("fork ownership — the copy belongs to whoever forked it", () => {
  const dirs: string[] = [];
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    // The blocks above share the harness-wide .data/test store; take a private one so an enforced
    // run cannot see their rows (and vice versa) — and close the shared handle before switching.
    await closeDbForTests();
    previousDataDir = process.env.ARTIFACT_DATA_DIR;
    const dir = mkdtempSync(join(tmpdir(), "ah-fork-owner-"));
    dirs.push(dir);
    process.env.ARTIFACT_DATA_DIR = dir;
    // Enforcement is what makes ownership load-bearing, and it needs a configured IdP or it
    // deliberately degrades to the legacy token regime (see lib/authz).
    process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
    process.env.ARTIFACT_OIDC_ISSUER = "https://idp/oidc";
    process.env.ARTIFACT_OIDC_CLIENT_ID = "c";
    process.env.ARTIFACT_OIDC_CLIENT_SECRET = "s";
  });

  afterEach(async () => {
    await closeDbForTests();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    // Restore rather than delete: setup.ts pointed the harness at .data/test once, and other files
    // (and any later block here) still expect that.
    if (previousDataDir === undefined) delete process.env.ARTIFACT_DATA_DIR;
    else process.env.ARTIFACT_DATA_DIR = previousDataDir;
    for (const k of [
      "ARTIFACT_ENFORCE_OWNERSHIP",
      "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET",
    ]) delete process.env[k];
  });

  const secure = { "x-forwarded-proto": "https", origin: "https://x" };
  const forkReq = (slug: string, headers: Record<string, string> = {}) =>
    new Request(`https://x/api/sites/${slug}/fork`, { method: "POST", headers: { ...secure, ...headers } });

  async function sourceSite(html = "<title>Src</title><body>x</body>") {
    return (await createSite({ mode: "paste", html })).site;
  }

  /** A signed-in caller's cookie header, as a browser would send it. */
  async function signIn(subject: string) {
    const user = await upsertUser({ authProvider: "t", providerSubject: subject });
    const { cookie } = await mintSession(new Request("https://x/", { headers: { "x-forwarded-proto": "https" } }), user.id);
    return { user, cookieHeader: cookie.split(";")[0] };
  }

  it("records the signed-in forker as ownerId — and the copy is then genuinely his to edit and delete", async () => {
    const source = await sourceSite();
    const { user, cookieHeader } = await signIn("forker");

    const res = await forkPOST(forkReq(source.slug, { "x-edit-token":source.editToken, cookie: cookieHeader }), params(source.slug));
    expect(res.status).toBe(200);
    const { slug } = await res.json();

    const copy = (await getSiteBySlug(slug))!;
    expect(copy.ownerId).toBe(user.id);
    // Exclusive, exactly like POST /api/sites: a session never also stamps the browser marker.
    expect(copy.anonOwnerId).toBeNull();

    // The point of the field: without it every one of these is a 403 against his own copy.
    const edited = await editPOST(new Request(`https://x/api/sites/${slug}/edit`, {
      method: "POST",
      headers: { ...secure, "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ content: "<body>mine now</body>" }),
    }), params(slug));
    expect(edited.status).toBe(200);

    const deleted = await itemDELETE(
      new Request(`https://x/api/sites/${slug}`, { method: "DELETE", headers: { ...secure, cookie: cookieHeader } }),
      params(slug),
    );
    expect(deleted.status).toBe(200);
  });

  it("leaves a stranger's fork owned by the stranger, never by the source's owner", async () => {
    const source = await sourceSite("<title>Theirs</title><body>x</body>");
    const { user: owner } = await signIn("source-owner");
    const { user: stranger, cookieHeader } = await signIn("stranger");

    const res = await forkPOST(forkReq(source.slug, { "x-edit-token":source.editToken, cookie: cookieHeader }), params(source.slug));
    const { slug } = await res.json();
    const copy = (await getSiteBySlug(slug))!;
    expect(copy.ownerId).toBe(stranger.id);
    expect(copy.ownerId).not.toBe(owner.id);
  });

  it("still stamps an anonymous forker's browser id, and that browser keeps editing its copy", async () => {
    const source = await sourceSite("<title>Anon</title><body>x</body>");

    const res = await forkPOST(
      forkReq(source.slug, { "x-edit-token":source.editToken, cookie: "__Host-ah_anon=anon_browser_1" }), params(source.slug),
    );
    expect(res.status).toBe(200);
    const { slug } = await res.json();

    const copy = (await getSiteBySlug(slug))!;
    expect(copy.anonOwnerId).toBe("anon_browser_1");
    expect(copy.ownerId).toBeNull();

    const edited = await editPOST(new Request(`https://x/api/sites/${slug}/edit`, {
      method: "POST",
      headers: { ...secure, "content-type": "application/json", cookie: "__Host-ah_anon=anon_browser_1" },
      body: JSON.stringify({ content: "<body>still mine</body>" }),
    }), params(slug));
    expect(edited.status).toBe(200);
  });

  it("stamps the id it just minted when the forker has no cookie yet, and hands it back", async () => {
    const source = await sourceSite("<title>Fresh</title><body>x</body>");
    const res = await forkPOST(forkReq(source.slug,{"x-edit-token":source.editToken}), params(source.slug));
    const { slug } = await res.json();

    const minted = /__Host-ah_anon=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(minted).toBeTruthy();
    // The site must carry the SAME id the browser was just handed, or the forker walks away with a
    // cookie that owns nothing.
    expect((await getSiteBySlug(slug))!.anonOwnerId).toBe(decodeURIComponent(minted!));
  });

  // The audit row is the copy's provenance. It was resolved from the request BEFORE the fresh anon
  // cookie existed, so a first-time anonymous forker landed in `legacy-token` — the tier that by
  // design names nobody — while POST /api/sites recorded the same caller as `anon`.
  it("attributes the fork row to the real actor, matching what POST /api/sites records", async () => {
    const source = await sourceSite("<title>Trail</title><body>x</body>");

    const anonRes = await forkPOST(forkReq(source.slug,{"x-edit-token":source.editToken}), params(source.slug));
    const anonCopy = (await getSiteBySlug((await anonRes.json()).slug))!;
    const [anonRow] = await listAudit(anonCopy.id);
    expect(anonRow.action).toBe("fork");
    expect(anonRow.editorKind).toBe("anon");
    expect(anonRow.actorAnonId).toBe(anonCopy.anonOwnerId);
    expect(anonRow.actorUserId).toBeNull();

    const { user, cookieHeader } = await signIn("trail-user");
    const userRes = await forkPOST(forkReq(source.slug, { "x-edit-token":source.editToken, cookie: cookieHeader }), params(source.slug));
    const userCopy = (await getSiteBySlug((await userRes.json()).slug))!;
    const [userRow] = await listAudit(userCopy.id);
    expect(userRow.editorKind).toBe("user");
    expect(userRow.actorUserId).toBe(user.id);
  });
});
