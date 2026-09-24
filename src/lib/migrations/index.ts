import * as mentions from "./0013-comment-mentions";
import * as notifications from "./0012-notifications";
import * as attachments from "./0010-comment-attachments";
import * as commentResults from "./0011-comment-results";
import { bootstrapAuthorization } from "./bootstrap-authorization";
import * as cleanupAuthorization from "./0009-authorization-cleanup";
import * as siteMembersView from "./0008-site-members-view";
import * as bindings from "./0007-role-bindings";
import { createHash } from "node:crypto";
import type { RbacQuery } from "@/lib/rbac-store";
import { up, statements } from "./0001-comments";
import * as reviewIndexes from "./0002-comment-review-indexes";
import * as rbacConstraints from "./0005-rbac-constraints";
import * as shareRevision from "./0004-share-revision";
import * as engagement from "./0006-comment-engagement";
import * as shareRecovery from "./0003-share-token-source";
/** Called under each driver's existing migration transaction and cross-replica lock. */
export async function migrateNumbered(q: RbacQuery, dialect: "postgres" | "sqlite"): Promise<void> {
  await q(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at BIGINT NOT NULL)`,
  );
  if (!(await q("SELECT id FROM schema_migrations WHERE id='0007-role-bindings'")).length) {
    await bootstrapAuthorization(q, dialect);
  }
  for (const migration of [{ id: "0001-comments", up, statements }, { id: "0002-comment-review-indexes", ...reviewIndexes }, { id: "0003-share-token-source", ...shareRecovery }, { id: "0004-share-revision", ...shareRevision }, { id: "0005-rbac-constraints", ...rbacConstraints }, { id: "0006-comment-engagement", ...engagement }, { id: "0007-role-bindings", ...bindings }, { id: "0008-site-members-view", ...siteMembersView }, { id: "0009-authorization-cleanup", ...cleanupAuthorization }, { id: "0010-comment-attachments", ...attachments }, { id: "0011-comment-results", ...commentResults }, { id: "0012-notifications", ...notifications }, { id: "0013-comment-mentions", ...mentions }]) {
    const { id, up, statements } = migration;
    const checksum = createHash("sha256")
      .update(statements.join("\n"))
      .digest("hex");
    const [row] = await q(
      "SELECT checksum FROM schema_migrations WHERE id=$1",
      [id],
    );
    if (row) {
      if (row.checksum !== checksum)
        throw new Error(`Applied migration ${id} was modified`);
      continue;
    }
    await up(q, dialect);
    await q(
      "INSERT INTO schema_migrations(id,checksum,applied_at) VALUES($1,$2,$3)",
      [id, checksum, Date.now()],
    );
  }
}
