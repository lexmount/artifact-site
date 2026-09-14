// GET /api/sites/:slug/events — the site's version feed as Server-Sent Events (contract 2).
//
// "The write-back tells the page itself": whoever lands a new current version is calling our
// api, so the server pushes the news to open viewer pages — no agent self-reporting, no panel
// relay, and every write channel (editor, agent, rollback, build) is covered by construction.
// Read-gated exactly like the page: whoever may look at the site may hear that it moved.
//
// Transport notes, each load-bearing behind a proxy:
//   X-Accel-Buffering: no   nginx-family gateways (most PaaS ingresses) buffer streaming
//                           responses by default, which would hold events until the buffer
//                           flushes — the one config this endpoint cannot survive.
//   keep-alive comments     every 25s, so idle-connection reapers see traffic.
//   request.signal          Next aborts it when the reader leaves; everything unsubscribes there.
import { listVersions } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { canReadSite } from "@/lib/share";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";
import { rateLimit as rateLimitCfg } from "@/lib/config";
import { subscribeSiteVersion } from "@/lib/site-events";
import { errorResponse, json } from "../../../_util";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 25_000;

const ordinalMemo = new Map<string, Promise<number | undefined>>();
const ORDINAL_MEMO_MAX = 200;

/**
 * Which ordinal this version is, counted from the site's first — NOT the version count.
 *
 * The two agree only while every commit appends. `setCurrentVersion` (the third notify door) can
 * in principle move `current` BACKWARD without adding a row, and then a count would announce
 * «Artifact updated to v7» over a page rendering v3. No production caller does that today — rollback creates
 * a fresh version and commits it forward — but the door is wired to the feed, so the number is
 * computed from position instead of from the total, and stays honest whatever comes through it.
 */
function versionOrdinal(siteId: string, versionId: string): Promise<number | undefined> {
  // Memoised on the PROMISE, not the value: one commit fans out to every subscriber of that site
  // at once, and caching only after the await would still let them all stampede the same query.
  // A version's ordinal never changes (versions are immutable and never removed), so the entry
  // stays valid for as long as it is kept; a failed lookup evicts itself so the next event retries.
  const key = `${siteId}:${versionId}`;
  let pending = ordinalMemo.get(key);
  if (!pending) {
    pending = listVersions(siteId)
      .then((rows) => { // newest first
        const index = rows.findIndex((v) => v.id === versionId);
        return index >= 0 ? rows.length - index : undefined;
      })
      .catch((err) => {
        ordinalMemo.delete(key);
        throw err;
      });
    if (ordinalMemo.size >= ORDINAL_MEMO_MAX) {
      const oldest = ordinalMemo.keys().next().value;
      if (oldest !== undefined) ordinalMemo.delete(oldest);
    }
    ordinalMemo.set(key, pending);
  }
  return pending;
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  try {
    // Rate-limited, but in its OWN namespace and far more generously than the write paths.
    //
    // Sharing the plain per-IP bucket (as the first cut did) makes a reader's tab-switching spend
    // the budget that publishing depends on: every return to a foreground tab reopens the stream,
    // and after ~20 of them the next POST /versions from that address is refused — an office
    // behind one NAT would hit it sooner still. The module's own doc says to namespace keys for
    // exactly this reason, and the anti-scan arm of passcode entry is the precedent for pairing
    // that with a roomier ceiling: connecting to a feed is not the abuse this budget guards.
    checkRateLimit(request, Date.now(), `events:${clientKey(request)}`, rateLimitCfg.burst * 10);
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    if (!(await canReadSite(request, view.site))) return json({ error: "site not found" }, 404);

    const encoder = new TextEncoder();
    const siteId = view.site.id;
    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (chunk: string) => {
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // Controller already closed — the abort handler below is about to clean up.
          }
        };
        // A REAL event, not just a comment: a buffering proxy forwards the response head (so
        // EventSource fires `open` and never errors) while holding the body — the exact failure
        // this deployment is warned about. Comments are invisible to the EventSource parser, so
        // only a dispatched `hello` proves the body flows; the client arms a watchdog on it and
        // falls back to polling if it never lands. `retry` also sets the browser's reconnect gap.
        send(`retry: 5000\nevent: hello\ndata: ${JSON.stringify({ slug })}\n\n`);

        unsubscribe = subscribeSiteVersion(siteId, (event) => {
          // versionNumber is a courtesy for the toast («Artifact updated to v5»); the id is the truth.
          void versionOrdinal(siteId, event.versionId)
            .then((n) => send(`event: version\ndata: ${JSON.stringify({ slug, versionId: event.versionId, versionNumber: n })}\n\n`))
            .catch(() => send(`event: version\ndata: ${JSON.stringify({ slug, versionId: event.versionId })}\n\n`));
        });
        keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);

        request.signal.addEventListener("abort", () => {
          if (keepalive) clearInterval(keepalive);
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
      cancel() {
        if (keepalive) clearInterval(keepalive);
        unsubscribe?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
