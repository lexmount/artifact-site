import type { RbacQuery } from "@/lib/rbac-store";
export const statements = [
  `CREATE TABLE IF NOT EXISTS package_jobs (
    version_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, payload TEXT NOT NULL, title TEXT, target_slug TEXT,
    state TEXT NOT NULL, stage TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0,
    total INTEGER, attempts INTEGER NOT NULL DEFAULT 0, retryable INTEGER NOT NULL DEFAULT 0,
    error TEXT, result TEXT, lease TEXT, lease_until BIGINT NOT NULL DEFAULT 0,
    available_at BIGINT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS package_jobs_pending ON package_jobs(state,available_at,lease_until)",
  "CREATE INDEX IF NOT EXISTS package_jobs_owner ON package_jobs(owner_key,created_at)",
];
export async function up(q: RbacQuery) { for (const sql of statements) await q(sql); }
