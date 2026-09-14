// The permission gate of the edit page. What is fixed here is a FALSE LOCK: the check bypassed the
// server-side capability model entirely and recognised only the per-site editToken, whereas with
// ARTIFACT_ENFORCE_OWNERSHIP on, owners/collaborators are authorised by session — the token lives
// only in one particular browser's localStorage. Switch devices, clear data, or claim a site after
// logging in, and the server clearly allows the edit while the front end slaps on a "you have no
// edit permission for this site" lock screen.
//
// Three layers of assertion, each closer to the real path than the last:
//   (1) editorLocked — the extracted pure decision, run directly for four kinds of visitor rather
//       than asserted on strings;
//   (2) requestFromHeaders + describePermissions — the server-side resolution path, walked with a
//       real session cookie and a real site row, proving canEdit is COMPUTED ON THE SERVER rather
//       than a prop the client stuffs in;
//   (3) structural constraints — the vitest environment is node (no jsdom, no DOM to render), so
//       "the page really calls authz and passes the result down" and "the component really uses
//       editorLocked" can only be anchored on the source. The anchors are distinctive identifiers.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describePermissions, requestFromHeaders } from "@/lib/authz";
import { editorLocked } from "@/components/editor";
import { addCollaborator, closeDbForTests, getSite, setSiteOwnerIfUnowned, upsertUser } from "@/lib/db";
import { mintSession } from "@/lib/session";
import { createSite } from "@/lib/sites";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");
/** Strip comments, leaving only the code that actually runs — an old predicate restated in a comment must not count as still running (same as viewer-chrome's cssCode). */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

const dirs: string[] = [];
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-editor-cap-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});
afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of [
    "ARTIFACT_DATA_DIR", "ARTIFACT_ENFORCE_OWNERSHIP",
    "ARTIFACT_OIDC_ISSUER", "ARTIFACT_OIDC_CLIENT_ID", "ARTIFACT_OIDC_CLIENT_SECRET", "PUBLISH_API_TOKEN",
  ]) delete process.env[k];
});

/** Turn on ownership enforcement. It requires a configured IdP, otherwise it deliberately falls back to the legacy behaviour (see "enforcement requires a configured IdP" in authz). */
function enforce() {
  process.env.ARTIFACT_ENFORCE_OWNERSHIP = "on";
  process.env.ARTIFACT_OIDC_ISSUER = "https://idp/oidc";
  process.env.ARTIFACT_OIDC_CLIENT_ID = "c";
  process.env.ARTIFACT_OIDC_CLIENT_SECRET = "s";
}

/** A server component only has headers(); this simulates it: a set of request headers → adapter → describePermissions. */
const bag = (headers: Record<string, string>) => ({ get: (name: string) => headers[name.toLowerCase()] ?? null });

/** Log a user in and obtain the cookie the browser would send. */
async function loginCookie(userId: string): Promise<string> {
  const { cookie } = await mintSession(new Request("https://x/", { headers: { "x-forwarded-proto": "https" } }), userId);
  return cookie.split(";")[0];
}

// ── (1) Pure decision: four kinds of visitor ────────────────────────────────────

describe("editorLocked — server capability OR local token, either one opens the door", () => {
  // This is the bug itself: a logged-in owner on a different device, the server says they can
  // edit, and they hold no token.
  it("[REPRO] server allows + no editToken → not locked (the old implementation showed the lock screen here)", () => {
    expect(editorLocked({ canEdit: true, authResolved: true, editToken: null })).toBe(false);
  });

  it("when the server allows there is no need to wait for hydration; the first paint is already unlocked", () => {
    expect(editorLocked({ canEdit: true, authResolved: false, editToken: null })).toBe(false);
  });

  // The token path must not change by a single character — the `?t=` editable link is the
  // product's sharing mechanism.
  it("[NO REGRESSION] legacy mode, server says no, but this browser holds the token → still editable", () => {
    expect(editorLocked({ canEdit: false, authResolved: true, editToken: "tok" })).toBe(false);
  });

  it("neither path available → lock screen", () => {
    expect(editorLocked({ canEdit: false, authResolved: true, editToken: null })).toBe(true);
  });

  it("not yet hydrated does not count as 'no permission'; the lock screen must not flash", () => {
    expect(editorLocked({ canEdit: false, authResolved: false, editToken: null })).toBe(false);
  });
});

// ── (2) Server-side resolution path: headers() → capability ───────────────────

