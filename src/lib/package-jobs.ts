import { requestBase } from "@/lib/public-base";
import { currentPublishOperation, withBackgroundOperation, type ActiveOperation } from "@/lib/publish-operation";
import "server-only";
import { randomUUID } from "node:crypto";
import { rbacQuery, rbacTransaction, getSiteBySlug, type Row } from "@/lib/db";
import { isAdmin, editTokenFromRequest } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { bindBackgroundSession, bindBackgroundShare, bindBackgroundPasscode, type PasscodeAdmission } from "@/lib/background-session";
import { config, limits } from "@/lib/config";
import { sha256hex } from "@/lib/crypto";
import { type UploadSession, UPLOAD_SESSION_TTL_MS, sweepExpiredSessions } from "@/lib/upload-session";
import { packageJobContext } from "@/lib/package-job-context";
import type { PackageJobStatus } from "@/lib/package-job-contract";
import type { Session } from "@/lib/types";
import { BadRequestError } from "@/lib/errors";

import { shareTokenFromRequest, hashToken, capturePasscodeAdmission } from "@/lib/share";

interface Payload {
  generation?: string;
  operation?: ActiveOperation;
  shareHash?: string;
  passcode?: PasscodeAdmission;
  url: string; body: string; session: Session | null; anonId: string | null;
  operatorHash: string | null; editHash: string | null; slug: string | null;
  headers: [string, string][];
}
function status(row: Row): PackageJobStatus {
  let failure: PackageJobStatus["failure"];
  // Stored with the durable payload so manual retry generations survive process/browser restarts.
  const generation = (JSON.parse(String(row.payload)) as Payload).generation;
  try { const parsed = JSON.parse(String(row.error)); if (parsed?.status && parsed?.body) failure = parsed; } catch { /* Older jobs stored plain messages. */ }
  return { ...(generation ? { generation } : {}), ...(failure ? { failure } : {}), title: String(row.title || "Files"), targetSlug: row.target_slug == null ? null : String(row.target_slug), versionId: String(row.version_id), status: row.state as PackageJobStatus["status"], stage: String(row.stage), processedFiles: Number(row.processed), totalFiles: row.total == null ? null : Number(row.total), attempts: Number(row.attempts), retryable: Boolean(row.retryable), ...(row.error ? { error: failure ? String(failure.body.error) : String(row.error) } : {}), ...(row.result ? { result: JSON.parse(String(row.result)) } : {}), expiresAt: Number(row.expires_at) };
}
export async function packageJobStatus(versionId: string, owner: string | null) {
  const [row] = await rbacQuery("SELECT * FROM package_jobs WHERE version_id=$1 AND owner_key=$2 AND expires_at>$3", [versionId, owner, Date.now()]);
  return row ? status(row) : null;
}
export async function readablePackageJob(request: Request, job: PackageJobStatus) {
  if (job.result) {
    const { readableOperationResult } = await import("@/lib/publish-operation");
    return { ...job, result: await readableOperationResult(request, JSON.stringify(job.result)) };
  }
  return job;
}
export async function listPackageJobs(owner: string | null) {
  if (!owner) return [];
  return (await rbacQuery("SELECT * FROM package_jobs WHERE owner_key=$1 AND expires_at>$2 ORDER BY created_at DESC LIMIT 50", [owner, Date.now()])).map(status);
}
export async function enqueuePackageJob(request: Request, session: UploadSession, body: unknown) {
  const url = new URL(request.url); url.searchParams.delete("async"); url.searchParams.delete("t"); url.searchParams.delete("share");
  const publicOrigin = new URL(requestBase(request));
  url.protocol = publicOrigin.protocol; url.host = publicOrigin.host;
  const edit = editTokenFromRequest(request);
  const share = shareTokenFromRequest(request);
  const payload: Payload = { generation: randomUUID(), operation: currentPublishOperation(), passcode: await capturePasscodeAdmission(request, share), ...(share ? { shareHash: hashToken(share) } : {}), url: url.href, body: JSON.stringify(body), session: await resolveSession(request), anonId: anonIdFromRequest(request), operatorHash: isAdmin(request) ? sha256hex(config.publishApiToken) : null, editHash: edit ? sha256hex(edit) : null, slug: session.targetSlug ?? null, headers: [] };
  for (const name of ["accept-language", "user-agent", "x-real-ip", "x-management-reason", "x-management-reason-encoding"]) { const value = request.headers.get(name); if (value) payload.headers.push([name, value.slice(0, 2048)]); }
  const now = Date.now();
  await rbacTransaction(async q => {
    await q("INSERT INTO package_jobs(version_id,owner_key,payload,state,stage,available_at,created_at,expires_at,title,target_slug) SELECT $1,$2,$3,'queued','queued',$4,$4,$5,$6,$7 FROM upload_sessions WHERE version_id=$1 AND (package_lease IS NULL OR package_lease_until<$4) ON CONFLICT(version_id) DO NOTHING", [session.versionId, session.ownerKey, JSON.stringify(payload), now, session.createdAt + UPLOAD_SESSION_TTL_MS, session.title ?? session.packageOptions?.name ?? null, session.targetSlug ?? null]);
    if (payload.operation) {
      const updated = await q("UPDATE publish_operations SET lease_until=$1 WHERE id=$2 AND lease=$3 AND state='running' RETURNING id", [session.createdAt + UPLOAD_SESSION_TTL_MS, payload.operation.id, payload.operation.lease]);
      if (!updated.length) throw Object.assign(new Error("Publication attempt was superseded"), { statusCode: 409 });
    }
  });
  const job = await packageJobStatus(session.versionId, session.ownerKey);
  if (!job) throw Object.assign(new Error("Package upload is still in progress; retry shortly"), { statusCode: 409 });
  return job;
}
export async function retryPackageJob(versionId: string, owner: string | null) {
  const job = await packageJobStatus(versionId, owner);
  if (!job) return null;
  if (job.status === "failed") {
    if (!job.retryable) throw new BadRequestError("This package cannot be retried; correct the reported problem and upload again");
    const [row] = await rbacQuery("SELECT payload FROM package_jobs WHERE version_id=$1 AND owner_key=$2", [versionId, owner]);
    if (!row) return null;
    const payload: Payload = { ...JSON.parse(String(row.payload)), generation: randomUUID() };
    await rbacQuery("UPDATE package_jobs SET state='queued',stage='queued',attempts=0,error=NULL,available_at=$1,payload=$4 WHERE version_id=$2 AND owner_key=$3 AND state='failed' AND expires_at>$1 AND payload=$5", [Date.now(), versionId, owner, JSON.stringify(payload), String(row.payload)]);
  }
  return packageJobStatus(versionId, owner);
}
async function restoreRequest(payload: Payload) {
  const headers = new Headers(payload.headers); headers.set("content-type", "application/json");
  headers.set("origin", new URL(config.publicUrl || payload.url).origin);
  if (payload.operatorHash) {
    if (!config.publishApiToken || sha256hex(config.publishApiToken) !== payload.operatorHash) throw Object.assign(new Error("Operator credential was revoked"), { statusCode: 403 });
    headers.set("authorization", `Bearer ${config.publishApiToken}`);
  }
  if (payload.anonId) headers.set("cookie", `${new URL(payload.url).protocol === "https:" ? "__Host-ah_anon" : "ah_anon"}=${encodeURIComponent(payload.anonId)}`);
  if (payload.editHash && payload.slug) {
    const site = await getSiteBySlug(payload.slug);
    if (site && sha256hex(site.editToken) === payload.editHash) headers.set("x-edit-token", site.editToken);
  }
  const request = new Request(payload.url, { method: "POST", headers, body: payload.body });
  bindBackgroundSession(request, payload.session);
  if (payload.passcode) bindBackgroundPasscode(request, payload.passcode);
  if (payload.shareHash) bindBackgroundShare(request, payload.shareHash);
  return request;
}
/** Durable claim: one winner across replicas, expired claims are reclaimed after process loss. */
export async function runNextPackageJob() {
  const now = Date.now();
  const [candidate] = await rbacQuery("SELECT version_id FROM package_jobs WHERE expires_at>$1 AND available_at<=$1 AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.version_id=package_jobs.version_id AND u.package_lease_until>$1) AND (state='queued' OR (state='processing' AND lease_until<$1)) ORDER BY created_at LIMIT 1", [now]);
  if (!candidate) return false;
  const versionId = String(candidate.version_id), lease = randomUUID();
  const [row] = await rbacQuery("UPDATE package_jobs SET state='processing',lease=$1,lease_until=$2,attempts=attempts+1,error=NULL WHERE version_id=$3 AND (state='queued' OR (state='processing' AND lease_until<$4)) RETURNING *", [lease, now + 45_000, versionId, now]);
  if (!row) return true;
  let lost = false;
  const heartbeat = setInterval(() => { void rbacQuery("UPDATE package_jobs SET lease_until=$1 WHERE version_id=$2 AND lease=$3 AND state='processing' RETURNING version_id", [Date.now() + 45_000, versionId, lease]).then(rows => { if (!rows.length) lost = true; }).catch(() => { lost = true; }); }, 10_000);
  heartbeat.unref();
  try {
    const payload = JSON.parse(String(row.payload)) as Payload;
    const request = await restoreRequest(payload);
    const { executePost } = await import("@/lib/application/upload-commit");
    const result = await withBackgroundOperation(payload.operation, () => packageJobContext.run({ versionId, lease }, () => executePost(request, { params: Promise.resolve({ versionId }) }, async progress => {
      if (lost || Date.now() - now > limits.packageJobTimeoutMs) throw Object.assign(new Error("Package processing timed out; retry the same package"), { statusCode: 503 });
      const rows = await rbacQuery("UPDATE package_jobs SET stage=$1,processed=CASE WHEN stage=$1 AND processed>$2 THEN processed ELSE $2 END,total=$3 WHERE version_id=$4 AND lease=$5 AND state='processing' AND lease_until>$6 RETURNING version_id", [progress.stage, progress.processed, progress.total ?? null, versionId, lease, Date.now()]);
      if (!rows.length) throw Object.assign(new Error("Package worker lease was lost"), { statusCode: 503 });
    })));
    if (!result.ok) { const body = await result.json(); throw Object.assign(new Error(body.error || "Package processing failed"), { statusCode: result.status, code: body.code, data: body }); }
    // Publication records completed state in the same transaction as the version pointer.
  } catch (error) {
    const code = Number((error as { statusCode?: number }).statusCode || 500);
    const retryable = code >= 500 || (code === 409 && (error as { code?: string }).code !== "version_conflict");
    const message = code >= 500 ? "Package processing could not finish. Retry shortly." : (error as Error).message;
    console.error(`[package-job] ${versionId} attempt ${row.attempts}:`, error);
    await rbacQuery("UPDATE package_jobs SET state=$1,stage=$1,error=$2,retryable=$3,available_at=$4,lease=NULL,lease_until=0 WHERE version_id=$5 AND lease=$6 AND state='processing'", [retryable && Number(row.attempts) < 3 ? "queued" : "failed", JSON.stringify({ status: code, body: code >= 500 ? { error: message } : ((error as { data?: unknown }).data ?? { error: message }) }), retryable ? 1 : 0, Date.now() + Number(row.attempts) * 5000, versionId, lease]);
  } finally { clearInterval(heartbeat); }
  return true;
}
let running = false;
export function startPackageWorker() {
  if (running) return; running = true;
  const tick = async () => {
    try {
      await rbacQuery("DELETE FROM package_jobs WHERE expires_at<$1 AND (lease IS NULL OR lease_until<$1)", [Date.now()]);
      await sweepExpiredSessions();
      await runNextPackageJob();
    } catch (error) { console.error("[package-worker]", error); }
    const timer = setTimeout(() => void tick(), 1000); timer.unref();
  };
  void tick();
}
