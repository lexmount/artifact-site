// Version events — "the write-back tells the page itself".
//
// Whoever lands a new current version (web editor, agent write-back, rollback, build) is calling
// OUR api; the moment that commit succeeds the server knows, so the server notifies the open
// viewer pages — no agent has to remember to announce itself, and every write path is covered.
//
// Two transports behind one emitter, chosen by the metadata driver:
//   sqlite   single-replica by contract → an in-process EventEmitter is complete.
//   postgres NOTIFY/LISTEN — the bus every replica already shares. The publishing replica does
//            NOT also emit locally: its own LISTEN connection receives the NOTIFY like everyone
//            else's, which is what keeps one commit = one event on every replica including self.
//
// Failure posture mirrors the view log: notification is bookkeeping. A failed NOTIFY or a downed
// listener never breaks the write it rode on; subscribers simply miss a beat and the page's
// polling fallback covers them.
import { EventEmitter } from "node:events";
import pg from "pg";
import { config } from "@/lib/config";

export interface SiteVersionEvent {
  siteId: string;
  versionId: string;
}

const CHANNEL = "artifact_site_events";
const RECONNECT_DELAY_MS = 3_000;

const emitter = new EventEmitter();
// Viewer pages are cheap but numerous; never let Node warn about a busy site.
emitter.setMaxListeners(0);

let listener: pg.Client | null = null;
let listenerStarting = false;
let closed = false;

function usesPg(): boolean {
  return config.dbDriver === "postgres";
}

/** The LISTEN half: one dedicated client per process, lazily started, self-healing. */
function ensurePgListener(): void {
  if (listener || listenerStarting || closed) return;
  listenerStarting = true;
  const client = new pg.Client({ connectionString: config.databaseUrl });
  client
    .connect()
    .then(async () => {
      client.on("notification", (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          const parsed = JSON.parse(msg.payload) as Partial<SiteVersionEvent>;
          if (typeof parsed.siteId === "string" && typeof parsed.versionId === "string") {
            emitter.emit(parsed.siteId, { siteId: parsed.siteId, versionId: parsed.versionId });
          }
        } catch {
          // A malformed payload is somebody's bug, not a reason to kill the bus.
        }
      });
      client.on("error", () => reconnect(client));
      client.on("end", () => reconnect(client));
      await client.query(`LISTEN ${CHANNEL}`);
      listener = client;
      listenerStarting = false;
    })
    .catch(() => reconnect(client));
}

function reconnect(dead: pg.Client): void {
  if (listener === dead) listener = null;
  listenerStarting = false;
  void dead.end().catch(() => {});
  if (closed) return;
  setTimeout(() => {
    if (emitter.eventNames().length > 0) ensurePgListener(); // only while somebody still listens
  }, RECONNECT_DELAY_MS).unref?.();
}

/**
 * Announce a committed current-version change. Fire-and-forget by design — call it AFTER the
 * commit, never awaited into a write path's failure story.
 */
export function notifySiteVersion(siteId: string, versionId: string): void {
  const event: SiteVersionEvent = { siteId, versionId };
  if (!usesPg()) {
    emitter.emit(siteId, event);
    return;
  }
  // A short-lived connection per publish: version commits are minutes-apart human/agent actions,
  // and one TCP+auth handshake is nothing next to holding a standing connection per replica.
  // The local emitter deliberately does NOT fire here — this replica's LISTEN hears the NOTIFY
  // like every other replica's, so one commit is one event everywhere, self included.
  const client = new pg.Client({ connectionString: config.databaseUrl });
  void client
    .connect()
    .then(() => client.query("SELECT pg_notify($1, $2)", [CHANNEL, JSON.stringify(event)]))
    .catch(() => {})
    .finally(() => void client.end().catch(() => {}));
}

/** Subscribe to one site's version events. Returns the unsubscribe. */
export function subscribeSiteVersion(siteId: string, cb: (event: SiteVersionEvent) => void): () => void {
  if (usesPg()) ensurePgListener();
  emitter.on(siteId, cb);
  return () => {
    emitter.off(siteId, cb);
  };
}

/** Tests only: drop the listener so a suite can end without an open handle. */
export async function closeSiteEventsForTests(): Promise<void> {
  closed = true;
  emitter.removeAllListeners();
  const dead = listener;
  listener = null;
  if (dead) await dead.end().catch(() => {});
  closed = false;
}
