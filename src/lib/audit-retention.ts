import "server-only";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { config } from "@/lib/config";
import { rbacTransaction } from "@/lib/db";

const TABLES = ["audit_log", "admin_log", "rbac_audit"] as const;
// This transaction holds the global RBAC lock: membership, ownership, user creation and
// settings writes wait behind it. Keep batches small; drain more batches instead of raising this.
const MAX_BATCH = 1000;

/** One bounded batch per table. Read policy inside the same transaction as deletion,
 * bypassing the settings cache. Settings writes serialize with this transaction on both
 * backends, so a disable/increase that has committed cannot be overtaken by stale cleanup.
 * PostgreSQL uses the advisory lock and process slot; SQLite serializes all operations on
 * its single connection, including writeSettings' synchronous BEGIN. No network I/O belongs here.
 */
export async function pruneAuditLogs({ now = Date.now(), limit = MAX_BATCH }: { now?: number; limit?: number } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isInteger(limit) || limit < 1 || limit > MAX_BATCH) {
    throw new Error("Invalid audit retention batch parameters");
  }
  return rbacTransaction(async (q) => {
    const rows = await q("SELECT value FROM settings WHERE scope='global' AND key='auditRetentionDays'");
    let retentionDays = config.auditRetentionDays;
    if (rows.length) {
      // A malformed override fails closed, rather than falling back to destructive cleanup.
      try { retentionDays = JSON.parse(String(rows[0].value)); } catch { retentionDays = 0; }
      if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) retentionDays = 0;
    }
    const deleted = { audit_log: 0, admin_log: 0, rbac_audit: 0 };
    if (retentionDays > 0) {
      const cutoff = now - retentionDays * 86_400_000;
      for (const table of TABLES) {
        const removed = await q(`DELETE FROM ${table} WHERE id IN (
          SELECT id FROM ${table} WHERE created_at < $1 ORDER BY created_at,id LIMIT $2
        ) RETURNING id`, [cutoff, limit]);
        deleted[table] = removed.length;
      }
    }
    return { retentionDays, deleted };
  });
}


/** Drain within a soft time budget. Each batch releases its transaction/lock and re-reads
 * policy. Yield between batches so queued requests can change policy or perform RBAC writes.
 * An in-flight batch may finish after the deadline; no further batch starts afterward.
 */
export async function pruneAuditLogsJob({ now = Date.now(), limit = MAX_BATCH, budgetMs = 20_000 }: {
  now?: number; limit?: number; budgetMs?: number;
} = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 20_000) throw new Error("Invalid audit retention time budget");
  const deadline = performance.now() + budgetMs;
  const deleted = { audit_log: 0, admin_log: 0, rbac_audit: 0 };
  let batches = 0;
  let retentionDays = 0;
  let more = false;
  do {
    const batch = await pruneAuditLogs({ now, limit });
    batches++;
    retentionDays = batch.retentionDays;
    for (const table of TABLES) deleted[table] += batch.deleted[table];
    more = retentionDays > 0 && TABLES.some(table => batch.deleted[table] === limit);
    if (!more) break;
    await yieldToEventLoop();
  } while (performance.now() < deadline);
  return { retentionDays, deleted, batches, budgetExhausted: more };
}
