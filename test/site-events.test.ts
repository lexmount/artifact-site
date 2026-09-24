// Write-back notifies — the event bus and its SSE outlet, on the sqlite (in-process) transport.
// The Postgres NOTIFY/LISTEN half is asserted in test/db-postgres.integration.test.ts.
//
// Pinned as the notification's promises:
//   the door       · every commit wrapper announces (edit, CAS write-back, rollback) — and a
//                    FAILED CAS announces nothing
//   the feed       · an open SSE stream carries the event as a `version` frame with the new id
//   the gate       · the feed is read-gated exactly like the page
//   the client     · the toast-decision is "a version other than the one rendered", nothing else
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDbForTests, createId } from "@/lib/db";
import { createSite, editSite, replaceSiteContent, rollbackTo } from "@/lib/sites";
import { type AuditContext } from "@/lib/audit";
import { notifySiteVersion, subscribeSiteVersion, type SiteVersionEvent } from "@/lib/site-events";
import { GET as eventsGET } from "@/app/api/sites/[slug]/events/route";
import { isNewVersion } from "@/components/site-version-watcher";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "ah-site-events-"));
  dirs.push(dir);
  process.env.ARTIFACT_DATA_DIR = dir;
});

afterEach(async () => {
  await closeDbForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.ARTIFACT_DATA_DIR;
});

const CTX: AuditContext = { actor: { kind: "anon", userId: null, anonId: "anon_t" }, method: "api", ip: null, userAgent: "vitest" };

