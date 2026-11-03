import "server-only";
import { z } from "zod";
import { rbacTransaction, toSite } from "@/lib/db";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { assertPresentedBearerAlive } from "@/lib/auth";
import { requirePermission } from "@/lib/authz";
import { fail, fingerprint, sharingSession } from "@/lib/sharing-common";
import { canSelectOrganization } from "@/lib/sharing-policy";
import { getSiteSharing } from "@/lib/sharing-read";
import { putState } from "@/lib/sharing-mutations";
import { bulkSharingPolicy, type BulkSharingPreview } from "@/lib/bulk-sharing-model";
const inputSchema = z.object({
  slugs: z.array(z.string().min(1).max(200)).min(1).max(12),
  changes: z.object({
    audience: z.enum(["private", "tenant", "login", "anyone"]).optional(),
    comments: z.boolean().optional(),
    listInDiscover: z.boolean().optional(),
  }).strict().refine(changes => changes.listInDiscover === undefined || changes.audience === "anyone", "Discover listing requires anyone access"),
  expectedSnapshot: z.string().optional(),
  confirmation: z.string().optional(),
}).strict();
/** Preview and commit share the authorization lock. A batch never creates a persistent scope. */
export async function batchSharing(request: Request, raw: unknown): Promise<BulkSharingPreview> {
  const input = inputSchema.parse(raw);
  if (new Set(input.slugs).size !== input.slugs.length) fail("Duplicate sites");
  const session = await sharingSession(request, true);
  await assertPresentedBearerAlive(request, session);
  return rbacTransaction(async q => {
    await assertSessionCurrent(q, session);
    const [user] = await q("SELECT tenant_id FROM users WHERE id=$1", [session.userId]);
    let organization = canSelectOrganization(user?.tenant_id as string | undefined);
    const targets = [];
    for (const slug of [...input.slugs].sort()) {
      const [row] = await q("SELECT s.* FROM sites s JOIN tenants t ON t.id=s.tenant_id WHERE s.slug=$1 AND s.deleted_at IS NULL AND t.disabled_at IS NULL", [slug]);
      if (!row) fail("Site not found", 404);
      const site = toSite(row);
      if (!site.ownerId) fail("Account-owned sites are required", 403);
      await requirePermission(request, site, "site.sharing.manage", session, false);
      organization &&= canSelectOrganization(user?.tenant_id as string | undefined, site.tenantId);
      const state = await getSiteSharing(site, q);
      const requestedPolicy = null;
      const before = requestedPolicy ?? state.policy, after = bulkSharingPolicy(before, input.changes);
      targets.push({ site, state, requestedPolicy, after, changed: before.audience !== after.audience || before.comments !== after.comments });
    }
    if (input.changes.audience === "tenant" && !organization) fail("Organization access is unavailable for the selected sites");
    const snapshot = fingerprint({ user: session.userId, organization, targets: targets.map(({ site, state }) => ({ id: site.id, owner: site.ownerId, tenant: site.tenantId, updated: site.updatedAt, version: site.currentVersionId, state })) });
    if (input.expectedSnapshot && input.expectedSnapshot !== snapshot) fail("Sharing settings changed. Refresh before applying your changes.", 409);
    const confirmation = fingerprint({ snapshot, changes: input.changes });
    const result: BulkSharingPreview = {
      snapshot, confirmation, canSelectOrganization: organization,
      items: targets.map(({ site, state, requestedPolicy, after, changed }) => ({ slug: site.slug, title: site.title, ...state, requestedPolicy, after, changed })),
      updated: 0, pending: 0, unchanged: 0,
    };
    if (!input.confirmation) return result;
    if (input.confirmation !== confirmation) fail("Sharing settings changed. Refresh before applying your changes.", 409);
    for (const target of targets) {
      if (!target.changed) { result.unchanged++; continue; }
      // Audit management authority only for confirmed changes, within the batch transaction.
      await requirePermission(request, target.site, "site.sharing.manage", session);
      await putState(q, target.site, target.after, "manual", null, request);
      result.updated++;
    }
    return { ...result, applied: true };
  });
}
