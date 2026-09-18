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
  for (const migration of [{ id: "0001-comments", up, statements }, { id: "0002-comment-review-indexes", ...reviewIndexes }, { id: "0003-share-token-source", ...shareRecovery }, { id: "0004-share-revision", ...shareRevision }, { id: "0005-rbac-constraints", ...rbacConstraints }, { id: "0006-comment-engagement", ...engagement }]) {
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
