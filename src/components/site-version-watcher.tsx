"use client";

// The "updated" sentinel — the viewer page's ear on the version feed (contract 2's client half).
//
// Mounted on every /s/ page. Primary transport is the SSE feed; if the stream cannot be
// established (a proxy that buffers, an exotic network) it degrades to a 10s poll of the
// versions endpoint — the "double safeguard" the PRD promises, both legs inside this one component.
//
// What happens on arrival depends on who is watching, and the unit of refresh is the ARTIFACT
// FRAME, never the page. A full reload would tear down the assistant panel mid-conversation —
// the user asked the assistant for this very change, and answering it by destroying the thread
// they asked in is absurd. Reloading just the iframe keeps the panel, the scroll position of the
// chrome, and everything else the page was holding.
//
//   editors  the change is what they were waiting for → refresh immediately, tell them after.
//   readers  may be mid-scroll in a long report → offer it, let them choose the moment.
import { useEffect, useState } from "react";
import { useT } from "@/components/locale-provider";

export const POLL_INTERVAL_MS = 10_000;
/**
 * How long the stream has to prove it actually FLOWS before we stop trusting it.
 *
 * A buffering reverse proxy (nginx `proxy_buffering on`, which is the documented risk on this
 * deployment) forwards the response head immediately and then holds the body: EventSource opens,
 * reports OPEN, and never errors — so an error-only fallback would wait forever while the toast
 * silently never comes. The server therefore dispatches a real `hello` frame first, and this
 * watchdog treats "opened but nothing arrived" as a dead transport.
 */
export const HELLO_TIMEOUT_MS = 5_000;

/** How long the "updated" note lingers once the frame has already been refreshed for an editor. */
export const AUTO_NOTE_MS = 6_000;

/**
 * Asks whoever renders the artifact frame to reload it. A DOM event rather than shared state:
 * the watcher and SiteViewer are siblings under the page, and this keeps the coupling to one
 * name instead of a module both must import.
 */
export const ARTIFACT_REFRESH_EVENT = "artifact:refresh";

export function requestArtifactRefresh(): void {
  window.dispatchEvent(new CustomEvent(ARTIFACT_REFRESH_EVENT));
}

/** What the feed / poll must say before the toast may appear: a version other than the one this
 *  page rendered with. Exported pure so the decision is pinned by tests. */
export function isNewVersion(renderedVersionId: string, seenVersionId: unknown): boolean {
  return typeof seenVersionId === "string" && seenVersionId.length > 0 && seenVersionId !== renderedVersionId;
}

export default function SiteVersionWatcher({ slug, versionId, autoRefresh = false }: {
  slug: string;
  versionId: string;
  /** Editors get the new version applied on arrival; readers get an offer. */
  autoRefresh?: boolean;
}) {
  const t = useT();
  const [fresh, setFresh] = useState<{ versionNumber?: number; applied?: boolean } | null>(null);

  useEffect(() => {
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let noteTimer: ReturnType<typeof setTimeout> | null = null;

    /** One arrival, two behaviours — see the header. Idempotent: both transports may report the
     *  same change, and refreshing an already-refreshed frame is harmless. */
    const announce = (info: { versionNumber?: number }) => {
      if (stopped) return;
      if (autoRefresh) {
        requestArtifactRefresh();
        setFresh({ ...info, applied: true });
        if (noteTimer) clearTimeout(noteTimer);
        noteTimer = setTimeout(() => { if (!stopped) setFresh(null); }, AUTO_NOTE_MS);
        return;
      }
      setFresh(info);
    };
    let source: EventSource | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const stopPolling = () => {
      if (!poll) return;
      clearInterval(poll);
      poll = null;
    };

    const startPolling = () => {
      if (poll || stopped) return;
      poll = setInterval(() => {
        void fetch(`/api/sites/${slug}/versions`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((body: { currentVersionId?: unknown } | null) => {
            if (!stopped && body && isNewVersion(versionId, body.currentVersionId)) announce({});
          })
          .catch(() => {});
      }, POLL_INTERVAL_MS);
    };

    const openStream = () => {
      if (source || stopped) return;
      try {
        source = new EventSource(`/api/sites/${slug}/events`);
      } catch {
        startPolling();
        return;
      }
      // Nothing from the body within the window = a transport that opened but does not flow.
      // Polling takes over; the stream stays open in case it unblocks later (both arriving just
      // means setFresh runs twice, which is idempotent).
      watchdog = setTimeout(startPolling, HELLO_TIMEOUT_MS);
      const bodyFlows = () => {
        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
        // The stream is demonstrably alive — retire the fallback rather than run both for the
        // life of the tab. A slow first connection (mobile) would otherwise leave a page polling
        // every 10s forever alongside a perfectly healthy feed.
        stopPolling();
      };
      source.addEventListener("hello", bodyFlows);
      source.addEventListener("version", (e) => {
        bodyFlows();
        try {
          const data = JSON.parse((e as MessageEvent).data) as { versionId?: unknown; versionNumber?: number };
          if (isNewVersion(versionId, data.versionId)) announce({ versionNumber: data.versionNumber });
        } catch {
          // Malformed frame — the poll fallback still covers us.
        }
      });
      source.onerror = () => {
        // EventSource retries transient drops itself; CLOSED means it gave up — poll from here.
        if (source?.readyState === EventSource.CLOSED) startPolling();
      };
    };

    const closeStream = () => {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
      source?.close();
      source = null;
      stopPolling(); // a hidden tab watches by neither transport
    };

    // A backgrounded tab needs no live feed, and browsers only allow ~6 concurrent connections per
    // origin over HTTP/1.1 — a reader with several artifacts open would otherwise spend them all on
    // idle streams and stall their own page loads. Release while hidden, reopen (and re-check the
    // version once) on return.
    const onVisibility = () => {
      if (document.hidden) {
        closeStream();
        return;
      }
      openStream();
      void fetch(`/api/sites/${slug}/versions`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { currentVersionId?: unknown } | null) => {
          if (!stopped && body && isNewVersion(versionId, body.currentVersionId)) announce({});
        })
        .catch(() => {});
    };

    if (!document.hidden) openStream();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      if (noteTimer) clearTimeout(noteTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      closeStream(); // also stops polling
    };
  }, [slug, versionId, autoRefresh]);

  if (!fresh) return null;
  const label = fresh.versionNumber ? t("Artifact updated to v{n}", { n: fresh.versionNumber }) : t("Artifact updated");
  return (
    <div className="version-toast" role="status">
      <span>{fresh.applied ? t("{label}, refreshed for you", { label }) : label}</span>
      {!fresh.applied && (
        <button type="button" className="btn sm solid" onClick={() => { requestArtifactRefresh(); setFresh(null); }}>
          {t("Refresh to view")}
        </button>
      )}
    </div>
  );
}
