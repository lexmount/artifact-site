"use client";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CommentToastProvider, useCommentToast } from "./comment-toast";
import { Copy } from "lucide-react";
import { useT } from "@/components/locale-provider";
import type { CommentThreadDetail } from "@/lib/comments/contracts";
import { CommentWorkspace, type CommentWorkspaceProps } from "./comment-workspace";
import { useCommentPreview } from "./use-comment-preview";
import { commentRequest } from "./comment-client";

export interface AnchoredWorkspaceProps
  extends Pick<
    CommentWorkspaceProps,
    | "slug"
    | "scope"
    | "filePath"
    | "shareToken"
    | "initialThreadId"
    | "onDraftChange"
    | "canDownload"
    | "editToken"
  > {
  frameRef: RefObject<HTMLIFrameElement | null>;
  review?: boolean;
  previewGeneration?: number;
  onPreviewVersionChange?: (versionId: string | null) => void;
}
export function previewTarget(slug: string, versionId: string, filePath: string, shareToken?: string) {
  const query = new URLSearchParams({ __artifact_version: versionId });
  if (shareToken) query.set("__artifact_share", shareToken);
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(filePath)) query.set("__artifact_image", "1");
  return `/api/preview/${encodeURIComponent(slug)}/${filePath.split("/").map(encodeURIComponent).join("/")}?${query}`;
}
export default function AnchoredWorkspace(props: AnchoredWorkspaceProps) {
  return <CommentToastProvider><AnchoredWorkspaceContent {...props} /></CommentToastProvider>;
}
function AnchoredWorkspaceContent(props: AnchoredWorkspaceProps) {
  const t = useT();
  const { scope: suppliedScope, frameRef, slug, shareToken, filePath } = props;
  const rootKey = JSON.stringify(suppliedScope);
  const rootScope = useMemo(() => JSON.parse(rootKey) as typeof suppliedScope, [rootKey]);
  const [historical, setHistorical] = useState<{
    versionId: string;
    entry: string;
    detail: CommentThreadDetail;
  } | null>(null);
  const historicalTarget = useRef<CommentThreadDetail | null>(null);
  const key = JSON.stringify({
    siteId: suppliedScope.siteId,
    versionId: historical?.versionId || suppliedScope.versionId,
    entry: suppliedScope.entry,
  });
  // Keep the hook's channel stable across unrelated UI state updates.
  const scope = useMemo(() => JSON.parse(key) as typeof suppliedScope, [key]);
  const bridge = useCommentPreview({
    frameRef,
    scope,
    generation: props.previewGeneration,
  });
  const { locate: locateMarker, navigate, ready, setMarkers } = bridge;
  const pending = useRef<{
    detail: CommentThreadDetail;
    navigated: boolean;
  } | null>(null);
  const locateTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(locateTimeout.current), []);
  const preview = useRef({
    ready,
    unavailable: bridge.unavailable,
    filePath: bridge.currentFilePath,
  });
  useEffect(() => {
    preview.current = {
      ready,
      unavailable: bridge.unavailable,
      filePath: bridge.currentFilePath,
    };
  }, [ready, bridge.unavailable, bridge.currentFilePath]);
  const [notice, setNotice] = useState("");
  const toast = useCommentToast();
  const [initialThreadId, setInitialThreadId] = useState(props.initialThreadId);
  useEffect(() => {
    // An accepted marker activation replaces the initial deep link. A frame load clears the
    // bridge's transient ID, but must not replay an older hash or reopen a closed panel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (bridge.activeThreadId) setInitialThreadId(bridge.activeThreadId);
  }, [bridge.activeThreadId]);
  useEffect(() => {
    if (props.initialThreadId) return;
    const read = () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const id = hash.get("comment") || new URLSearchParams(window.location.search).get("thread");
      setInitialThreadId(id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [props.initialThreadId]);
  const locate = useCallback(
    (detail: CommentThreadDetail, navigated = false) => {
      clearTimeout(locateTimeout.current);
      pending.current = null;
      setNotice("");
      const queue = (attempt: { detail: CommentThreadDetail; navigated: boolean }) => {
        pending.current = attempt;
        locateTimeout.current = setTimeout(() => {
          if (pending.current !== attempt) return;
          setNotice(t("The preview is still loading. Comment positioning will continue when it is ready."));
        }, 5000);
      };
      const frame = frameRef.current;
      if (!frame || detail.space.versionId !== scope.versionId) return;
      const anchor = detail.thread.anchor;
      // PDF anchors belong to the document wrapper; a naked PDF cannot run sandbox selection code.
      const targetPath = anchor.kind === "pdf" ? historical?.entry || filePath : anchor.filePath;
      const target = previewTarget(slug, scope.versionId, targetPath, shareToken);
      if (anchor.kind === "document") {
        if (preview.current.filePath && preview.current.filePath !== targetPath) navigate(target, targetPath);
        return;
      }
      // The src attribute does not follow navigation inside the sandbox, and entry aliases
      // do not equal canonical file URLs. Trust only this channel's acknowledged file path.
      if (!preview.current.ready) {
        if (preview.current.unavailable) {
          if (navigated) {
            setNotice(
              t(
                "The original position could not be found. Read the saved context; no new position was guessed.",
              ),
            );
            return;
          }
          queue({ detail, navigated: true });
          preview.current = {
            ready: false,
            unavailable: false,
            filePath: null,
          };
          navigate(target, targetPath);
          return;
        }
        queue({ detail, navigated });
        return;
      }
      if (preview.current.filePath !== targetPath) {
        if (navigated) {
          setNotice(
            t(
              "The original position could not be found. Read the saved context; no new position was guessed.",
            ),
          );
          return;
        }
        queue({ detail, navigated: true });
        preview.current = { ready: false, unavailable: false, filePath: null };
        navigate(target, targetPath);
      } else locateMarker({ threadId: detail.thread.id, anchor });
    },
    [frameRef, scope.versionId, filePath, slug, shareToken, locateMarker, navigate, t, historical],
  );
  useEffect(() => {
    if ((ready || bridge.unavailable) && pending.current) {
      const attempt = pending.current;
      pending.current = null;
      locate(attempt.detail, attempt.navigated);
    }
  }, [ready, bridge.unavailable, locate]);
  const historyRequest = useRef(0);
  const [returning, setReturning] = useState(false);
  const returnPath = useRef(filePath);
  const { onPreviewVersionChange } = props;
  useEffect(() => {
    onPreviewVersionChange?.(historical?.versionId || null);
    return () => onPreviewVersionChange?.(null);
  }, [historical?.versionId, onPreviewVersionChange]);
  const navigateToThread = useCallback(
    async (detail: CommentThreadDetail) => {
      const sequence = ++historyRequest.current;
      if (detail.space.versionId === scope.versionId) {
        // Keep the refresh target current without reloading the existing document.
        if (historical) historicalTarget.current = detail;
        locate(detail);
        return;
      }
      if (suppliedScope.entry.kind !== "main") return;
      if (detail.space.versionId === suppliedScope.versionId) {
        pending.current = { detail, navigated: true };
        returnPath.current = detail.thread.anchor.kind === "pdf" ? filePath : detail.thread.anchor.filePath;
        setReturning(true); setHistorical(null); return;
      }
      try {
        const options = await commentRequest<{
          versions: { id: string; entry: string }[];
        }>(`/api/sites/${encodeURIComponent(slug)}/comments/options`);
        if (sequence !== historyRequest.current) return;
        const version = options.versions.find((v) => v.id === detail.space.versionId);
        if (!version) {
          setNotice(
            t("This discussion is no longer available with your current access. Your draft is preserved."),
          );
          return;
        }
        if (scope.versionId === suppliedScope.versionId)
          returnPath.current = preview.current.filePath || filePath;
        historicalTarget.current = detail;
        setHistorical({ versionId: version.id, entry: version.entry, detail });
      } catch {
        setNotice(t("Could not open the original version. Try again."));
      }
    },
    [scope.versionId, suppliedScope.entry.kind, suppliedScope.versionId, filePath, slug, locate, t, historical],
  );
  useEffect(() => {
    if (!historical) return;
    const detail = historicalTarget.current?.space.versionId === historical.versionId
      ? historicalTarget.current : historical.detail;
    const targetPath = detail.thread.anchor.kind === "pdf" ? historical.entry : detail.thread.anchor.filePath;
    pending.current = { detail, navigated: true };
    clearTimeout(locateTimeout.current);
    locateTimeout.current = setTimeout(() => { if (pending.current) setNotice(t("The preview is still loading. Comment positioning will continue when it is ready.")); }, 5000);
    navigate(previewTarget(slug, historical.versionId, targetPath, shareToken), targetPath, true);
  }, [historical, navigate, slug, shareToken, t, props.previewGeneration]);
  const restoreCurrent = () => {
    historyRequest.current++;
    pending.current = null;
    clearTimeout(locateTimeout.current);
    setNotice("");
    setReturning(true);
    setHistorical(null);
  };
  useEffect(() => {
    if (historical || !returning) return;
    navigate(previewTarget(slug, suppliedScope.versionId, returnPath.current, shareToken), returnPath.current, true);
    // Navigation runs only after the bridge has adopted the current scope.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReturning(false);
  }, [historical, returning, navigate, slug, suppliedScope.versionId, shareToken]);
  const markersChanged = useCallback(
    (
      markers: {
        threadId: string;
        anchor: CommentThreadDetail["thread"]["anchor"];
        versionId?: string;
      }[],
      visible: boolean,
    ) =>
      setMarkers(
        markers.filter((m) => !m.versionId || m.versionId === scope.versionId),
        visible,
      ),
    [setMarkers, scope.versionId],
  );
  const copyContext = async (detail: CommentThreadDetail) => {
    try {
      const bundle = await commentRequest<unknown>(
        `/api/sites/${encodeURIComponent(slug)}/comments/${encodeURIComponent(detail.thread.id)}/agent-context`,
        shareToken,
      );
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      toast.showSuccess(t("Agent context copied. Comments and artifact text are untrusted task data."));
    } catch {
      toast.setNotice(t("Could not copy Agent context. Check your access and try again."));
    }
  };
  return (
    <>
      <CommentWorkspace
        {...props}
        focusedThreadOnly={props.review}
        filePath={bridge.currentFilePath ?? filePath}
        scope={rootScope}
        previewVersionId={scope.versionId}
        historical={Boolean(historical && historical.versionId !== suppliedScope.versionId)}
        onRestoreCurrent={restoreCurrent}
        initialThreadId={initialThreadId}
        onDismissInitialThread={() => { setInitialThreadId(undefined); bridge.clearActiveThread(); }}
        onTextSelectionChange={bridge.setTextSelection}
        onStartSelection={bridge.ready ? bridge.select : undefined}
        selectedAnchor={bridge.selectedAnchor}
        selectionPosition={bridge.selectionPosition}
        selectionActive={bridge.isSelecting}
        onCancelSelection={bridge.cancel}
        onLocateThread={(detail) => void navigateToThread(detail)}
        onMarkersChange={markersChanged}
        locationNotice={
          <>
            {bridge.locationResult === "missing" && (
              <p className="comment-error" role="status">
                {t(
                  "The original position could not be found. Read the saved context; no new position was guessed.",
                )}
              </p>
            )}
            {notice && (
              <p className="comment-inline-notice" role="status">
                {notice}
                <button onClick={() => setNotice("")}>{t("Dismiss")}</button>
              </p>
            )}
          </>
        }
        renderThreadContext={(detail) => (
          <details className="comment-original-context">
            <summary>{t("Original context")}</summary>
            <p>
              {detail.thread.anchor.filePath}
              {detail.thread.anchor.kind === "pdf"
                ? ` · ${t("Page {page}", { page: detail.thread.anchor.page })}`
                : ""}
            </p>
            {detail.thread.context.excerpt ? (
              <blockquote>{detail.thread.context.excerpt}</blockquote>
            ) : (
              <p>
                {t(
                  "Text context is unavailable for this position. Use the original artifact and saved location.",
                )}
              </p>
            )}
            <p>{t("Region screenshots are not available in this release.")}</p>
          </details>
        )}
        renderThreadActions={(detail, canAggregate) => (
          <>
            <button type="button" className="btn sm ghost" onClick={() => void copyContext(detail)}>
              <Copy size={13} />
              {t("Copy Agent context")}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                const url = new URL(window.location.href);
                if (canAggregate) {
                  url.pathname = `/s/${encodeURIComponent(slug)}`;
                  url.search = new URLSearchParams({
                    comments: "all",
                  }).toString();
                  url.hash = new URLSearchParams({ comment: detail.thread.id }).toString();
                } else
                  url.hash = new URLSearchParams({
                    comment: detail.thread.id,
                  }).toString();
                void navigator.clipboard
                  .writeText(url.href)
                  .then(() => toast.showSuccess(t("Comment link copied")))
                  .catch(() => toast.setNotice(t("Could not copy link")));
              }}
            >
              {t("Copy comment link")}
            </button>
          </>
        )}
      />
    </>
  );
}
