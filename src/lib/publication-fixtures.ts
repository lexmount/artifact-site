import "server-only";
import { notifySiteVersion } from "@/lib/site-events";
import { rbacQuery, toSite, type InsertSiteInput, type InsertVersionInput, type InsertAuditInput, type MetadataStore, type VersionCommit } from "@/lib/db";
import { assertPublicationFixture, translateSlugConflict, writePublicationCreation, writePublicationVersion } from "@/lib/publication-commit";
export { assertPublicationFixture } from "@/lib/publication-commit";

type FixtureStore = Pick<MetadataStore, "rbacTransaction">;

/** Explicit bypass for test setup, unavailable in a running server or worker. */
export async function insertSiteWithVersionForTests(store: FixtureStore, site: InsertSiteInput, version: InsertVersionInput, audit?: InsertAuditInput): Promise<void> {
  assertPublicationFixture();
  return store.rbacTransaction(q => writePublicationCreation(q, site, version, { kind: "fixture", audit })).catch(translateSlugConflict);
}

export async function addVersionForTests(store: FixtureStore, dialect: string, siteId: string, version: InsertVersionInput, audit?: InsertAuditInput, expected?: string): Promise<VersionCommit> {
  assertPublicationFixture();
  return store.rbacTransaction(async q => {
    // The row lock also serializes fixture commits with direct adapter deletion. SQLite's
    // BEGIN IMMEDIATE already takes its write lock before reading the expected pointer.
    const [row] = await q(`SELECT * FROM sites WHERE id=$1${dialect === "postgres" ? " FOR UPDATE" : ""}`, [siteId]);
    if (!row || row.deleted_at != null) return "gone";
    const site = toSite(row);
    if (expected !== undefined && site.currentVersionId !== expected) return "stale";
    await writePublicationVersion(q, site, version, { kind: "fixture", audit });
    return "applied";
  });
}

/** Fixture-only pointer override. Production rollback appends a version through publication. */
export async function setCurrentVersion(siteId: string, versionId: string): Promise<void> {
  assertPublicationFixture();
  await rbacQuery("UPDATE sites SET current_version_id=$2, updated_at=$3 WHERE id=$1 AND deleted_at IS NULL", [siteId, versionId, Date.now()]);
  notifySiteVersion(siteId, versionId); // Fixture pointer writes retain event behavior.
}
