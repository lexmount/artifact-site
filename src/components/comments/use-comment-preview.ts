"use client";
import { browserRandomId } from "@/lib/browser-random-id";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { COMMENT_LOCATION_FLASH_MS } from "@/lib/comments/contracts";
import type { CommentAnchor, CommentScope, PreviewCommentCommand } from "@/lib/comments/contracts";
import { startPreviewHandshake } from "@/lib/comments/preview-handshake";
import { previewAlreadyLoaded, resetPreviewLoad } from "@/lib/comments/preview-load";
import { canonicalPreviewPath } from "@/lib/comments/preview-path";
import { acceptPreviewCommentEvent } from "@/lib/comments/preview-channel";

export type CommentMarker = { threadId: string; anchor: CommentAnchor };
/** A new mount/load gets a fresh channel. The host retains all drafts and credentials. */
export function useCommentPreview({ frameRef, scope, generation = 0 }: { frameRef: RefObject<HTMLIFrameElement | null>; scope: CommentScope; generation?: number }) {
  const channel = useRef("");
  const beginNavigation = useRef<((path: string, waitForLoad?: boolean) => void) | null>(null);
  const active = useRef(false);
  const previousScope = useRef<string | null>(null);
  const scopeKey = JSON.stringify(scope);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const selecting = useRef(false);
  const textSelection = useRef({ enabled: false, label: "" });
  const temporary = useRef<string | null>(null);
  const lastLocation = useRef<{ marker: CommentMarker; filePath: string | null; at: number } | null>(null);
  const reloadLocation = useRef<typeof lastLocation.current>(null);
  const acknowledgedPath = useRef<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | undefined>();
  const pending = useRef<string | null>(null);
  const saved = useRef<{ markers: CommentMarker[]; visible: boolean }>({ markers: [], visible: false });
  const [selectionPosition, setSelectionPosition] = useState<{x:number;y:number} | null>(null);
  const [selectedAnchor, setSelectedAnchor] = useState<CommentAnchor | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [unavailableScope, setUnavailableScope] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [locationResult, setLocationResult] = useState<"exact" | "approximate" | "missing" | null>(null);
  const send = useCallback((command: PreviewCommentCommand["command"]) => {
    if (!active.current || !frameRef.current?.contentWindow) return;
    frameRef.current.contentWindow.postMessage({ protocol: "artifact-comments", schemaVersion: 1, channelId: channel.current, scope, command } satisfies PreviewCommentCommand, "*");
  }, [frameRef, scope]);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let handshake: ReturnType<typeof startPreviewHandshake> | undefined;
    function load(expectedPath: string | null = null) {
      reloadLocation.current = lastLocation.current; lastLocation.current = null; acknowledgedPath.current = null;
      channel.current = browserRandomId(); active.current = true; selecting.current = false; pending.current = null;
      setSelectedAnchor(null); setIsSelecting(false); setReady(false); setUnavailableScope(null); setLocationResult(null);
      setCurrentFilePath(null); temporary.current = null; setActiveThreadId(undefined);
      handshake?.stop();
      handshake = startPreviewHandshake(() => send({ type: "markers", ...saved.current }), expectedPath, () => setUnavailableScope(scopeKey));
    }
    function receive(event: MessageEvent) {
      const parsed = acceptPreviewCommentEvent(event, { source: frame!.contentWindow, channelId: channel.current, scope, selecting: selecting.current, canSelectText: textSelection.current.enabled, pendingThreadId: pending.current, visibleThreadIds: [...(saved.current.visible ? saved.current.markers.map(marker => marker.threadId) : []), ...(temporary.current && lastLocation.current && Date.now() - lastLocation.current.at < COMMENT_LOCATION_FLASH_MS ? [temporary.current] : [])] });
      if (!parsed) return;
      if (parsed.event.type === "ready") {
        const path = parsed.event.filePath;
        const canonical = path ? canonicalPreviewPath(path) : null;
        if (!handshake?.accept(canonical)) return;
        acknowledgedPath.current = canonical; setCurrentFilePath(canonical);
        setReadyScope(scopeKey); setReady(true);
        send({ type: "text-selection", ...textSelection.current });
        // An early handshake may locate before the iframe load event rotates its channel.
        // Replay only on that exact file; internal navigation must never restore an old target.
        const replay = reloadLocation.current; reloadLocation.current = null;
        if (replay && (saved.current.visible || Date.now() - replay.at < COMMENT_LOCATION_FLASH_MS) && canonical && replay.filePath === canonical) {
          lastLocation.current = replay; pending.current = replay.marker.threadId; temporary.current = replay.marker.threadId;
          send({ type: "locate", ...replay.marker });
        }
      }
      if (parsed.event.type === "selected" || parsed.event.type === "text-selected") { selecting.current = false; setIsSelecting(false); const rect = frame!.getBoundingClientRect();
        const point = parsed.event.position;
        setSelectionPosition(point ? {x:rect.left + Math.max(0,Math.min(rect.width,point.x * rect.width / (frame!.clientWidth || rect.width))),y:rect.top + Math.max(0,Math.min(rect.height,point.y * rect.height / (frame!.clientHeight || rect.height)))} : null);
        setSelectedAnchor(parsed.event.anchor); }
      if (parsed.event.type === "cancelled") { selecting.current = false; setIsSelecting(false); }
      if (parsed.event.type === "activated") setActiveThreadId(parsed.event.threadId);
      if (parsed.event.type === "located") { setLocationResult(parsed.event.outcome); pending.current = null; }
    }
    window.addEventListener("message", receive);
    const loaded = () => { load(); handshake?.markLoaded(); };
    beginNavigation.current = (path, waitForLoad) => {
      if (waitForLoad) { handshake?.stop(); active.current = false; setUnavailableScope(null); setReady(false); setCurrentFilePath(null); setLocationResult(null); return; }
      load(path);
    };
    frame.addEventListener("load", loaded);
    // The iframe may have completed its initial load before effects are mounted.
    const changedScope = previousScope.current !== null && previousScope.current !== scopeKey;
    previousScope.current = scopeKey;
    if (!changedScope) { load(); if (previewAlreadyLoaded(frame)) handshake?.markLoaded(); }
    return () => {
      send({ type: "cancel" }); active.current = false; lastLocation.current = null; reloadLocation.current = null;
      beginNavigation.current = null;
      handshake?.stop(); frame.removeEventListener("load", loaded); window.removeEventListener("message", receive);
    };
  }, [frameRef, scope, scopeKey, send, generation]);
  const navigate = useCallback((url: string, targetPath: string, waitForLoad = false) => {
    const frame = frameRef.current;
    if (!frame) return;
    beginNavigation.current?.(targetPath, waitForLoad);
    resetPreviewLoad(frame);
    frame.src = url;
  }, [frameRef]);
  const select = useCallback(() => {
    selecting.current = true; setIsSelecting(true); setLocationResult(null); send({ type: "select" });
  }, [send]);
  const cancel = useCallback(() => {
    selecting.current = false; setIsSelecting(false); setSelectedAnchor(null); setLocationResult(null); send({ type: "cancel" });
  }, [send]);
  const locate = useCallback((marker: CommentMarker) => {
    lastLocation.current = { marker, filePath: acknowledgedPath.current, at: Date.now() };
    pending.current = marker.threadId; temporary.current = marker.threadId; setLocationResult(null); send({ type: "locate", ...marker });
  }, [send]);
  const setMarkers = useCallback((markers: CommentMarker[], visible: boolean) => {
    const next = { markers: markers.slice(0, 100), visible };
    if (JSON.stringify(saved.current) === JSON.stringify(next)) return;
    if (saved.current.visible && !visible) { lastLocation.current = null; reloadLocation.current = null; temporary.current = null; pending.current = null; setLocationResult(null); }
    saved.current = next; send({ type: "markers", ...saved.current });
  }, [send]);
  const setTextSelection = useCallback((enabled: boolean, label: string) => {
    textSelection.current = {enabled, label};
    send({type:"text-selection", enabled, label});
  }, [send]);
  return { setTextSelection, clearActiveThread: () => setActiveThreadId(undefined), activeThreadId, selectionPosition, selectedAnchor, isSelecting, currentFilePath, ready: ready && readyScope === scopeKey, unavailable: unavailableScope === scopeKey, locationResult, navigate, select, cancel, locate, setMarkers };
}
