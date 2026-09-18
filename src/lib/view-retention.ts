import "server-only";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { config } from "@/lib/config";
import { pruneShareViews, pruneSiteViews } from "@/lib/db";

/** Drain in atomic 1,000-row batches, alternating tables within a soft 20-second budget.
 * Each batch releases its locks and yields; an in-flight batch may finish after the deadline.
 */
export async function pruneViewDetails(now = Date.now()): Promise<number> {
  const days = config.viewRetentionDays;
  if (!days) return 0;
  const before = now - days * 86_400_000;
  const deadline = performance.now() + 20_000;
  const pending = [pruneShareViews, pruneSiteViews];
  let deleted = 0;
  while (pending.length && performance.now() < deadline) {
    const prune = pending.shift()!;
    const count = await prune(before);
    deleted += count;
    if (count === 1000) pending.push(prune);
    if (pending.length) await yieldToEventLoop();
  }
  return deleted;
}
