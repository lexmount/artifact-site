import "server-only";
import { managementReason } from "@/lib/management-reason";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";
import { z } from "zod";
import {
  createId,
  rbacQuery,
  rbacTransaction,
  toSite,
  type Row,
} from "@/lib/db";
import { requirePermission, describePermissions } from "@/lib/authz";
import { assertSessionCurrent } from "@/lib/authorized-commit";
import { resolveSession, csrfSafe } from "@/lib/session";
import { resolveAdmin } from "@/lib/admin";
import {
  memberRole,
  requireTenantManager,
  recordRbacAudit,
} from "@/lib/rbac-access";
import { BadRequestError } from "@/lib/errors";
import {
  AuthError,
  EditForbiddenError,
  assertPresentedBearerAlive,
} from "@/lib/auth";
import { isTokenSession } from "@/lib/publish-token";
import type { Session } from "@/lib/types";
const id = z.string().min(1).max(200);
export const resourceSchema = z
  .object({ type: z.enum(["site", "tenant"]), id })
  .strict();
const subjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id }).strict(),
  z.object({ type: z.literal("tenant"), id }).strict(),
  z.object({ type: z.literal("everyone") }).strict(),
]);
export const createBindingSchema = z
  .object({ resource: resourceSchema, subject: subjectSchema, roleId: id })
  .strict();
export const updateBindingSchema = z
  .object({ roleId: id, expectedRevision: z.number().int().positive() })
  .strict();
