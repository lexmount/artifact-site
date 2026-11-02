import { AsyncLocalStorage } from "node:async_hooks";
import type { RbacQuery } from "@/lib/rbac-store";
export const packageJobContext = new AsyncLocalStorage<{ versionId: string; lease: string }>();
export async function recordPackageJobResult(q: RbacQuery, result: unknown) {
  const job = packageJobContext.getStore(); if (!job) return;
  const rows = await q("UPDATE package_jobs SET state='completed',stage='completed',retryable=0,error=NULL,result=$1,payload='{}',lease=NULL,lease_until=0 WHERE version_id=$2 AND lease=$3 AND state='processing' AND lease_until>$4 AND expires_at>$4 RETURNING version_id", [JSON.stringify(result), job.versionId, job.lease, Date.now()]);
  if (!rows.length) throw Object.assign(new Error("Package processing lease expired"), { statusCode: 409 });
}
