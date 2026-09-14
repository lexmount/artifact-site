// Run bookkeeping AFTER the response has been sent.
//
// The reader pages log a view row on every opening. That write (a collapse-window SELECT plus an
// INSERT) sat in the render path, so on a Postgres deployment every page paid two extra network
// round-trips before the reader saw a byte. Next's `after()` moves it past the response; this
// wrapper exists because `after()` throws outside a request scope — which is exactly how the page
// tests invoke these components (they await the RSC function directly, no Next runtime). There the
// task runs immediately instead, and its promise is tracked so tests can await completion before
// asserting on rows or closing the database.
import { after } from "next/server";

const pending: Promise<unknown>[] = [];

export function afterResponse(task: () => Promise<unknown>): void {
  try {
    after(task);
  } catch {
    // Outside a Next request scope (direct page invocation in tests): run now, remember the
    // promise. Errors are swallowed exactly like the logging helpers themselves do — bookkeeping
    // must never break the read, in production or in a test teardown.
    pending.push(task().catch(() => {}));
  }
}

/** Await every fallback-mode task started so far. No-op under a real Next runtime. */
export async function flushAfterResponseForTests(): Promise<void> {
  await Promise.all(pending.splice(0));
}
