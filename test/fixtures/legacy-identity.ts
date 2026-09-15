// Construct historical identity states for migration/authorization tests only.
// Runtime code must use the audited, tenant-checked APIs instead of these fixture writes.
import { rbacQuery } from "@/lib/db";
export async function addCollaborator(siteId: string, userId: string, grantedBy: string | null = null): Promise<void> {
  await rbacQuery("INSERT INTO site_members(site_id,user_id,role,granted_by,granted_at) VALUES($1,$2,'editor',$3,$4) ON CONFLICT DO NOTHING", [siteId,userId,grantedBy,Date.now()]);
}
export async function setSiteOwnerIfUnowned(siteId: string, ownerId: string): Promise<boolean> {
  return (await rbacQuery("UPDATE sites SET owner_id=$1,tenant_id=CASE WHEN tenant_id='anonymous' THEN 'init' ELSE tenant_id END,updated_at=$2 WHERE id=$3 AND owner_id IS NULL AND deleted_at IS NULL RETURNING id", [ownerId,Date.now(),siteId])).length > 0;
}
export async function transferSiteOwner(siteId: string, userId: string): Promise<void> {
  await rbacQuery("UPDATE sites SET owner_id=$1,tenant_id=CASE WHEN tenant_id='anonymous' THEN 'init' ELSE tenant_id END,updated_at=$2 WHERE id=$3 AND deleted_at IS NULL", [userId,Date.now(),siteId]);
}
export async function adoptAnonymousSites(anonOwnerId: string, userId: string): Promise<number> {
  return (await rbacQuery("UPDATE sites SET owner_id=$1,tenant_id=CASE WHEN tenant_id='anonymous' THEN 'init' ELSE tenant_id END,anon_owner_id=NULL,updated_at=$2 WHERE anon_owner_id=$3 AND owner_id IS NULL AND deleted_at IS NULL RETURNING id", [userId,Date.now(),anonOwnerId])).length;
}