export const deleteBindingSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
export type Resource = z.infer<typeof resourceSchema>;
export function resourceFromRequest(request: Request): Resource {
  const p = new URL(request.url).searchParams;
  return resourceSchema.parse({
    type: p.get("resourceType"),
    id: p.get("resourceId"),
  });
}
function searchPattern(term:string) { return "%" + term.slice(0,100).replace(/[!%_]/g,"!$&") + "%"; }
function pageOffset(request: Request) {
  const value = new URL(request.url).searchParams.get("cursor");
  if (value !== null && !/^\d{1,6}$/.test(value))
    throw new BadRequestError("Invalid cursor");
  return Math.min(100000, Number(value) || 0);
}
function conflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}
function missing(): never {
  throw Object.assign(new Error("Resource not found"), { statusCode: 404 });
}
export function bindingResource(row: Row): Resource {
  return {
    type: row.resource_type as Resource["type"],
    id: (row.resource_site_id ?? row.resource_tenant_id) as string,
  };
}
export function bindingResult(row: Row) {
  return {
    id: row.id,
    resource: bindingResource(row),
    subject: {
      type: row.subject_type,
      ...(row.subject_user_id
        ? { id: row.subject_user_id }
        : row.subject_tenant_id
          ? { id: row.subject_tenant_id }
          : {}),
    },
    roleId: row.role_id,
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    subjectName: row.subject_name ?? null,
  };
}
/** The ordinary resource gate is reused by both the console and scoped management UI. */
export async function authorizeResource(
  request: Request,
  resource: Resource,
  session: Session | null,
  adminRole = false,
  audit = true,
) {
  if (resource.type === "tenant") {
    await requireTenantManager(request, resource.id, session);
    const [tenant] = await rbacQuery(
      "SELECT id FROM tenants WHERE id=$1 AND disabled_at IS NULL",
      [resource.id],
    );
    if (!tenant) missing();
    return { tenantId: resource.id, site: null };
  }
  const [row] = await rbacQuery(
    "SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL",
    [resource.id],
  );
  if (!row) missing();
  const site = toSite(row);
  await requirePermission(
    request,
    site,
    adminRole ? "site.admins.manage" : "site.members.manage",
    session,
    audit,
  );
  return { tenantId: site.tenantId, site };
}
export async function listBindings(request: Request, resource: Resource) {
  const session = await resolveSession(request);
  const { site } = await authorizeResource(request, resource, session);
  const canManageAdmins =
    !site ||
    Boolean(
      (await describePermissions(request, site, session)).canManageAdmins,
    );
  const offset = pageOffset(request);
  const rows = await rbacQuery(
    `SELECT b.*,COALESCE(u.display_name,u.email,t.name) AS subject_name FROM role_bindings b LEFT JOIN users u ON u.id=b.subject_user_id LEFT JOIN tenants t ON t.id=b.subject_tenant_id WHERE ${resource.type === "site" ? "b.resource_site_id" : "b.resource_tenant_id"}=$1 ORDER BY b.created_at,b.id LIMIT 51 OFFSET $2`,
    [resource.id, offset],
  );
  return {
    bindings: rows
      .slice(0, 50)
      .map((row) => ({
        ...bindingResult(row),
        canEdit: row.role_id !== "site-admin" || canManageAdmins,
      })),
    nextCursor: rows.length > 50 ? String(offset + 50) : null,
  };
}
export async function availableRoles(
  request: Request,
  resource: Resource,
  subjectType: string,
) {
  subjectType = z.enum(["user", "tenant", "everyone"]).parse(subjectType);
  const session = await resolveSession(request);
  const { site } = await authorizeResource(request, resource, session);
  let ids =
    resource.type === "tenant"
      ? ["tenant-admin"]
      : ["viewer", "commenter", "editor"];
  if (site && subjectType !== "everyone") {
    try {
      await requirePermission(
        request,
        site,
        "site.admins.manage",
        session,
        false,
      );
      ids.push("site-admin");
    } catch (e) {
      if (!(e instanceof EditForbiddenError)) throw e;
    }
  }
  if (resource.type === "tenant" && subjectType !== "user") ids = [];
  const rows = await rbacQuery(
    "SELECT role_id,permission_code FROM role_permissions ORDER BY permission_code",
  );
  return {
    roles: ids.map((id) => ({
      id,
      permissions: rows
        .filter((r) => r.role_id === id)
        .map((r) => r.permission_code),
    })),
  };
}
/** Identity is resolved before the lock; all mutable facts and grants are checked again inside. */
export async function mutateBinding(
  request: Request,
  input: unknown,
  bindingId?: string,
  remove = false,
) {
  if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
  const session = await resolveSession(request);
  await assertPresentedBearerAlive(request, session);
  checkRateLimit(
    request,
    Date.now(),
    `authorization:${session?.userId ?? clientKey(request)}`,
    60,
    60,
  );
  const parsed = bindingId
    ? remove
      ? deleteBindingSchema.parse(input)
      : updateBindingSchema.parse(input)
    : createBindingSchema.parse(input);
  return rbacTransaction(async (q) => {
    await assertSessionCurrent(q, session);
    const [old] = bindingId
      ? await q("SELECT * FROM role_bindings WHERE id=$1", [bindingId])
      : [];
    if (bindingId && !old) missing();
    const creation = !bindingId
      ? (parsed as z.infer<typeof createBindingSchema>)
      : null;
    const resource = creation?.resource ?? bindingResource(old);
    const roleId = "roleId" in parsed ? parsed.roleId : (old.role_id as string);
    const subject = creation?.subject ?? {
      type: old.subject_type as "user" | "tenant" | "everyone",
      id: (old.subject_user_id ?? old.subject_tenant_id) as string,
    };
    const { tenantId, site } = await authorizeResource(
      request,
      resource,
      session,
      roleId === "site-admin" || old?.role_id === "site-admin",
      false,
    );
    if (
      old &&
      Number(old.revision) !==
        (
          parsed as {
            expectedRevision: number;
          }
        ).expectedRevision
    )
      conflict("Authorization changed; refresh before saving");
    const legal =
      resource.type === "tenant"
        ? ["tenant-admin"]
        : ["viewer", "commenter", "editor", "site-admin"];
    if (
      !legal.includes(roleId) ||
      (subject.type === "everyone" && roleId === "site-admin") ||
      (resource.type === "tenant" && subject.type !== "user")
    )
      throw new BadRequestError(
        "Invalid subject, resource or role combination",
      );
    if (!remove) {
      if (subject.type === "user") {
        if (!(await memberRole(tenantId, subject.id!)))
          throw new BadRequestError(
            "The user must be an active member of the resource tenant",
          );
        if (site?.ownerId === subject.id)
          throw new BadRequestError(
            "Change ownership through ownership transfer",
          );
      } else if (subject.type === "tenant" && subject.id !== tenantId)
        throw new BadRequestError(
          "Only the resource tenant can be granted access",
        );
      if (tenantId === "anonymous")
        throw new BadRequestError(
          "Claim the anonymous artifact before assigning roles",
        );
    }
    if (remove && resource.type === "tenant") {
      const admins = await q(
        "SELECT m.user_id FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND m.role='admin' AND u.disabled_at IS NULL",
        [tenantId],
      );
      if (
        admins.length <= 1 &&
        admins.some((r) => r.user_id === old.subject_user_id)
      )
        throw new BadRequestError(
          "Cannot remove the last active tenant administrator",
        );
    }
    const now = Date.now();
    let result: Row | undefined;
    if (remove) await q("DELETE FROM role_bindings WHERE id=$1", [bindingId!]);
    else if (old)
      [result] = await q(
        "UPDATE role_bindings SET role_id=$1,revision=revision+1,updated_at=$2 WHERE id=$3 RETURNING *",
        [roleId, now, bindingId!],
      );
    else {
      const [existing] = await q(
        `SELECT * FROM role_bindings WHERE ${resource.type === "site" ? "resource_site_id" : "resource_tenant_id"}=$1 AND subject_type=$2 AND COALESCE(subject_user_id,subject_tenant_id,'')=$3`,
        [
          resource.id,
          subject.type,
          subject.type === "everyone" ? "" : subject.id!,
        ],
      );
      if (existing) {
        if (existing.role_id === roleId) return bindingResult(existing);
        conflict("Authorization already exists; edit it instead");
      }
      [result] = await q(
        "INSERT INTO role_bindings(id,subject_type,subject_user_id,subject_tenant_id,resource_type,resource_tenant_id,resource_site_id,role_id,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *",
        [
          createId("binding"),
          subject.type,
          subject.type === "user" ? subject.id! : null,
          subject.type === "tenant" ? subject.id! : null,
          resource.type,
          resource.type === "tenant" ? resource.id : null,
          resource.type === "site" ? resource.id : null,
          roleId,
          session?.userId ?? null,
          now,
        ],
      );
    }
    await recordRbacAudit(
      q,
      tenantId,
      session?.userId ?? null,
      remove ? "authorization.revoke" : "authorization.grant",
      resource.id,
      JSON.stringify({
        subject,
        roleId,
        bindingId: bindingId ?? result?.id,
        managementReason: managementReason(request),
      }),
    );
    return result ? bindingResult(result) : { ok: true };
  });
}
export async function authorizationSubjects(
  request: Request,
  resource: Resource,
) {
  const session = await resolveSession(request);
  const { tenantId } = await authorizeResource(request, resource, session);
  const p = new URL(request.url).searchParams;
  if (p.get("type") === "tenant")
    return {
      subjects: await rbacQuery("SELECT id,name FROM tenants WHERE id=$1", [
        tenantId,
      ]),
    };
  const term = (p.get("q") ?? "").slice(0, 100);
  const offset = pageOffset(request);
  const rows = await rbacQuery(
    "SELECT u.id,u.display_name,u.email FROM tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND u.disabled_at IS NULL AND (LOWER(COALESCE(u.display_name,'')) LIKE LOWER($2) ESCAPE '!' OR LOWER(COALESCE(u.email,'')) LIKE LOWER($2) ESCAPE '!') ORDER BY u.id LIMIT 51 OFFSET $3",
    [tenantId, searchPattern(term), offset],
  );
  return {
    subjects: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? String(offset + 50) : null,
  };
}
export async function authorizationResources(request: Request) {
  const session = await resolveSession(request),
    platform = await resolveAdmin(request, session);
  if (!session && !platform) throw new AuthError("Please sign in first");
  const p = new URL(request.url).searchParams,
    type = p.get("type") === "tenant" ? "tenant" : "site";
  const offset = pageOffset(request);
  const term =
    searchPattern(p.get("q") ?? "");
  const uid = session?.userId ?? "";
  const management = !session || !isTokenSession(session);
  const filter = platform
    ? "1=1"
    : type === "tenant" && !management
      ? "1=0"
      : type === "tenant"
        ? "EXISTS(SELECT 1 FROM authorization_tenant_members m WHERE m.tenant_id=r.id AND m.user_id=$2 AND m.role='admin')"
        : `((r.owner_id=$2 AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=r.tenant_id AND m.user_id=$2)) OR EXISTS(SELECT 1 FROM authorization_site_members m WHERE m.site_id=r.id AND m.user_id=$2 AND m.role='admin') ${management ? "OR EXISTS(SELECT 1 FROM authorization_tenant_members m WHERE m.tenant_id=r.tenant_id AND m.user_id=$2 AND m.role='admin')" : ""})`;
  // Always bind user ID, including the platform path, to keep placeholder numbering portable.
  const rows = await rbacQuery(
    `SELECT r.id,${type === "tenant" ? "r.name" : "r.title AS name,r.slug,r.tenant_id"} FROM ${type === "tenant" ? "tenants" : "sites"} r WHERE ${type === "tenant" ? "r.disabled_at IS NULL AND r.id<>'anonymous'" : "r.deleted_at IS NULL AND EXISTS(SELECT 1 FROM tenants t WHERE t.id=r.tenant_id AND t.disabled_at IS NULL)"} AND LOWER(${type === "tenant" ? "r.name" : "r.title"}) LIKE LOWER($1) ESCAPE '!' AND (CAST($2 AS TEXT) IS NOT NULL) AND (${filter}) ORDER BY r.id LIMIT 51 OFFSET $3`,
    [term, uid, offset],
  );
  return {
    resources: rows.slice(0, 50),
    nextCursor: rows.length > 50 ? String(offset + 50) : null,
  };
}
export async function effectiveAuthorization(
  request: Request,
  resource: Resource,
) {
  const session = await resolveSession(request);
  if (resource.type === "tenant")
    return {
      role: session ? await memberRole(resource.id, session.userId) : null,
    };
  const [row] = await rbacQuery(
    "SELECT * FROM sites WHERE id=$1 AND deleted_at IS NULL",
    [resource.id],
  );
  if (!row) missing();
  const site = toSite(row);
  const { canReadSite } = await import("@/lib/share");
  if (!(await canReadSite(request, site, session))) missing();
  const sources = session
    ? await rbacQuery(
        "SELECT binding_id,subject_type,role FROM authorization_site_members WHERE site_id=$1 AND user_id=$2",
        [site.id, session.userId],
      )
    : [];
  return {
    permissions: await describePermissions(request, site, session),
    sources,
  };
}
