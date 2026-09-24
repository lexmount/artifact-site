import { afterEach, describe, expect, it } from "vitest";
import {
  closeDbForTests,
  createId,
  insertSiteWithVersion,
  rbacQuery,
  upsertUser,
  getSiteBySlug,
  insertFolder,
  setFolderAssignment,
} from "@/lib/db";
import { describePermissions } from "@/lib/authz";
import { putUserSiteRole } from "@/lib/role-bindings";
import type { Session } from "@/lib/types";
import { readDirectory } from "@/lib/directory";
import { parseDirectoryQuery } from "@/lib/directory-query";

afterEach(closeDbForTests);
describe("bounded directories", () => {
  it("bounds untrusted pagination and treats search literally", () => {
    expect(
      parseDirectoryQuery(new URLSearchParams("page=-4&q=%25_&sort=sql")),
    ).toMatchObject({ page: 0, q: "%_", sort: "updated" });
  });
  it("paginates before expensive summary work and returns owner permissions together", async () => {
    const titlePrefix = createId("item");
    const user = await upsertUser({
      authProvider: "test",
      providerSubject: createId("directory"),
    });
    for (let i = 0; i < 15; i++) {
      const id = createId("s");
      await insertSiteWithVersion(
        {
          id,
          slug: id,
          title: `${titlePrefix} ${String(i).padStart(2, "0")}`,
          kind: "single",
          editToken: "secret",
          ownerId: user.id,
          visibility: "private",
        },
        {
          id: createId("v"),
          siteId: id,
          entry: "index.html",
          source: "upload",
          fileCount: 1,
          byteSize: 1,
        },
      );
    }
    const first = await readDirectory(
      { userId: user.id },
      parseDirectoryQuery(new URLSearchParams("sort=title")),
    );
    expect(first.sites).toHaveLength(12);
    expect(first.total).toBe(15);
    expect(first.permissions[first.sites[0].slug].canDelete).toBe(true);
    expect(JSON.stringify(first)).not.toContain("secret");
    const second = await readDirectory(
      { userId: user.id },
      parseDirectoryQuery(new URLSearchParams("sort=title&page=1")),
    );
    expect(second.sites).toHaveLength(3);
    expect(second.sites[0].title).toBe(`${titlePrefix} 12`);
    expect(
      (
        await readDirectory(
          { userId: user.id },
          parseDirectoryQuery(new URLSearchParams("q=%25")),
        )
      ).total,
    ).toBe(0);
    expect(
      (
        await readDirectory(
          {},
          parseDirectoryQuery(new URLSearchParams({ q: titlePrefix }), "public"),
        )
      ).total,
    ).toBe(0);
    const site = (await getSiteBySlug(first.sites[0].slug))!;
    const folderId = createId("folder");
    await insertFolder({id: folderId, userId:user.id, name:"Performance", createdAt:1}, 20);
    await setFolderAssignment(user.id, site.id, folderId);
    const filed = await readDirectory({userId:user.id}, parseDirectoryQuery(new URLSearchParams({folder:folderId})));
    expect(filed.total).toBe(1);
    // Folder identifiers are TEXT; stale bookmarks fall back to the visible All sites filter.
    for (const folder of ["abc", ""]) {
      const fallback = await readDirectory({userId:user.id},parseDirectoryQuery(new URLSearchParams({folder})));
      expect(fallback.total).toBe(15);
      expect(fallback.query.folder).toBe("all");
      const next = await readDirectory({userId:user.id}, parseDirectoryQuery(new URLSearchParams({folder,sort:"title",page:"1"})));
      expect(next.query.page).toBe(1);
      expect(next.sites).toHaveLength(3);
      expect(next.sites[0].title).toBe(`${titlePrefix} 12`);
      const beyond = await readDirectory({userId:user.id}, parseDirectoryQuery(new URLSearchParams({folder,page:"100"})));
      expect(beyond.query.page).toBe(1);
    }
    expect(filed.counts).toMatchObject({all:15,unfiled:14});
    expect(filed.folders.assign[site.slug]).toBe(folderId);
    const collaborator = await upsertUser({authProvider:"test",providerSubject:createId("collaborator")});
    const session = {userId:collaborator.id} as Session;
    const collabQuery = parseDirectoryQuery(new URLSearchParams({tab:"collab",q:titlePrefix}));
    for (const role of ["viewer", "commenter", "editor", "admin"]) {
      await putUserSiteRole(rbacQuery, site.id, collaborator.id, role, user.id);
      const result = await readDirectory({userId:collaborator.id, session},collabQuery);
      expect(result.sites).toHaveLength(1);
      expect(result.permissions[site.slug]).toEqual(await describePermissions(new Request("http://directory/"),site,session));
    }
    const readOnly = await readDirectory({userId:collaborator.id, session:{...session,scopes:["read"]}},collabQuery);
    expect(readOnly.permissions[site.slug].canDelete).toBe(false);
    expect(readOnly.permissions[site.slug].canEditContent).toBe(false);
    await putUserSiteRole(rbacQuery,site.id,collaborator.id,null,user.id);
    expect((await readDirectory({userId:collaborator.id},collabQuery)).total).toBe(0);
    await rbacQuery("DELETE FROM tenant_members WHERE user_id=$1", [user.id]);
    // The view must reject an owner whose tenant membership was removed.
    expect(
      (
        await readDirectory(
          { userId: user.id },
          parseDirectoryQuery(new URLSearchParams()),
        )
      ).total,
    ).toBe(0);
  });
});
