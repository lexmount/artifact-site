import { requirePermission } from "@/lib/authz";
import { checkRateLimit, withRateLimitChecked } from "@/lib/ratelimit";
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { getSiteBySlug, rbacQuery, rbacTransaction, toSite, toVersion } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import { ownerKeyFor } from "@/lib/upload-session";
import { assertCanCreate, assertPresentedBearerAlive } from "@/lib/auth";
import { resolveSession } from "@/lib/session";
import { assertMutationOrigin } from "@/lib/request-auth";
import { errorResponse, json, readBodyWithinUploadLimit } from "@/app/api/_util";
import { anonymousExpiresAt } from "@/lib/quota";
import type { NextResponse } from "next/server";

export const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
type Active = { id: string; lease: string; status: number; edit: boolean };
const active = new AsyncLocalStorage<Active>();
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export class OperationError extends Error {
  constructor(message: string, readonly code: string, readonly statusCode = 409) { super(message); }
}
function failure(message: string, code: string, statusCode = 409) { return new OperationError(message, code, statusCode); }

export async function operationOwner(request: Request): Promise<string> {
  await assertPresentedBearerAlive(request, await resolveSession(request));
  const owner = await ownerKeyFor(request);
  if (!owner) throw failure("Idempotent publishing requires a signed-in identity or an existing anonymous cookie", "identity_required", 400);
  return owner;
}
export function operationId(owner: string, key: string): string { return hash(`${owner}\n${key}`); }

/** A result is written inside the SAME transaction as the site/version or upload session.
 * The lease comparison fences a slow worker after a crashed attempt has been reclaimed. */
export async function recordOperationResult(q: RbacQuery, body: unknown): Promise<void> {
  const op = active.getStore(); if (!op) return;
  const rows = await q("UPDATE publish_operations SET state='completed',result=$1,http_status=$2 WHERE id=$3 AND lease=$4 AND state='running' RETURNING id", [JSON.stringify(body), op.status, op.id, op.lease]);
  if (!rows.length) throw failure("Publication attempt was superseded; query its operation status", "operation_superseded");
  // Do not expose this before COMMIT: the outer wrapper reads the durable row again.
}
export async function recordPublishedVersion(q: RbacQuery, siteId: string, versionId: string, created = false): Promise<void> {
  if (!active.getStore()) return;
  const [row] = await q("SELECT * FROM sites WHERE id=$1", [siteId]);
  const site = toSite(row);
  const version = active.getStore()?.edit ? toVersion((await q("SELECT * FROM versions WHERE id=$1", [versionId]))[0]) : undefined;
  await recordOperationResult(q, {
    slug: site.slug, url: `/s/${site.slug}`, title: site.title, kind: site.kind, versionId,
    ...(version ? { version } : { officialVersionId: site.officialVersionId, officialRevision: site.officialRevision }),
    ...(created && !site.ownerId && site.editToken ? { editToken: site.editToken } : {}), ...(!version ? { expiresAt: anonymousExpiresAt(site) } : {}),
  });
}

async function fingerprint(request: Request, bytes: Uint8Array): Promise<string> {
  const type = request.headers.get("content-type") ?? "";
  // Multipart boundaries vary on retries. Hash names, filenames and actual bytes instead.
  if (type.includes("multipart/form-data")) {
    const form = await new Response(Buffer.from(bytes), { headers: { "content-type": type } }).formData();
    const fields = [];
    for (const [name, value] of form) fields.push([name, typeof value === "string" ? value : [value.name, hash(new Uint8Array(await value.arrayBuffer()))]]);
    return hash(JSON.stringify(fields));
  }
  return hash(bytes);
}

