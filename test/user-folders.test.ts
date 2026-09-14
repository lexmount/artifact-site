// Account-level folders (issue #35): the store, the merge policy, and the routes — driven through
// the real handlers with real session cookies, so what is asserted is what a browser gets.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDbForTests, deleteFolder, getSiteBySlug, insertFolder, listFolderAssignments, listFolders, setFolderAssignment, setSiteOwnerIfUnowned, softDeleteSite, upsertUser } from "@/lib/db";
import { MAX_FOLDERS } from "@/lib/folders";
import { mintSession } from "@/lib/session";
import { createSite } from "@/lib/sites";
import { assignUserSite, createUserFolder, deleteUserFolder, FolderError, getFolderState, importFolderState, renameUserFolder } from "@/lib/user-folders";
import { GET as listRoute, POST as createRoute } from "@/app/api/me/folders/route";
import { DELETE as deleteRoute, PATCH as renameRoute } from "@/app/api/me/folders/[id]/route";
import { PUT as assignRoute } from "@/app/api/me/folders/assignments/route";
import { POST as importRoute } from "@/app/api/me/folders/import/route";

const ORIGIN = "https://hub.example";
let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["ARTIFACT_DATA_DIR", "ARTIFACT_PUBLIC_URL", "ARTIFACT_RATE_LIMIT"];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dir = mkdtempSync(join(tmpdir(), "ah-folders-"));
  process.env.ARTIFACT_DATA_DIR = dir;
  process.env.ARTIFACT_PUBLIC_URL = ORIGIN;
  process.env.ARTIFACT_RATE_LIMIT = "off";
});
afterEach(async () => {
  await closeDbForTests();
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

async function user(subject: string): Promise<{ id: string; cookie: string }> {
  const u = await upsertUser({ authProvider: "t", providerSubject: subject, email: `${subject}@x.test`, emailVerified: true });
  const { cookie } = await mintSession(new Request(`${ORIGIN}/`, { headers: { "x-forwarded-proto": "https" } }), u.id);
  return { id: u.id, cookie: cookie.split(";")[0] };
}

/** A site owned by `userId` (created anonymously, then adopted — the shape every claimed site has). */
async function ownedSite(userId: string, title: string): Promise<string> {
  const { site } = await createSite({ mode: "paste", html: `<title>${title}</title><body>x</body>` }, {});
  expect(await setSiteOwnerIfUnowned(site.id, userId)).toBe(true);
  return site.slug;
}

const req = (path: string, init: { method?: string; cookie?: string; body?: unknown } = {}) => {
  const headers = new Headers({ "x-forwarded-proto": "https", origin: ORIGIN });
  if (init.cookie) headers.set("cookie", init.cookie);
  const hasBody = init.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET", headers, body: hasBody ? JSON.stringify(init.body) : undefined });
};
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("store: folders and assignments", () => {
  it("folders are per user, ordered by sort, and deleting one un-files its members", async () => {
    const a = await user("a");
    const b = await user("b");
    expect(await insertFolder({ id: "f0", userId: a.id, name: "Home", createdAt: 20 }, 50)).toBe(true);
    expect(await insertFolder({ id: "f1", userId: a.id, name: "Work", createdAt: 10 }, 50)).toBe(true);
    expect(await insertFolder({ id: "fb", userId: b.id, name: "Theirs", createdAt: 30 }, 50)).toBe(true);
    expect((await listFolders(a.id)).map((f) => [f.name, f.sort])).toEqual([["Home", 0], ["Work", 1]]); // sort appended by the insert itself
    expect(await insertFolder({ id: "f2", userId: a.id, name: "Over", createdAt: 40 }, 2)).toBe(false); // cap enforced in the statement
    expect((await listFolders(a.id)).length).toBe(2);
    expect((await listFolders(b.id)).map((f) => f.name)).toEqual(["Theirs"]);

    const slug = await ownedSite(a.id, "one");
    const site = (await getSiteBySlug(slug))!;
    expect(await setFolderAssignment(a.id, site.id, "f1", 1)).toBe(true);
    expect(await setFolderAssignment(a.id, site.id, "fb", 1)).toBe(false); // someone else's folder
    expect(await listFolderAssignments(a.id)).toEqual([{ siteId: site.id, slug, folderId: "f1" }]);

    expect(await deleteFolder("f1", b.id)).toBe(false); // not theirs
    expect(await deleteFolder("f1", a.id)).toBe(true);
    expect(await listFolderAssignments(a.id)).toEqual([]);
    expect(await getSiteBySlug(slug)).not.toBeNull(); // the site itself is untouched
  });

  it("a deleted site drops out of the assignment list without touching the folder", async () => {
    const a = await user("a");
    const slug = await ownedSite(a.id, "gone");
    await insertFolder({ id: "f1", userId: a.id, name: "Work", createdAt: 1 }, 50);
    await setFolderAssignment(a.id, (await getSiteBySlug(slug))!.id, "f1", 1);
    await softDeleteSite((await getSiteBySlug(slug))!.id);
    expect(await listFolderAssignments(a.id)).toEqual([]);
    expect((await listFolders(a.id)).length).toBe(1);
  });
});

describe("lib: policy", () => {
  it("refuses blank names, caps the shelf, and files only sites the user may see", async () => {
    const a = await user("a");
    const b = await user("b");
    await expect(createUserFolder(a.id, "   ")).rejects.toBeInstanceOf(FolderError);
    for (let i = 0; i < MAX_FOLDERS; i++) await createUserFolder(a.id, `f${i}`);
    await expect(createUserFolder(a.id, "one too many")).rejects.toThrow(/At most/);

    const mine = await ownedSite(a.id, "mine");
    const theirs = await ownedSite(b.id, "theirs");
    const folder = (await listFolders(a.id))[0];
    await assignUserSite(a.id, mine, folder.id);
    await expect(assignUserSite(a.id, theirs, folder.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(assignUserSite(a.id, "nope", folder.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(assignUserSite(a.id, mine, "fld_not_mine")).rejects.toMatchObject({ statusCode: 404 });
    await assignUserSite(a.id, mine, null);
    expect((await getFolderState(a.id)).assign).toEqual({});

    // Rename/delete are scoped the same way: someone else's folder is "not found", not touched.
    await expect(renameUserFolder(b.id, folder.id, "hijack")).rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteUserFolder(b.id, folder.id)).rejects.toMatchObject({ statusCode: 404 });
    await renameUserFolder(a.id, folder.id, "  renamed  ");
    expect((await listFolders(a.id)).find((f) => f.id === folder.id)!.name).toBe("renamed");
    await deleteUserFolder(a.id, folder.id);
    expect((await listFolders(a.id)).some((f) => f.id === folder.id)).toBe(false);
  });

  it("import: matches folders by name, fills gaps only, skips foreign and unknown sites", async () => {
    const a = await user("a");
    const b = await user("b");
    const kept = await createUserFolder(a.id, "Work");
    const filed = await ownedSite(a.id, "already filed");
    const unfiled = await ownedSite(a.id, "unfiled");
    const theirs = await ownedSite(b.id, "theirs");
    await assignUserSite(a.id, filed, kept.id);

    const { state, report } = await importFolderState(a.id, {
      folders: [{ id: "L1", name: "work", createdAt: 1 }, { id: "L2", name: "Drafts", createdAt: 2 }, { id: "L3", name: "  ", createdAt: 3 }],
      assign: { [filed]: "L2", [unfiled]: "L2", [theirs]: "L1", "no-such-slug": "L1" },
    });
    expect(report).toEqual({ foldersCreated: 1, foldersMatched: 1, sitesFiled: 1, sitesSkipped: 3 });
    expect(state.folders.map((f) => f.name)).toEqual(["Work", "Drafts"]);
    const drafts = state.folders.find((f) => f.name === "Drafts")!;
    expect(state.assign).toEqual({ [filed]: kept.id, [unfiled]: drafts.id }); // server assignment kept, gap filled

    // Importing the same shelf again changes nothing.
    const again = await importFolderState(a.id, { folders: [{ id: "L1", name: "Work", createdAt: 1 }], assign: { [filed]: "L1" } });
    expect(again.report).toEqual({ foldersCreated: 0, foldersMatched: 1, sitesFiled: 0, sitesSkipped: 1 });
  });
});

describe("routes: /api/me/folders", () => {
  it("needs a session for everything and Origin for writes", async () => {
    expect((await listRoute(req("/api/me/folders"))).status).toBe(401);
    const a = await user("a");
    const noOrigin = new Request(`${ORIGIN}/api/me/folders`, { method: "POST", headers: { cookie: a.cookie, "x-forwarded-proto": "https", "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    expect((await createRoute(noOrigin)).status).toBe(401);
  });

  it("create → list → rename → assign → delete, scoped to the signed-in user", async () => {
    const a = await user("a");
    const b = await user("b");
    const created = await createRoute(req("/api/me/folders", { method: "POST", cookie: a.cookie, body: { name: "  Q3   reports " } }));
    expect(created.status).toBe(201);
    const { folder } = (await created.json()) as { folder: { id: string; name: string } };
    expect(folder.name).toBe("Q3 reports");

    expect((await createRoute(req("/api/me/folders", { method: "POST", cookie: a.cookie, body: { name: "" } }))).status).toBe(400);

    const slug = await ownedSite(a.id, "site");
    expect((await assignRoute(req("/api/me/folders/assignments", { method: "PUT", cookie: a.cookie, body: { slug, folderId: folder.id } }))).status).toBe(200);
    // Another user cannot rename, delete, or file into this folder.
    expect((await renameRoute(req(`/api/me/folders/${folder.id}`, { method: "PATCH", cookie: b.cookie, body: { name: "hijack" } }), params(folder.id))).status).toBe(404);
    expect((await deleteRoute(req(`/api/me/folders/${folder.id}`, { method: "DELETE", cookie: b.cookie }), params(folder.id))).status).toBe(404);
    expect((await assignRoute(req("/api/me/folders/assignments", { method: "PUT", cookie: b.cookie, body: { slug, folderId: folder.id } }))).status).toBe(404);

    expect((await renameRoute(req(`/api/me/folders/${folder.id}`, { method: "PATCH", cookie: a.cookie, body: { name: "Reports" } }), params(folder.id))).status).toBe(200);
    const listed = (await (await listRoute(req("/api/me/folders", { cookie: a.cookie }))).json()) as { folders: { id: string; name: string }[]; assign: Record<string, string> };
    expect(listed.folders).toEqual([expect.objectContaining({ id: folder.id, name: "Reports" })]);
    expect(listed.assign).toEqual({ [slug]: folder.id });
    expect((await (await listRoute(req("/api/me/folders", { cookie: b.cookie }))).json())).toEqual({ folders: [], assign: {} });

    expect((await assignRoute(req("/api/me/folders/assignments", { method: "PUT", cookie: a.cookie, body: { slug, folderId: null } }))).status).toBe(200);
    expect((await deleteRoute(req(`/api/me/folders/${folder.id}`, { method: "DELETE", cookie: a.cookie }), params(folder.id))).status).toBe(200);
    expect((await (await listRoute(req("/api/me/folders", { cookie: a.cookie }))).json())).toEqual({ folders: [], assign: {} });
  });

  it("import takes the browser's stored JSON verbatim and answers with the merged shelf", async () => {
    const a = await user("a");
    const slug = await ownedSite(a.id, "local");
    const stored = JSON.stringify({ v: 1, folders: [{ id: "f_abc", name: "From this browser", createdAt: 1 }], assign: { [slug]: "f_abc", "ghost": "f_abc" } });
    const res = await importRoute(new Request(`${ORIGIN}/api/me/folders/import`, { method: "POST", headers: { cookie: a.cookie, origin: ORIGIN, "x-forwarded-proto": "https", "content-type": "application/json" }, body: stored }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { folders: { id: string; name: string }[]; assign: Record<string, string>; report: Record<string, number> };
    expect(body.folders.map((f) => f.name)).toEqual(["From this browser"]);
    expect(body.assign).toEqual({ [slug]: body.folders[0].id });
    expect(body.report).toEqual({ foldersCreated: 1, foldersMatched: 0, sitesFiled: 1, sitesSkipped: 1 }); // "ghost" is not a site of theirs → skipped, not stored
    // Garbage is an empty shelf, not an error.
    const junk = await importRoute(new Request(`${ORIGIN}/api/me/folders/import`, { method: "POST", headers: { cookie: a.cookie, origin: ORIGIN, "x-forwarded-proto": "https" }, body: "not json" }));
    expect(junk.status).toBe(200);
  });
});
