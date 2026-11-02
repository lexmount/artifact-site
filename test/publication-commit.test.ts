import pg from "pg";
import { config } from "@/lib/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addVersionAsCurrent, addVersionAsCurrentIfCurrentIs, createId, getSite, getVersion, insertSiteWithVersion, listAudit, listVersions, rbacQuery, setCurrentVersion, softDeleteSite, type InsertVersionInput } from "@/lib/db";
import { apiAuditContext, auditRow } from "@/lib/audit";
import { createSite, editSite, rollbackTo } from "@/lib/sites";
import { publicationPolicy } from "@/lib/publication-policy";
import * as events from "@/lib/site-events";
import * as authz from "@/lib/authz";
import { committed, readVersionFile, testAudit } from "./helpers";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function context(site: { editToken: string }) {
  return apiAuditContext(new Request("http://localhost/api/sites", { headers: { "x-edit-token": site.editToken } }), { kind: "legacy-token", userId: null, anonId: null });
}
function version(siteId: string): InsertVersionInput {
  return { id: createId("ver"), siteId, entry: "index.html", fileCount: 1, byteSize: 10, source: "build", official: true };
}

describe("shared publication transaction", () => {
  it("commits one racing authorized CAS, including official designation and one notification", async () => {
    const a = await createSite({ mode: "paste", html: "first" });
    const versions = [version(a.site.id), version(a.site.id)];
    const notify = vi.spyOn(events, "notifySiteVersion").mockImplementation(() => {});
    const results = await Promise.all(versions.map(v => addVersionAsCurrentIfCurrentIs(a.site.id, a.version.id, v, auditRow(context(a.site), a.site.id, v.id, "edit"))));
    expect(results.sort()).toEqual(["applied", "stale"]);
    const site = (await getSite(a.site.id))!;
    expect(site.officialVersionId).toBe(site.currentVersionId);
    expect(site.officialRevision).toBe(1);
    expect(await listVersions(site.id)).toHaveLength(2);
    expect((await listAudit(site.id)).map(row => row.action)).toEqual(["official.set", "edit"]);
    expect(notify).toHaveBeenCalledExactlyOnceWith(site.id, site.currentVersionId);
    expect(await getVersion(versions.find(v => v.id !== site.currentVersionId)!.id)).toBeNull();
  });

  it("rolls back an update after official designation without emitting a notification", async () => {
    const a = await createSite({ mode: "paste", html: "first", official: true }, {}, testAudit());
    const before = await getSite(a.site.id);
    const beforeAudit = await listAudit(a.site.id);
    const next = version(a.site.id);
    const notify = vi.spyOn(events, "notifySiteVersion").mockImplementation(() => {});
    vi.spyOn(publicationPolicy, "commitVersion").mockImplementation(async input => {
      await input.publishOfficial();
      expect((await input.q("SELECT official_version_id FROM sites WHERE id=$1", [a.site.id]))[0].official_version_id).toBe(next.id);
      throw new Error("policy failure after designation");
    });
    await expect(addVersionAsCurrent(a.site.id, next, auditRow(context(a.site), a.site.id, next.id, "edit"))).rejects.toThrow("policy failure");
    expect(await getSite(a.site.id)).toEqual(before);
    expect(await getVersion(next.id)).toBeNull();
    expect(await listAudit(a.site.id)).toEqual(beforeAudit);
    expect(notify).not.toHaveBeenCalled();
  });

  it("appends an authorized rollback without moving the official designation", async () => {
    const a = await createSite({ mode: "paste", html: "original", official: true }, {}, testAudit());
    const b = committed(await editSite(a.site.slug, { content: "replacement" }, context(a.site)));
    const restored = await rollbackTo(a.site.slug, a.version.id, context(a.site));
    expect(restored).not.toBeNull();
    expect(restored!.version.id).not.toBe(a.version.id);
    expect(restored!.version.id).not.toBe(b.version.id);
    expect(restored!.version.source).toBe("rollback");
    expect(await readVersionFile(a.site.id, restored!.version.id, "index.html")).toBe(await readVersionFile(a.site.id, a.version.id, "index.html"));
    expect((await getSite(a.site.id))!.officialVersionId).toBe(a.version.id);
    expect((await listAudit(a.site.id))[0]).toMatchObject({ action: "rollback", versionId: restored!.version.id });
  });

  it("refuses missing and deleted sites without inserting versions or audits", async () => {
    const a = await createSite({ mode: "paste", html: "first" });
    await softDeleteSite(a.site.id);
    const notify = vi.spyOn(events, "notifySiteVersion").mockImplementation(() => {});
    for (const siteId of [a.site.id, createId("missing")]) {
      const next = version(siteId);
      await expect(addVersionAsCurrent(siteId, next, auditRow(context(a.site), siteId, next.id, "edit"))).rejects.toThrow("Site no longer exists");
      expect(await getVersion(next.id)).toBeNull();
      expect(await rbacQuery("SELECT id FROM audit_log WHERE version_id=$1", [next.id])).toEqual([]);
    }
    expect(notify).not.toHaveBeenCalled();
  });

  it.skipIf(config.dbDriver !== "postgres")("holds the publication row lock against a direct concurrent deletion", async () => {
    const a = await createSite({ mode: "paste", html: "first" });
    const next = version(a.site.id);
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const requirePermission = authz.requirePermission;
    vi.spyOn(authz, "requirePermission").mockImplementation(async (...args) => {
      entered();
      await held;
      return requirePermission(...args);
    });
    const notify = vi.spyOn(events, "notifySiteVersion").mockImplementation(() => {});
    const [{ pid }] = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows;
    const commit = addVersionAsCurrent(a.site.id, next, auditRow(context(a.site), a.site.id, next.id, "edit"));
    let deletion: Promise<unknown> | undefined;
    try {
      await inside;
      // Permission is checked immediately after the initial SELECT, before any INSERT or
      // UPDATE can acquire a write lock incidentally.
      expect(await getVersion(next.id)).toBeNull();
      // This is the same direct-pool write used by MetadataStore.softDeleteSite, on
      // another connection without the authorization advisory lock.
      deletion = client.query("UPDATE sites SET deleted_at=$1 WHERE id=$2", [Date.now(), a.site.id]);
      await vi.waitFor(async () => {
        const [activity] = await rbacQuery("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        expect(activity.wait_event_type).toBe("Lock");
      });
      expect(notify).not.toHaveBeenCalled();
      release();
      expect(await commit).toBe(true);
      await deletion;
      expect((await getSite(a.site.id))!.currentVersionId).toBe(next.id);
      expect((await getSite(a.site.id))!.deletedAt).not.toBeNull();
      expect(notify).toHaveBeenCalledExactlyOnceWith(a.site.id, next.id);
    } finally {
      release();
      await Promise.allSettled([commit, ...(deletion ? [deletion] : [])]);
      await client.end();
    }
  });

  it.skipIf(config.dbDriver !== "postgres")("rechecks deletion after waiting for a concurrent deletion to commit", async () => {
    const a = await createSite({ mode: "paste", html: "first" });
    const beforeAudit = await listAudit(a.site.id);
    const next = version(a.site.id);
    const notify = vi.spyOn(events, "notifySiteVersion").mockImplementation(() => {});
    const client = new pg.Client({ connectionString: config.databaseUrl });
    await client.connect();
    let commit: Promise<unknown> | undefined;
    try {
      await client.query("BEGIN");
      await client.query("UPDATE sites SET deleted_at=$1 WHERE id=$2", [Date.now(), a.site.id]);
      // Attach the rejection handler immediately, including on assertion-failure cleanup.
      commit = addVersionAsCurrent(a.site.id, next, auditRow(context(a.site), a.site.id, next.id, "edit"))
        .then(value => ({ value }), error => ({ error }));
      await vi.waitFor(async () => {
        // This observer is inside the deletion transaction; refresh its activity snapshot.
        await client.query("SELECT pg_stat_clear_snapshot()");
        const { rows } = await client.query<{ query: string }>(
          "SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
        );
        expect(rows.some(row => /SELECT \* FROM sites .*FOR UPDATE/.test(row.query))).toBe(true);
      });
      expect(await getVersion(next.id)).toBeNull();
      expect(notify).not.toHaveBeenCalled();
      await client.query("COMMIT");
      expect(await commit).toEqual({ error: expect.objectContaining({ message: "Site no longer exists" }) });
      expect(await getVersion(next.id)).toBeNull();
      expect(await listVersions(a.site.id)).toHaveLength(1);
      expect(await listAudit(a.site.id)).toEqual(beforeAudit);
      expect(await getSite(a.site.id)).toMatchObject({ currentVersionId: a.version.id, officialVersionId: null });
      expect((await getSite(a.site.id))!.deletedAt).not.toBeNull();
      expect(notify).not.toHaveBeenCalled();
    } finally {
      // Release the deletion lock before awaiting publication, even if an assertion fails.
      await client.query("ROLLBACK");
      if (commit) await commit;
      await client.end();
    }
  });

  it("rejects every context-free publication entry point outside the test runner", async () => {
    const a = await createSite({ mode: "paste", html: "first" });
    const next = version(a.site.id);
    vi.stubEnv("VITEST", "");
    const expected = "Publication requires an authorizationRequest";
    await expect(insertSiteWithVersion({ ...a.site, id: createId("site"), slug: createId("slug") }, next)).rejects.toThrow(expected);
    await expect(addVersionAsCurrent(a.site.id, next)).rejects.toThrow(expected);
    await expect(addVersionAsCurrentIfCurrentIs(a.site.id, a.version.id, next, auditRow(testAudit(), a.site.id, next.id, "edit"))).rejects.toThrow(expected);
    await expect(setCurrentVersion(a.site.id, next.id)).rejects.toThrow(expected);
    expect(await getVersion(next.id)).toBeNull();
    expect((await getSite(a.site.id))!.currentVersionId).toBe(a.version.id);
  });
});