export async function withPublishOperation(request: Request, run: (request: Request) => Promise<NextResponse>): Promise<NextResponse> {
  const key = request.headers.get("idempotency-key");
  if (!key) return run(request);
  try {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw failure("Idempotency-Key must contain 8–128 letters, digits, dots, underscores, colons or hyphens", "invalid_idempotency_key", 400);
    checkRateLimit(request);
    const owner = await operationOwner(request);
    const path = new URL(request.url).pathname;
    const match = /^\/api\/sites\/([^/]+)\/(?:edit|versions)$/.exec(path);
    const target = match ? await getSiteBySlug(decodeURIComponent(match[1])) : null;
    if (match && !target) throw failure("Site not found", "site_not_found", 404);
    if (target) await requirePermission(request, target, "site.content.edit", undefined, false);
    if (path === "/api/sites") await assertCanCreate(request);
    await assertMutationOrigin(request, target ?? undefined);
    // Reject oversized bodies BEFORE reserving the key: a confirmed no-effect 413 must
    // leave it available for the MCP file-upload commit and recovery under the original key.
    const bytes = new Uint8Array(await (await readBodyWithinUploadLimit(request)).arrayBuffer());
    const url = new URL(request.url);
    const digest = hash(JSON.stringify([request.method, url.pathname, url.search, request.headers.get("content-type")?.split(";", 1)[0], request.headers.get("x-artifact-operation-input"), request.headers.get("x-artifact-tenant"), request.headers.get("x-artifact-share"), await fingerprint(request, bytes)]));
    const id = operationId(owner, key), lease = randomUUID(), now = Date.now();
    const claimed = await rbacTransaction(async q => {
      // rbacTransaction serializes claims AND business commits with the same Postgres advisory lock.
      // Keep SQL guards too, so these invariants survive future locking changes.
      // Expired keys remain tombstones: an old retry must never silently create a second site.
      await q("UPDATE publish_operations SET result=NULL,state='expired' WHERE expires_at<$1 AND state<>'expired'", [now]);
      const [row] = await q("SELECT * FROM publish_operations WHERE id=$1", [id]);
      if (row) {
        if (row.state === "expired") throw failure("The seven-day recovery window has expired; inspect the artifact before starting a new operation", "operation_expired", 410);
        if (row.fingerprint !== digest) throw failure("This Idempotency-Key was already used with different content or parameters", "idempotency_conflict");
        if (row.state === "completed") return row;
        if (Number(row.lease_until) > now) throw failure("Publication is still in progress; query operation status or retry the same key later", "operation_in_progress");
        const updated = await q("UPDATE publish_operations SET lease=$1,lease_until=$2,state='running' WHERE id=$3 AND state='running' AND lease=$4 AND lease_until<=$5 RETURNING id", [lease, now + LEASE_MS, id, String(row.lease), now]);
        if (!updated.length) throw failure("Publication state changed; query operation status or retry the same key", "operation_in_progress");
      } else {
        const inserted = await q("INSERT INTO publish_operations(id,owner_key,fingerprint,state,lease,lease_until,expires_at,client_fingerprint) VALUES($1,$2,$3,'running',$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING RETURNING id", [id, owner, digest, lease, now + LEASE_MS, now + OPERATION_RETENTION_MS, request.headers.get("x-artifact-operation-input")]);
        if (!inserted.length) throw failure("Publication is still in progress; retry the same key", "operation_in_progress");
      }
      return null;
    });
    if (claimed) return json(await readableOperationResult(request, claimed.result), Number(claimed.http_status));
    const status = url.pathname.startsWith("/api/uploads") ? 201 : 200;
    const headers = new Headers(request.headers); headers.delete("content-length");
    const replayable = new Request(request.url, { method: request.method, headers, body: Buffer.from(bytes), signal: request.signal });
    try {
      const response = await active.run({ id, lease, status, edit: url.pathname.endsWith("/edit") }, () => withRateLimitChecked(() => run(replayable)));
      const [row] = await rbacQuery("SELECT * FROM publish_operations WHERE id=$1", [id]);
      if (row?.state === "completed") return response;
      // A rejected transaction has no published result. Retain the fingerprint but allow recovery.
      await rbacQuery("UPDATE publish_operations SET lease_until=0 WHERE id=$1 AND lease=$2 AND state='running'", [id, lease]);
      return response;
    } catch (error) {
      await rbacQuery("UPDATE publish_operations SET lease_until=0 WHERE id=$1 AND lease=$2 AND state='running'", [id, lease]);
      throw error;
    }
  } catch (error) {
    if (error instanceof OperationError) return json({ error: error.message, code: error.code }, error.statusCode);
    return errorResponse(error);
  }
}

/** MCP must recover before consulting an already-cleaned upload session. */
export async function recoverMcpOperation(request: Request): Promise<unknown | undefined> {
  const key = request.headers.get("idempotency-key"); if (!key) return;
  const owner = await operationOwner(request);
  const [row] = await rbacQuery("SELECT * FROM publish_operations WHERE id=$1", [operationId(owner, key)]);
  if (!row) return;
  if (Number(row.expires_at) < Date.now()) throw failure("Operation recovery expired; inspect the artifact before publishing again", "operation_expired", 410);
  if (row.client_fingerprint !== request.headers.get("x-artifact-operation-input")) throw failure("The operation key was reused with different tool arguments", "idempotency_conflict");
  if (row.state === "completed") return readableOperationResult(request, row.result);
}

/** Retained responses must not bypass a later ownership or permission change. */
export async function readableOperationResult(request: Request, encoded: unknown): Promise<Record<string, unknown>> {
  const result = JSON.parse(String(encoded)) as Record<string, unknown>;
  if (typeof result.slug === "string") {
    const site = await getSiteBySlug(result.slug);
    if (!site || site.deletedAt) throw failure("Published artifact is no longer available", "site_not_found", 404);
    await requirePermission(request, site, "site.source.export", undefined, false);
  }
  return result;
}
