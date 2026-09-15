import "server-only";
import { randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { createId, rbacQuery, rbacTransaction } from "@/lib/db";
import type { AdminActor } from "@/lib/admin";

// Secrets are kept out of the public policy settings catalogue and its API response.
// Every read consults the shared store: rotation must invalidate credentials on all replicas
// immediately, rather than waiting for a process-local settings cache to expire.
export async function previewSecret() {
  const read = () => rbacQuery("SELECT secret,revision,updated_at FROM preview_secret WHERE id='active'");
  let [row] = await read();
  if (!row) {
    await rbacQuery(
      "INSERT INTO preview_secret(id,secret,revision,updated_at) VALUES('active',$1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [config.previewSigningSecret || randomBytes(32).toString("hex"), createId("pkey"), Date.now()],
    );
    [row] = await read(); // Concurrent first starts all adopt the winning insert.
  }
  if (!row) throw new Error("Preview secret initialization failed");
  return { secret: row.secret as string, revision: row.revision as string, updatedAt: Number(row.updated_at) };
}
export async function previewSecretStatus() {
  const { revision, updatedAt } = await previewSecret();
  return { revision, updatedAt };
}
export async function rotatePreviewSecret(expectedRevision: string, actor: AdminActor) {
  return rbacTransaction(async q => {
    const revision = createId("pkey"), updatedAt = Date.now();
    const rows = await q(
      "UPDATE preview_secret SET secret=$1,revision=$2,updated_at=$3 WHERE id='active' AND revision=$4 RETURNING revision",
      [randomBytes(32).toString("hex"), revision, updatedAt, expectedRevision],
    );
    if (!rows.length) throw Object.assign(new Error("Preview key changed; refresh before rotating again"), { statusCode: 409 });
    await q(
      "INSERT INTO admin_log(id,actor_kind,actor_user_id,action,target_kind,target_id,reason,ip,created_at) VALUES($1,$2,$3,'settings.update','system','preview-key',$4,NULL,$5)",
      [createId("adm"), actor.kind, actor.userId, "Rotated preview key", updatedAt],
    );
    return { revision, updatedAt };
  });
}