describe("server-side capability resolution (requestFromHeaders + describePermissions)", () => {
  it("[REPRO] logged-in owner with no editToken anywhere in the browser → canEditContent", async () => {
    enforce();
    const user = await upsertUser({ authProvider: "t", providerSubject: "owner" });
    const { site } = await createSite({ mode: "paste", html: "<title>A</title><body>x</body>" });
    await setSiteOwnerIfUnowned(site.id, user.id);
    const fresh = await getSite(site.id);

    // The request carries only the session cookie — no x-edit-token, no ?t= — exactly what "switched devices" looks like.
    const req = requestFromHeaders(bag({ cookie: await loginCookie(user.id), "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`);
    const perms = await describePermissions(req, fresh!);
    expect(perms.canEditContent).toBe(true);
    expect(perms.enforced).toBe(true);
  });

  it("same for a collaborator: authorised by session, likewise holding no token", async () => {
    enforce();
    const owner = await upsertUser({ authProvider: "t", providerSubject: "o" });
    const collab = await upsertUser({ authProvider: "t", providerSubject: "c" });
    const { site } = await createSite({ mode: "paste", html: "<title>B</title><body>x</body>" });
    await setSiteOwnerIfUnowned(site.id, owner.id);
    await addCollaborator(site.id, collab.id, owner.id);
    const fresh = await getSite(site.id);

    const req = requestFromHeaders(bag({ cookie: await loginCookie(collab.id), "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`);
    expect((await describePermissions(req, fresh!)).canEditContent).toBe(true);
  });

  it("[NO REGRESSION] anonymous + the correct ?t= token (legacy mode) → the server accepts it too, unlocked on first paint", async () => {
    const { site } = await createSite({ mode: "paste", html: "<title>C</title><body>x</body>" });
    const fresh = await getSite(site.id);

    const req = requestFromHeaders(bag({ "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`, site.editToken);
    expect((await describePermissions(req, fresh!)).canEditContent).toBe(true);
  });

  it("a passer-by with no session and no token → the server grants no capability (the UI gate is no wider than the server)", async () => {
    enforce();
    const user = await upsertUser({ authProvider: "t", providerSubject: "o2" });
    const { site } = await createSite({ mode: "paste", html: "<title>D</title><body>x</body>" });
    await setSiteOwnerIfUnowned(site.id, user.id);
    const fresh = await getSite(site.id);

    const anonymous = requestFromHeaders(bag({ "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`);
    expect((await describePermissions(anonymous, fresh!)).canEditContent).toBe(false);

    // Someone else's token does not work either — under ownership enforcement anonymous writes are always refused.
    const wrongToken = requestFromHeaders(bag({ "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`, "not-the-token");
    expect((await describePermissions(wrongToken, fresh!)).canEditContent).toBe(false);
  });

  it("logged in but not the owner, and the site does not open editing to logged-in users → still no capability", async () => {
    enforce();
    const owner = await upsertUser({ authProvider: "t", providerSubject: "o3" });
    const stranger = await upsertUser({ authProvider: "t", providerSubject: "s3" });
    const { site } = await createSite({ mode: "paste", html: "<title>E</title><body>x</body>" });
    await setSiteOwnerIfUnowned(site.id, owner.id);
    const fresh = await getSite(site.id);

    const req = requestFromHeaders(bag({ cookie: await loginCookie(stranger.id), "x-forwarded-proto": "https" }), `/s/${site.slug}/edit`);
    expect((await describePermissions(req, fresh!)).canEditContent).toBe(false);
  });
});

describe("requestFromHeaders carries the scheme across as well", () => {
  // session.ts / anon.ts recognise the __Host- prefixed cookie name only on HTTPS. Hard-coding
  // https means that under plain-HTTP local development the cookie can never be read and everyone
  // counts as anonymous — precisely the flaw of the two original in-place `new Request` calls.
  it("x-forwarded-proto: http → builds an http URL", () => {
    expect(new URL(requestFromHeaders(bag({ "x-forwarded-proto": "http" }), "/s/a/edit").url).protocol).toBe("http:");
  });

  it("https or absent (production) → https", () => {
    expect(new URL(requestFromHeaders(bag({ "x-forwarded-proto": "https, http" }), "/s/a/edit").url).protocol).toBe("https:");
    expect(new URL(requestFromHeaders(bag({}), "/s/a/edit").url).protocol).toBe("https:");
  });

  it("cookie / authorization / editToken are all carried through verbatim", () => {
    const req = requestFromHeaders(bag({ cookie: "k=v", authorization: "Bearer t" }), "/s/a/edit", "tok");
    expect(req.headers.get("cookie")).toBe("k=v");
    expect(req.headers.get("authorization")).toBe("Bearer t");
    expect(req.headers.get("x-edit-token")).toBe("tok");
  });

  // editTokenFromRequest falls back to reading `?t=`, so nothing smuggled into the path may ever become a credential.
  it("any query string in the path is dropped; a credential can only come from the headers", () => {
    const req = requestFromHeaders(bag({}), "/s/evil?t=stolen-token/edit");
    expect(new URL(req.url).search).toBe("");
    expect(req.headers.get("x-edit-token")).toBeNull();
  });
});

// ── (3) Wiring: the capability must really be computed on the server, and really reach the gate ──

describe("wiring (source-structure constraints)", () => {
  const page = read("src/app/s/[slug]/edit/page.tsx");
  const editor = read("src/components/editor.tsx");

  it("the edit page resolves the capability on the server instead of letting the client guess", () => {
    expect(page).toMatch(/import \{ describePermissions, requestFromHeaders \} from "@\/lib\/authz"/);
    expect(page).toMatch(/await describePermissions\(\s*requestFromHeaders\(await headers\(\)/);
    expect(page).toContain("const canEdit = permissions.canEditContent;");
  });

  it("both render branches (single / folder) pass canEdit down; missing one is a false lock on half the sites", () => {
    expect(page.match(/canEdit=\{canEdit\}/g) ?? []).toHaveLength(2);
    expect(page.match(/<Editor$/gm) ?? []).toHaveLength(2);
  });

  it("the lock screen goes through editorLocked rather than re-spelling !editToken", () => {
    expect(editor).toContain("if (editorLocked({ canEdit, authResolved, editToken }))");
    // The old predicate may no longer appear in CODE — it is the bug (restating it in a comment is fine, hence stripping comments first).
    expect(stripComments(editor)).not.toContain("authResolved && !editToken");
  });

  it("canEdit is a required prop: a new render site must answer explicitly, since a default of false quietly locks logged-in users out", () => {
    expect(editor).toMatch(/^\s+canEdit: boolean;$/m);
    expect(editor).not.toMatch(/canEdit\?: boolean/);
  });
});
