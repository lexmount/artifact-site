import type { CommentMention } from "./mention-types";
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { createId, rbacQuery, type Row } from "@/lib/db";
import type { RbacQuery } from "@/lib/rbac-store";
import type {
  CommentAnchor,
  CommentContext,
  CommentMessage,
  CommentScope,
  CommentSpace,
  CommentThread,
} from "./contracts";
export const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
const parse = <T>(value: unknown): T =>
  typeof value === "string" ? JSON.parse(value) : (value as T);
export function spaceDTO(r: Row): CommentSpace {
  return {
    id: String(r.id),
    siteId: String(r.site_id),
    versionId: String(r.version_id),
    entry:
      r.kind === "main"
        ? { kind: "main" }
        : { kind: "share", shareId: String(r.share_id) },
    createdAt: Number(r.created_at),
  };
}
export function threadDTO(r: Row): CommentThread {
  return {
    id: String(r.id),
    spaceId: String(r.space_id),
    resultVersionId: r.result_version_id == null ? null : String(r.result_version_id),
    resultAssociation: r.result_associated_by == null ? null : { userId: String(r.result_associated_by), at: Number(r.result_associated_at), actorKind: r.result_actor_kind === "agent" ? "agent" : "user" },
    createdBy: String(r.created_by),
    anchor: parse<CommentAnchor>(r.anchor),
    context: parse<CommentContext>(r.context_snapshot),
    resolution:
      r.status === "open"
        ? { status: "open" }
        : {
            status: "resolved",
            resolvedBy: String(r.resolved_by),
            resolvedAt: Number(r.resolved_at),
            ...(r.resolver_display_name !== undefined
              ? { resolvedByDisplayName: r.resolver_display_name == null ? null : String(r.resolver_display_name) }
              : {}),
          },
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
export function messageDTO(r: Row): CommentMessage {
  const rich = r.rich_content == null ? null : parse<{body:string;format:"plain"|"lightweight";mentions?:CommentMention[]}>(r.rich_content);
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    authorUserId: String(r.author_user_id),
    ...(r.author_display_name !== undefined
      ? {
          authorDisplayName:
            r.author_display_name == null
              ? null
              : String(r.author_display_name),
        }
      : {}),
    isRoot: Number(r.is_root) === 1,
    content:
      r.deleted_at == null
        ? { state: "visible", body: rich?.body ?? String(r.body), ...(rich?.mentions?.length ? {mentions:rich.mentions} : {}), ...(rich?.format === "lightweight" ? {format:rich.format} : {}) }
        : {
            state: "deleted",
            deletedAt: Number(r.deleted_at),
            deletedBy: String(r.deleted_by),
          },
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    editedAt: r.edited_at == null ? null : Number(r.edited_at),
  };
}
export async function loadThread(id: string, q: RbacQuery = rbacQuery) {
  const [thread] = await q(
    "SELECT t.*,u.display_name AS resolver_display_name FROM comment_threads t LEFT JOIN users u ON u.id=t.resolved_by WHERE t.id=$1",
    [id],
  );
  if (!thread) return null;
  const [space] = await q("SELECT * FROM comment_spaces WHERE id=$1", [
    String(thread.space_id),
  ]);
  return space ? { thread: threadDTO(thread), space: spaceDTO(space) } : null;
}
export async function ensureSpace(
  q: RbacQuery,
  scope: CommentScope,
): Promise<string> {
  const shareId = scope.entry.kind === "share" ? scope.entry.shareId : null;
  const params = [scope.siteId, scope.versionId, shareId];
  const sql =
    "SELECT id FROM comment_spaces WHERE site_id=$1 AND version_id=$2 AND (share_id=$3 OR (share_id IS NULL AND $3 IS NULL))";
  let [row] = await q(sql, params);
  if (!row) {
    await q(
      "INSERT INTO comment_spaces(id,site_id,version_id,kind,share_id,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        createId("csp"),
        scope.siteId,
        scope.versionId,
        scope.entry.kind,
        shareId,
        Date.now(),
      ],
    );
    [row] = await q(sql, params);
  }
  return String(row.id);
}
/** Create only inside one operation/transaction; never retain across requests or DB resets. */
export function createFingerprintCache(): { secret?: Promise<string> } {
  return {};
}
async function fingerprintSecret(q: RbacQuery): Promise<string> {
  let [row] = await q(
    "SELECT secret FROM comment_secrets WHERE id='fingerprint'",
  );
  if (!row) {
    await q(
      "INSERT INTO comment_secrets(id,secret) VALUES('fingerprint',$1) ON CONFLICT(id) DO NOTHING",
      [randomBytes(32).toString("hex")],
    );
    [row] = await q(
      "SELECT secret FROM comment_secrets WHERE id='fingerprint'",
    );
  }
  if (!row) throw new Error("Comment fingerprint key initialization failed");
  return String(row.secret);
}
/** Stable private key survives preview rotation; an operation-local cache avoids repeated reads. */
export async function fingerprint(
  q: RbacQuery,
  value: unknown,
  cache?: ReturnType<typeof createFingerprintCache>,
): Promise<string> {
  const secret = await (cache
    ? (cache.secret ??= fingerprintSecret(q))
    : fingerprintSecret(q));
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("hex");
}
export function cursorEncode(
  filter: unknown,
  time: number,
  id: string,
): string {
  return Buffer.from(JSON.stringify({ filter, time, id })).toString(
    "base64url",
  );
}
export function cursorDecode(
  cursor: string | undefined,
  filter: unknown,
): { time: number; id: string } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (
      JSON.stringify(v.filter) !== JSON.stringify(filter) ||
      !Number.isSafeInteger(v.time) ||
      typeof v.id !== "string" ||
      v.id.length > 128
    )
      return fail(400, "Invalid cursor");
    return v;
  } catch {
    return fail(400, "Invalid cursor");
  }
}

/** Canonical user text; image-only rich bodies must not search the legacy DB sentinel. */
export function commentSearchBodySql(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error("Invalid SQL alias");
  // Both PostgreSQL JSONB and SQLite JSON support ->> text extraction.
  return `COALESCE(${alias}.rich_content ->> 'body', ${alias}.body)`;
}

/** Match fingerprints persisted before rich fields existed, without accepting content changes. */
export async function legacyCommentFingerprint(q: RbacQuery, value: Record<string, unknown>): Promise<string | undefined> {
  if (value.mentions !== undefined && (!Array.isArray(value.mentions) || value.mentions.length)) return undefined;
  if (value.bodyFormat !== undefined && value.bodyFormat !== "plain") return undefined;
  if (value.attachmentIds !== undefined && (!Array.isArray(value.attachmentIds) || value.attachmentIds.length)) return undefined;
  // Zod emits keys in schema order. Keep richFields after body so removing the
  // additive keys preserves the JSON.stringify order used by persisted legacy digests.
  const legacy = {...value};
  delete legacy.bodyFormat; delete legacy.attachmentIds; delete legacy.mentions;
  return fingerprint(q, legacy);
}
