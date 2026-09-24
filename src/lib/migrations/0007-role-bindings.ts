import type { RbacQuery } from "@/lib/rbac-store";
// This seed is frozen with the migration. Future permission changes require a new migration.
const ownComments = [
  "comment.read",
  "comment.create",
  "comment.reply",
  "comment.editOwn",
  "comment.deleteOwn",
  "comment.resolveOwn",
];
const editor = [
  "site.read",
  "site.content.edit",
  "site.history.read",
  "site.source.export",
  "comment.resolve",
  ...ownComments,
];
const manager = [
  ...editor,
  "site.rename",
  "site.version.rollback",
  "site.version.official.manage",
  "site.sharing.manage",
  "site.members.manage",
  "site.audit.read",
  "comment.moderate",
  "comment.aggregate",
];
const owner = [
  ...manager,
  "site.admins.manage",
  "site.delete",
  "site.owner.transfer",
];
const tenant = [
  ...owner,
  "site.create",
  "tenant.manage",
  "tenant.members.manage",
];
const platform = [
  ...tenant,
  "platform.tenants.manage",
  "platform.users.manage",
];
const catalog: Record<string, string[]> = {
  "platform-admin": platform,
  "tenant-admin": tenant,
  "tenant-member": ["site.create"],
  owner,
  "site-admin": manager,
  editor,
  commenter: ["site.read", ...ownComments],
  viewer: ["site.read"],
};
export const statements = [
  `CREATE TABLE IF NOT EXISTS permissions (code TEXT PRIMARY KEY, resource_type TEXT NOT NULL CHECK(resource_type IN ('platform','tenant','site')), description TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, code TEXT NOT NULL, resource_type TEXT NOT NULL CHECK(resource_type IN ('platform','tenant','site')), tenant_id TEXT REFERENCES tenants(id), is_builtin BOOLEAN NOT NULL, description TEXT NOT NULL, created_at BIGINT NOT NULL, CHECK ((is_builtin=TRUE AND tenant_id IS NULL) OR (is_builtin=FALSE AND tenant_id IS NOT NULL)), UNIQUE(id,resource_type))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS roles_builtin_code ON roles(code) WHERE tenant_id IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS roles_tenant_code ON roles(tenant_id,code) WHERE tenant_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS role_permissions (role_id TEXT NOT NULL REFERENCES roles(id), permission_code TEXT NOT NULL REFERENCES permissions(code), PRIMARY KEY(role_id,permission_code))`,
  `CREATE TABLE IF NOT EXISTS role_bindings (
 id TEXT PRIMARY KEY,
 subject_type TEXT NOT NULL CHECK(subject_type IN ('user','tenant','everyone')),
 subject_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 subject_tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
 resource_type TEXT NOT NULL CHECK(resource_type IN ('tenant','site')),
 resource_tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
 resource_site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
 role_id TEXT NOT NULL,
 created_by TEXT,
 created_at BIGINT NOT NULL,
 updated_at BIGINT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 FOREIGN KEY(role_id,resource_type) REFERENCES roles(id,resource_type),
 CHECK ((subject_type='user' AND subject_user_id IS NOT NULL AND subject_tenant_id IS NULL) OR (subject_type='tenant' AND subject_user_id IS NULL AND subject_tenant_id IS NOT NULL) OR (subject_type='everyone' AND subject_user_id IS NULL AND subject_tenant_id IS NULL)),
 CHECK ((resource_type='tenant' AND resource_tenant_id IS NOT NULL AND resource_site_id IS NULL AND subject_type='user' AND role_id='tenant-admin') OR (resource_type='site' AND resource_tenant_id IS NULL AND resource_site_id IS NOT NULL AND role_id IN ('site-admin','editor','commenter','viewer'))),
 CHECK(subject_type<>'everyone' OR role_id<>'site-admin')
 )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS binding_identity ON role_bindings(resource_type,COALESCE(resource_tenant_id,resource_site_id),subject_type,COALESCE(subject_user_id,subject_tenant_id,''))`,
  `CREATE INDEX IF NOT EXISTS binding_user ON role_bindings(subject_user_id,resource_site_id)`,
  `CREATE INDEX IF NOT EXISTS binding_tenant ON role_bindings(subject_tenant_id,resource_site_id)`,
  `CREATE INDEX IF NOT EXISTS binding_site ON role_bindings(resource_site_id)`,
  `CREATE INDEX IF NOT EXISTS binding_organization ON role_bindings(resource_tenant_id)`,
  ...Object.entries(catalog).flatMap(([role, permissions]) => [
    `INSERT INTO roles(id,code,resource_type,is_builtin,description,created_at) VALUES('${role}','${role}','${role.startsWith("platform") ? "platform" : role.startsWith("tenant") ? "tenant" : "site"}',TRUE,'${role}',0) ON CONFLICT DO NOTHING`,
    ...permissions.flatMap((p) => [
      `INSERT INTO permissions(code,resource_type,description) VALUES('${p}','${p.startsWith("platform.") ? "platform" : p.startsWith("tenant.") || p === "site.create" ? "tenant" : "site"}','${p}') ON CONFLICT DO NOTHING`,
      `INSERT INTO role_permissions(role_id,permission_code) VALUES('${role}','${p}') ON CONFLICT DO NOTHING`,
    ]),
  ]),
  `INSERT INTO role_bindings(id,subject_type,subject_user_id,resource_type,resource_tenant_id,role_id,created_at,updated_at) SELECT 'migrated-tenant:'||tenant_id||':'||user_id,'user',user_id,'tenant',tenant_id,'tenant-admin',0,0 FROM tenant_members WHERE role='admin' ON CONFLICT DO NOTHING`,
  `INSERT INTO role_bindings(id,subject_type,subject_user_id,resource_type,resource_site_id,role_id,created_by,created_at,updated_at) SELECT 'migrated-site:'||site_id||':'||user_id,'user',user_id,'site',site_id,CASE WHEN role='admin' THEN 'site-admin' ELSE 'editor' END,granted_by,granted_at,granted_at FROM site_members WHERE EXISTS(SELECT 1 FROM sites s JOIN tenant_members m ON m.tenant_id=s.tenant_id AND m.user_id=site_members.user_id WHERE s.id=site_members.site_id) ON CONFLICT DO NOTHING`,
  // Read-only projections: no legacy role column participates in authorization.
  `DROP VIEW IF EXISTS authorization_tenant_members`,
  `CREATE VIEW authorization_tenant_members AS SELECT m.tenant_id,m.user_id,CASE WHEN EXISTS(SELECT 1 FROM role_bindings b WHERE b.resource_tenant_id=m.tenant_id AND b.subject_user_id=m.user_id AND b.role_id='tenant-admin') THEN 'admin' ELSE 'member' END AS role FROM tenant_members m`,
  `DROP VIEW IF EXISTS authorization_site_members`,
  `CREATE VIEW authorization_site_members AS SELECT b.resource_site_id AS site_id,u.id AS user_id,CASE WHEN b.role_id='site-admin' THEN 'admin' ELSE b.role_id END AS role,b.created_by AS granted_by,b.created_at AS granted_at,b.id AS binding_id,b.subject_type FROM role_bindings b JOIN sites s ON s.id=b.resource_site_id JOIN tenants t ON t.id=s.tenant_id JOIN users u ON u.disabled_at IS NULL WHERE t.disabled_at IS NULL AND ((b.subject_type='user' AND b.subject_user_id=u.id AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=s.tenant_id AND m.user_id=u.id)) OR (b.subject_type='tenant' AND b.subject_tenant_id=s.tenant_id AND EXISTS(SELECT 1 FROM tenant_members m WHERE m.tenant_id=b.subject_tenant_id AND m.user_id=u.id)) OR (b.subject_type='everyone' AND s.taken_down_at IS NULL))`,
];
export async function up(q: RbacQuery) {
  for (const statement of statements) await q(statement);
}
