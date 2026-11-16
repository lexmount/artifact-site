"use client";

import { appFetch, appPath } from "@/lib/app-path";
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
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { PREVIEW_INTERACTION_EVENT } from "@/lib/preview-interaction";

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

export function requestArtifactRefresh(versionId?: string, automatic = false): boolean {
  return window.dispatchEvent(new CustomEvent(ARTIFACT_REFRESH_EVENT, { cancelable: true, detail: { versionId, automatic } }));
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
  const [fresh, setFresh] = useState<{ slug: string; versionNumber?: number; applied?: boolean } | null>(null);
  const notice = useRef<HTMLDivElement>(null);
  const lastAnnounced = useRef<{ slug: string; versionId: unknown } | null>(null);

  // router.refresh replaces versionId without remounting us. The notice owns its timer;
  // restarting the feed must neither cancel its expiry nor repeat a dismissed update.
  useEffect(() => {
    if (!fresh?.applied) return;
    const timer = setTimeout(() => setFresh(null), AUTO_NOTE_MS);
    return () => clearTimeout(timer);
  }, [fresh]);

  useEffect(() => {
    if (!fresh || fresh.slug !== slug) return;
    const dismiss = () => setFresh(null);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !notice.current?.contains(event.target)) dismiss();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    // A focused sandbox owns its pointer events. Accept only a dismissal signal from the
    // current artifact frame, never content, credentials or a request to refresh.
    const previewInteraction = (event: MessageEvent) => {
      if (event.data?.type !== PREVIEW_INTERACTION_EVENT) return;
      const frame = document.querySelector<HTMLIFrameElement>("iframe.fs-frame");
      if (frame?.contentWindow && event.source === frame.contentWindow) dismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    window.addEventListener("blur", dismiss);
    window.addEventListener("message", previewInteraction);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("message", previewInteraction);
    };
  }, [fresh, slug]);

  useEffect(() => {
    let stopped = false;
    let poll: ReturnType<typeof setInterval> | null = null;

    /** Both transports may report the same change, including after a subscription restart. */
    const announce = (info: { versionNumber?: number; versionId?: unknown }) => {
      if (stopped || (lastAnnounced.current?.slug === slug && info.versionId === lastAnnounced.current.versionId)) return;
      lastAnnounced.current = { slug, versionId: info.versionId };
      if (autoRefresh) {
        const applied = requestArtifactRefresh(typeof info.versionId === "string" ? info.versionId : undefined, true);
        setFresh({ ...info, slug, applied });
        return;
      }
      setFresh({ ...info, slug });
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
        void appFetch(`/api/sites/${slug}/versions`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .then((body: { currentVersionId?: unknown } | null) => {
            if (!stopped && body && isNewVersion(versionId, body.currentVersionId)) announce({ versionId: body.currentVersionId });
          })
          .catch(() => {});
      }, POLL_INTERVAL_MS);
    };

    const openStream = () => {
      if (source || stopped) return;
      try {
        source = new EventSource(appPath(`/api/sites/${slug}/events`));
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
          if (isNewVersion(versionId, data.versionId)) announce({ versionNumber: data.versionNumber, versionId: data.versionId });
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
      void appFetch(`/api/sites/${slug}/versions`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((body: { currentVersionId?: unknown } | null) => {
          if (!stopped && body && isNewVersion(versionId, body.currentVersionId)) announce({ versionId: body.currentVersionId });
        })
        .catch(() => {});
    };

    if (!document.hidden) openStream();
    const applied = () => setFresh(null);
    window.addEventListener("artifact:refresh-applied", applied);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      window.removeEventListener("artifact:refresh-applied", applied);
      document.removeEventListener("visibilitychange", onVisibility);
      closeStream(); // also stops polling
    };
  }, [slug, versionId, autoRefresh]);

  if (!fresh || fresh.slug !== slug) return null;
  const label = fresh.versionNumber ? t("Artifact updated to v{n}", { n: fresh.versionNumber }) : t("Artifact updated");
  return (
    <div ref={notice} className="version-toast" role="status">
      <span>{fresh.applied ? t("{label}, refreshed for you", { label }) : label}</span>
      {!fresh.applied && (
        <button type="button" className="btn sm solid" onClick={() => { if (requestArtifactRefresh()) setFresh(null); }}>
          {t("Refresh to view")}
        </button>
      )}
      <button type="button" className="version-toast-dismiss" aria-label={t("Dismiss")} onClick={() => setFresh(null)}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
