import { afterEach, describe, expect, it } from "vitest";
import {
  closeDbForTests,
  createId,
  rbacQuery,
  upsertUser,
  getSiteBySlug,
  insertFolder,
  setFolderAssignment,
} from "@/lib/db";
import { insertSiteWithVersion } from "@/lib/publication-service";
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

it("filters effective sharing before pagination and keeps folder/search counts consistent", async () => {
  const owner = await upsertUser({authProvider:"test",providerSubject:createId("sharing-owner")});
  const reader = await upsertUser({authProvider:"test",providerSubject:createId("sharing-reader")});
  const ids: string[] = [];
  for (let i=0;i<16;i++) {
    const id=createId("s"); ids.push(id);
    await insertSiteWithVersion({id,slug:id,title:`Sharing ${String(i).padStart(2,"0")}`,kind:"single",editToken:"secret",ownerId:owner.id,visibility:i<13?"unlisted":"private"},
      {id:createId("v"),siteId:id,entry:"index.html",source:"upload",fileCount:1,byteSize:1});
  }
  const read = (query="") => readDirectory({userId:owner.id},parseDirectoryQuery(new URLSearchParams(query)));
  expect((await read("sharing=shared")).total).toBe(13);
  expect((await read("sharing=shared&page=1")).sites).toHaveLength(1);
  expect((await read("sharing=private")).sites.map(s=>s.slug).sort()).toEqual(ids.slice(13).sort());
  await putUserSiteRole(rbacQuery,ids[13],reader.id,"viewer",owner.id);
  expect((await read("sharing=shared")).total).toBe(14);
  await putUserSiteRole(rbacQuery,ids[13],reader.id,null,owner.id);
  const shareId=createId("share");
  await rbacQuery("INSERT INTO site_shares(id,site_id,token_hash,policy,created_at,mode) VALUES($1,$2,$3,'public',$4,'view')",[shareId,ids[14],createId("hash"),Date.now()]);
  expect((await read("sharing=shared")).total).toBe(14);
  await rbacQuery("UPDATE site_shares SET expires_at=1 WHERE id=$1",[shareId]);
  expect((await read("sharing=shared")).total).toBe(13);
  await rbacQuery("UPDATE site_shares SET expires_at=NULL,revoked_at=1 WHERE id=$1",[shareId]);
  expect((await read("sharing=shared")).total).toBe(13);
  const folder=createId("folder");
  await insertFolder({id:folder,userId:owner.id,name:"Mixed",createdAt:1},20);
  await setFolderAssignment(owner.id,ids[0],folder);
  await setFolderAssignment(owner.id,ids[15],folder);
  const filtered=await read(`sharing=private&folder=${folder}&q=Sharing`);
  expect(filtered.total).toBe(1);
  expect(filtered.counts.byId[folder]).toBe(1);
  expect(filtered.sharingCounts).toEqual({all:2,private:1,shared:1});
  expect(filtered.sites[0].sharingStatus).toMatchObject({shared:false});
  expect((await read("sharing=shared&q=Sharing%2000")).sharingCounts).toEqual({all:1,private:0,shared:1});
  expect(parseDirectoryQuery(new URLSearchParams("sharing=bad")).sharing).toBe("all");
  expect(parseDirectoryQuery(new URLSearchParams("tab=collab&sharing=private")).sharing).toBe("all");
});


it("uses effective main sharing and ignores empty, revoked and unavailable access channels", async () => {
  const owner = await upsertUser({authProvider:"test",providerSubject:createId("effective-owner")});
  const id=createId("s"), version=createId("v");
  await insertSiteWithVersion({id,slug:id,title:"Effective sharing",kind:"single",editToken:"secret",ownerId:owner.id,visibility:"private"},
    {id:version,siteId:id,entry:"index.html",source:"upload",fileCount:1,byteSize:1});
  const read=async () => (await readDirectory({userId:owner.id},parseDirectoryQuery(new URLSearchParams()))).sites[0].sharingStatus;
  await rbacQuery("INSERT INTO site_sharing_state(site_id,owner_id,audience,comments,source,updated_at) VALUES($1,$2,'tenant',1,'manual',1)",[id,owner.id]);
  expect(await read()).toMatchObject({shared:true,audience:"tenant"});
  // A detached collection must not retain its old audience, even if stored visibility is broad.
  await rbacQuery("UPDATE site_sharing_state SET source='all',source_id=NULL WHERE site_id=$1",[id]);
  await rbacQuery("UPDATE sites SET visibility='unlisted' WHERE id=$1",[id]);
  expect(await read()).toMatchObject({shared:false,audience:"private"});
  const link=createId("link");
  await rbacQuery("INSERT INTO site_shares(id,site_id,token_hash,policy,created_at,mode) VALUES($1,$2,$3,'people',1,'view')",[link,id,createId("hash")]);
  expect(await read()).toMatchObject({shared:false});
  await rbacQuery("INSERT INTO share_grants(share_id,email,granted_at) VALUES($1,'invited@example.com',1)",[link]);
  expect(await read()).toMatchObject({shared:true,links:true});
  await rbacQuery("UPDATE sites SET taken_down_at=1 WHERE id=$1",[id]);
  expect(await read()).toMatchObject({shared:false});
  await rbacQuery("UPDATE sites SET taken_down_at=NULL WHERE id=$1",[id]);
  expect(await read()).toMatchObject({shared:true});
  await rbacQuery("UPDATE site_shares SET revoked_at=1 WHERE id=$1",[link]);
  expect(await read()).toMatchObject({shared:false});
});


it("keeps taken-down works shared while a direct collaborator can still read", async () => {
  const { setSiteTakenDown } = await import("@/lib/db");
  const { canReadVersion } = await import("@/lib/share");
  const owner = await upsertUser({ authProvider: "test", providerSubject: createId("owner") });
  const reader = await upsertUser({ authProvider: "test", providerSubject: createId("reader") });
  const id = createId("s"), version = createId("v");
  await insertSiteWithVersion({ id, slug: id, title: "Taken down with collaborator", kind: "single", editToken: "secret", ownerId: owner.id, visibility: "private" },
    { id: version, siteId: id, entry: "index.html", source: "upload", fileCount: 1, byteSize: 1 });
  await putUserSiteRole(rbacQuery, id, reader.id, "viewer", owner.id);
  await setSiteTakenDown(id, Date.now(), "Review required");
  const site = (await getSiteBySlug(id))!;
  expect(await canReadVersion(new Request("http://directory/"), site, version, { userId: reader.id } as Session)).toBe(true);
  const read = (sharing: string) => readDirectory({ userId: owner.id }, parseDirectoryQuery(new URLSearchParams({ sharing })));
  expect((await read("shared")).sites[0]?.sharingStatus).toMatchObject({ shared: true, members: true, links: false, audience: "private" });
  expect((await read("private")).total).toBe(0);
  await putUserSiteRole(rbacQuery, id, reader.id, null, owner.id);
  expect((await read("shared")).total).toBe(0);
  expect((await read("private")).total).toBe(1);
});
