import "server-only";
import { config } from "@/lib/config";
import { rbacQuery, toSite, toSummary, listFolders } from "@/lib/db";
import { permissionsForRole, resolveViewer } from "@/lib/authz";
import {
  DIRECTORY_PAGE_SIZE,
  type DirectoryPage,
  type DirectoryQuery,
} from "@/lib/directory-query";
import type { Permission } from "@/lib/rbac";
import type { Session } from "@/lib/types";

/** Account directory: bound rows before versions/views aggregates; role views enforce tenant and user status. */
export async function readDirectory(
  viewer: { userId?: string | null; session?: Session | null },
  query: DirectoryQuery,
): Promise<DirectoryPage> {
  const userId = viewer.userId ?? null;
  const folders =
    userId && query.scope !== "public"
      ? (await listFolders(userId)).map((f) => ({
          id: f.id,
          name: f.name,
          createdAt: f.createdAt,
        }))
      : [];
  // A deleted or foreign folder bookmark must agree with the visible All sites filter.
  if (query.folder !== "all" && query.folder !== "unfiled" &&
      !folders.some((folder) => folder.id === query.folder)) {
    // Preserve pagination: bookmarked URLs may keep the invalid folder on later requests.
    query = { ...query, folder: "all" };
  }
  const params: (string | number | null)[] = [userId];
  const add = (v: string | number) => {
    params.push(v);
    return `$${params.length}`;
  };
  const owner = `s.owner_id=$1 AND EXISTS (SELECT 1 FROM authorization_tenant_members m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=s.tenant_id AND m.user_id=$1 AND u.disabled_at IS NULL)`;
  const scope =
    query.scope === "public"
      ? `COALESCE(s.visibility,'public')='public' AND s.taken_down_at IS NULL`
      : query.scope === "owned"
        ? `(${owner})`
        : `EXISTS (SELECT 1 FROM authorization_site_members c WHERE c.site_id=s.id AND c.subject_type<>'everyone' AND c.user_id=$1)`;
  const base = `FROM sites s LEFT JOIN folder_assignments fa ON fa.site_id=s.id AND fa.user_id=$1 WHERE s.deleted_at IS NULL AND s.current_version_id IS NOT NULL AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=s.tenant_id AND t.disabled_at IS NULL) AND (${scope})`;
  const groups = await rbacQuery(
    `SELECT fa.folder_id,COUNT(*) AS n ${base} GROUP BY fa.folder_id`,
    params,
  );
  const counts = { all: 0, unfiled: 0, byId: {} as Record<string, number> };
  for (const g of groups) {
    const n = Number(g.n);
    counts.all += n;
    if (g.folder_id) counts.byId[String(g.folder_id)] = n;
    else counts.unfiled += n;
  }
  let where = base;
  if (query.q)
    where += ` AND lower(s.title) LIKE lower(${add(`%${query.q.replace(/[\\%_]/g, "\\$&")}%`)}) ESCAPE '\\'`;
  if (query.folder !== "all" && query.scope !== "public")
    where +=
      query.folder === "unfiled"
        ? " AND fa.folder_id IS NULL"
        : ` AND fa.folder_id=${add(query.folder)}`;
  const [count] = await rbacQuery(`SELECT COUNT(*) AS n ${where}`, params);
  const total = Number(count.n);
  const page = Math.min(
    query.page,
    Math.max(0, Math.ceil(total / DIRECTORY_PAGE_SIZE) - 1),
  );
  const order =
    query.sort === "title"
      ? "lower(s.title),s.slug"
      : "s.updated_at DESC,s.slug";
  const seq = config.dbDriver === "sqlite" ? "rowid" : "seq";
  const rows = await rbacQuery(
    `WITH selected AS (SELECT s.*,fa.folder_id ${where} ORDER BY ${order} LIMIT ${add(DIRECTORY_PAGE_SIZE)} OFFSET ${add(page * DIRECTORY_PAGE_SIZE)})
    SELECT s.*,v.entry,
      (SELECT COUNT(*) FROM versions vc WHERE vc.site_id=s.id) AS version_count,
      (SELECT COUNT(*) FROM versions ov WHERE ov.site_id=s.id AND ov.${seq} <= (SELECT ${seq} FROM versions WHERE id=s.official_version_id)) AS official_version_number,
      ${query.scope === "owned" ? `(SELECT COUNT(*) FROM site_views sv WHERE sv.site_id=s.id)+(SELECT COUNT(*) FROM share_views sv WHERE sv.site_id=s.id)+COALESCE((SELECT opens FROM archived_view_counts av WHERE av.site_id=s.id),0)` : "NULL"} AS total_views,
      CASE WHEN (${owner}) THEN 'owner'
        WHEN EXISTS (SELECT 1 FROM authorization_site_members c WHERE c.site_id=s.id AND c.user_id=$1 AND c.role='admin') THEN 'site-admin'
        WHEN EXISTS (SELECT 1 FROM authorization_site_members c WHERE c.site_id=s.id AND c.user_id=$1 AND c.role='editor') THEN 'editor'
        WHEN EXISTS (SELECT 1 FROM authorization_site_members c WHERE c.site_id=s.id AND c.user_id=$1 AND c.role='commenter') THEN 'commenter'
        ELSE 'viewer' END AS resolved_role
    FROM selected s LEFT JOIN versions v ON v.id=s.current_version_id ORDER BY ${order}`,
    params,
  );
  const permissions: DirectoryPage["permissions"] = {};
  const assign: Record<string, string> = {};
  if (query.scope !== "public") {
    const grants = await rbacQuery(
      "SELECT role_id,permission_code FROM role_permissions",
    );
    const request = new Request("http://directory/");
    const authViewer = resolveViewer(
      request,
      viewer.session ?? (userId ? ({ userId } as Session) : null),
    );
    for (const row of rows) {
      permissions[String(row.slug)] = permissionsForRole(
        authViewer,
        toSite(row),
        grants
          .filter((g) => g.role_id === row.resolved_role)
          .map((g) => g.permission_code as Permission),
      );
      if (row.folder_id) assign[String(row.slug)] = String(row.folder_id);
    }
  }
  return {
    sites: rows.map(toSummary),
    permissions,
    total,
    query: { ...query, page },
    counts,
    folders: { folders, assign },
  };
}