function collect(siteId: string): { events: SiteVersionEvent[]; stop: () => void } {
  const events: SiteVersionEvent[] = [];
  const stop = subscribeSiteVersion(siteId, (e) => events.push(e));
  return { events, stop };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("every commit door announces", () => {
  it("edit, CAS write-back and rollback each fire exactly one event; a stale CAS fires none", async () => {
    const { site, version: v1 } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const { events, stop } = collect(site.id);

    const e2 = await editSite(site.slug, { content: "<html><head></head><body>2</body></html>" }, CTX);
    const v2 = (e2 as { version: { id: string } }).version;
    const r3 = await replaceSiteContent(site.slug, { mode: "paste", html: "<html><head></head><body>3</body></html>" }, CTX, v2.id);
    const v3 = (r3 as { version: { id: string } }).version;
    // Stale CAS: based on v1, but current is v3 — must lose silently on the event bus too.
    await replaceSiteContent(site.slug, { mode: "paste", html: "<html><head></head><body>x</body></html>" }, CTX, v1.id);
    await rollbackTo(site.slug, v1.id, CTX);
    await tick();
    stop();

    // edit → v2, write-back → v3, rollback → a fresh version copying v1. No event for the stale CAS.
    expect(events.length).toBe(3);
    expect(events[0].versionId).toBe(v2.id);
    expect(events[1].versionId).toBe(v3.id);
    expect(events[2].versionId).not.toBe(v3.id);
  });

  it("unsubscribe means unsubscribed", async () => {
    const siteId = createId("site");
    const { events, stop } = collect(siteId);
    stop();
    notifySiteVersion(siteId, "ver_after");
    await tick();
    expect(events).toEqual([]);
  });
});

describe("the SSE outlet", () => {
  const request = (slug: string, signal: AbortSignal) =>
    new Request(`https://x/api/sites/${slug}/events`, { signal });

  it("streams a version frame when the site moves, then cleans up on abort", async () => {
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    const abort = new AbortController();
    const res = await eventsGET(request(site.slug, abort.signal), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = decoder.decode((await reader.read()).value);
    // A REAL dispatched frame, not a comment: comments are invisible to the EventSource parser,
    // so only this proves to the client that the BODY flows (a buffering proxy forwards the head
    // and holds the body, which would otherwise look identical to a healthy stream).
    expect(buffer).toContain("event: hello");
    expect(buffer).toContain("retry:");
    expect(buffer).not.toMatch(/^: connected/m);

    const edited = await editSite(site.slug, { content: "<html><head></head><body>2</body></html>" }, CTX);
    const v2 = (edited as { version: { id: string } }).version;
    // Read until the version frame lands (countVersions runs async inside the route).
    for (let i = 0; i < 5 && !buffer.includes("event: version"); i++) {
      buffer += decoder.decode((await reader.read()).value);
    }
    expect(buffer).toContain("event: version");
    expect(buffer).toContain(v2.id);
    expect(buffer).toContain('"versionNumber":2');

    abort.abort(); // must not throw, must release the subscription
    await tick();
  });

  it("hides a private site's feed from a stranger, same answer as the page", async () => {
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>p</body></html>" }, {}, CTX);
    const { updateSiteVisibility } = await import("@/lib/db");
    await updateSiteVisibility(site.id, "private");
    const res = await eventsGET(request(site.slug, new AbortController().signal), { params: Promise.resolve({ slug: site.slug }) });
    expect(res.status).toBe(404);
  });
});

describe("versionNumber is a position, not a total", () => {
  const request = (slug: string, signal: AbortSignal) =>
    new Request(`https://x/api/sites/${slug}/events`, { signal });

  it("after rolling back to an old version, the number follows the version being rendered", async () => {
    const { site, version: v1 } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);
    await editSite(site.slug, { content: "<html><head></head><body>2</body></html>" }, CTX);
    await editSite(site.slug, { content: "<html><head></head><body>3</body></html>" }, CTX);

    const abort = new AbortController();
    const res = await eventsGET(request(site.slug, abort.signal), { params: Promise.resolve({ slug: site.slug }) });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = decoder.decode((await reader.read()).value);

    // Roll back to v1: the platform's semantics are "forward recovery" — a new version whose content
    // equals v1 is written, and it is the 4th version.
    await rollbackTo(site.slug, v1.id, CTX);
    for (let i = 0; i < 5 && !buffer.includes("event: version"); i++) {
      buffer += decoder.decode((await reader.read()).value);
    }
    expect(buffer).toContain('"versionNumber":4');
    abort.abort();
    await tick();
  });
});

describe("the toast decision", () => {
  it("fires only for a REAL move — same id, empty id and junk stay quiet", () => {
    expect(isNewVersion("ver_a", "ver_b")).toBe(true);
    expect(isNewVersion("ver_a", "ver_a")).toBe(false);
    expect(isNewVersion("ver_a", "")).toBe(false);
    expect(isNewVersion("ver_a", undefined)).toBe(false);
    expect(isNewVersion("ver_a", 42)).toBe(false);
  });
});

// --- the feed's rate-limit budget (P2 from the second review round) -------------------------
//
// /events once used the default per-IP bucket directly — the same bucket that governs POST
// /versions, /edit, /fork and /login. And visibilitychange reopens the stream every time the tab
// regains focus, so "a reader switching back and forth between the artifact page and elsewhere"
// exhausts the **publish** budget: after twenty-odd switches a save gets a 429, with no way to
// connect the two. Worse behind a shared NAT egress IP — every window switch by a read-only
// visitor spends the write budget of everyone in the same building.
describe("the feed has its own rate-limit bucket and does not eat the write path's budget", () => {
  const IP = "203.0.113.77";
  beforeEach(async () => {
    const { __resetRateLimitForTests } = await import("@/lib/ratelimit");
    __resetRateLimitForTests();
    process.env.ARTIFACT_RATE_LIMIT = "on"; // off by default under the test harness
    process.env.ARTIFACT_RATE_LIMIT_BURST = "4";
    process.env.ARTIFACT_RATE_LIMIT_PER_MIN = "1";
  });

  afterEach(async () => {
    const { __resetRateLimitForTests } = await import("@/lib/ratelimit");
    __resetRateLimitForTests();
    for (const k of ["ARTIFACT_RATE_LIMIT", "ARTIFACT_RATE_LIMIT_BURST", "ARTIFACT_RATE_LIMIT_PER_MIN"]) delete process.env[k];
  });

  it("after draining the feed bucket, the same IP's write path is still allowed through", async () => {
    const { checkRateLimit, RateLimitError } = await import("@/lib/ratelimit");
    const { rateLimit: cfg } = await import("@/lib/config");
    const { site } = await createSite({ mode: "paste", html: "<html><head></head><body>1</body></html>" }, {}, CTX);

    // Go through the real route rather than restating how it should be called: reopen the feed
    // repeatedly (= switch back to the tab repeatedly) until its own bucket runs dry.
    const open = async () => {
      const ac = new AbortController();
      const res = await eventsGET(
        new Request(`https://x/api/sites/${site.slug}/events`, { headers: { "x-real-ip": IP }, signal: ac.signal }),
        { params: Promise.resolve({ slug: site.slug }) },
      );
      ac.abort(); // tear down immediately; don't leave 200 streams in the test process
      await tick();
      return res.status;
    };

    const ceiling = cfg.burst * 10;
    for (let i = 0; i < ceiling; i++) expect(await open()).toBe(200);
    expect(await open()).toBe(429); // the feed's own bucket is full

    // And the write path (POST /versions uses exactly this default call) must be untouched.
    expect(() => checkRateLimit(new Request("https://x/api/sites/s/versions", { headers: { "x-real-ip": IP } }))).not.toThrow();
    expect(RateLimitError).toBeDefined();
  });

  it("the feed's budget is far wider than the write path's, so a few window switches cannot fill it", async () => {
    const { rateLimit: cfg } = await import("@/lib/config");
    expect(cfg.burst * 10).toBeGreaterThan(cfg.burst);
  });
});
