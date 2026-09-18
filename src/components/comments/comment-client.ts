import type { CommentPage, CommentThreadDetail } from "@/lib/comments/contracts";

/** Share credentials stay in host requests, never in preview messages or comment JSON. */
export function commentHeaders(shareToken?: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (shareToken) headers.set("x-artifact-share", shareToken);
  return headers;
}
export class CommentRequestError extends Error {
  constructor(public status: number) { super(`Comment request failed (${status})`); }
}
export async function commentRequest<T>(url: string, shareToken?: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: commentHeaders(shareToken), cache: "no-store" });
  if (!response.ok) throw new CommentRequestError(response.status);
  return response.json() as Promise<T>;
}
export function mergeThreads(current: CommentThreadDetail[], page: CommentPage<CommentThreadDetail>): CommentThreadDetail[] {
  const rows = new Map(current.map(row => [row.thread.id, row]));
  for (const row of page.items) rows.set(row.thread.id, row);
  return [...rows.values()];
}

/** Visible panels poll normally; consecutive failures back off without becoming permanent. */
export function commentPollDelay(failures: number): number {
  return Math.min(120_000, 10_000 * 2 ** Math.min(4, Math.max(0, failures)));
}

/** Revalidate the entire expanded window, including deletions and current cursors. */
export async function refreshCommentWindow<T>(depth: number, read: (cursor?: string) => Promise<CommentPage<T>>): Promise<CommentPage<T>> {
  const result: CommentPage<T> = { items: [], nextCursor: null };
  let cursor: string | undefined;
  for (let index = 0; index < depth; index++) {
    const page = await read(cursor);
    if (index === 0 && page.total !== undefined) result.total = page.total;
    result.items.push(...page.items);
    result.nextCursor = page.nextCursor;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return result;
}

/** Discover immediately; retry transient failures quietly and resume on foreground events. */
export function discoverCommentPermissions<T>(
  read: () => Promise<T>, accept: (value: T) => void, hidden: () => boolean,
  denied: (status: number) => void = () => {},
): { stop: () => void; resume: () => void } {
  let active = true, inFlight = false, retryable = true;
  let failures = 0;
  let lastForegroundAttempt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => { timer = setTimeout(() => void attempt(), commentPollDelay(failures)); };
  const attempt = async (initial = false) => {
    if (!active || inFlight || !retryable) return;
    clearTimeout(timer);
    if (!initial && hidden()) { schedule(); return; }
    inFlight = true;
    try {
      const value = await read();
      if (active) { retryable = false; accept(value); }
    } catch (error) {
      if (!active) return;
      if (error instanceof CommentRequestError && error.status !== 429 && error.status < 500) {
        // A changed login can recover 401 on focus, but never poll a permanent denial.
        retryable = error.status === 401;
        denied(error.status);
        return;
      }
      schedule();
      failures++;
    } finally { inFlight = false; }
  };
  void attempt(true);
  return {
    stop: () => { active = false; clearTimeout(timer); },
    resume: () => {
      // Moving focus out of the sandbox also focuses the host. Do not turn those clicks
      // into an outage retry loop; the first foreground recovery remains immediate.
      if (!active || inFlight || !retryable || hidden() || Date.now() - lastForegroundAttempt < 3_000) return;
      lastForegroundAttempt = Date.now();
      void attempt();
    },
  };
}
