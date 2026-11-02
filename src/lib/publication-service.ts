import "server-only";
import { config } from "@/lib/config";
import { rbacTransaction, type InsertSiteInput, type InsertVersionInput, type InsertAuditInput, type VersionCommit } from "@/lib/db";
import { notifySiteVersion } from "@/lib/site-events";

// Publication coordinates authorization, atomic metadata writes, and post-commit events.
// Request-free calls are guarded test setup; they cannot run in a server or worker.
export async function insertSiteWithVersion(site: InsertSiteInput, version: InsertVersionInput, audit?: InsertAuditInput): Promise<void> {
  if (audit?.authorizationRequest) return (await import("@/lib/authorized-commit")).commitAuthorizedCreation(site, version, audit);
  const fixtures = await import("@/lib/publication-fixtures");
  fixtures.assertPublicationFixture();
  return fixtures.insertSiteWithVersionForTests({ rbacTransaction }, site, version, audit);
}
// Production publication requires a request. Context-free calls are test fixtures only.
// The version wrappers announce edits, whole-tree write-back, document re-upload, build
// commits and rollback. Announcing here —
// after the commit reports success, never inside its failure story — is what lets an open viewer
// page learn "this artifact just moved" without any writer having to remember to say so.
export async function addVersionAsCurrent(siteId: string, version: InsertVersionInput, audit?: InsertAuditInput): Promise<boolean> {
  if (!audit?.authorizationRequest) (await import("@/lib/publication-fixtures")).assertPublicationFixture();
  const ok = audit?.authorizationRequest
    ? (await (await import("@/lib/authorized-commit")).commitAuthorizedVersion(siteId, version, audit)) === "applied"
    : (await (await import("@/lib/publication-fixtures")).addVersionForTests({ rbacTransaction }, config.dbDriver, siteId, version, audit)) === "applied";
  if (ok) notifySiteVersion(siteId, version.id);
  return ok;
}
export async function addVersionAsCurrentIfCurrentIs(
  siteId: string,
  expectedCurrentVersionId: string,
  version: InsertVersionInput,
  audit?: InsertAuditInput,
): Promise<VersionCommit> {
  if (!audit?.authorizationRequest) (await import("@/lib/publication-fixtures")).assertPublicationFixture();
  const commit = audit?.authorizationRequest
    ? await (await import("@/lib/authorized-commit")).commitAuthorizedVersion(siteId, version, audit, expectedCurrentVersionId)
    : await (await import("@/lib/publication-fixtures")).addVersionForTests({ rbacTransaction }, config.dbDriver, siteId, version, audit, expectedCurrentVersionId);
  if (commit === "applied") notifySiteVersion(siteId, version.id);
  return commit;
}
