"use client";
import { commentAnchorLabel } from "@/lib/comments/presentation";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { CommentToast, useCommentToast } from "./comment-toast";
import {
  ArrowLeft,
  SlidersHorizontal,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Heart,
  MessageCircle,
  MessageCirclePlus,
  RefreshCw,
  Maximize,
  ExternalLink,
  X,
} from "lucide-react";
import { useCommentUnread } from "./use-comment-unread";
import CommentSignIn from "./comment-sign-in";
import MoreMenu from "@/components/more-menu";
import SiteDownload from "@/components/site-download";
import { commentRailPreference } from "./comment-preferences";
import { useT, useLocale } from "@/components/locale-provider";
import { useAuth } from "@/lib/use-auth";
import type {
  CommentEmoji,
  CommentReaction,
  CommentAnchor,
  CommentMessage,
  CommentPage,
  CommentScope,
  CommentThreadDetail,
} from "@/lib/comments/contracts";
import { COMMENT_LIMITS } from "@/lib/comments/contracts";
import type { CommentPermissions } from "@/lib/comments/permissions";
import {
  commentRequest,
  CommentRequestError,
  mergeThreads,
  commentPollDelay,
  refreshCommentWindow,
  discoverCommentPermissions,
} from "./comment-client";
import { canShowCommentScope, shouldAggregateComments } from "./comment-view";
import { CommentSummary, CommentConversation } from "./comment-thread";
import {
  draftBucket,
  draftIdentity,
  readDrafts,
  writeDrafts,
  stampDraft,
  canRecoverCommentDraft,
  type CommentDraft,
} from "./comment-drafts";
import "./comments.css";

export interface CommentWorkspaceProps {
  slug: string;
  scope: CommentScope;
  filePath: string;
  shareToken?: string;
  canDownload?: boolean;
  editToken?: string | null;
  onStartSelection?: () => void;
  selectedAnchor?: CommentAnchor | null;
  selectionActive?: boolean;
  onCancelSelection?: () => void;
  onLocateThread?: (detail: CommentThreadDetail) => void;
  onMarkersChange?: (
    markers: { threadId: string; anchor: CommentAnchor; versionId?: string }[],
    visible: boolean,
  ) => void;
  initialThreadId?: string;
  renderThreadContext?: (detail: CommentThreadDetail) => ReactNode;
  renderThreadActions?: (detail: CommentThreadDetail, canAggregate: boolean) => ReactNode;
  focusedThreadOnly?: boolean;
  onPanelChange?: (open: boolean) => void;
  locationNotice?: ReactNode;
  onRestoreCurrent?: () => void;
  historical?: boolean;
  previewVersionId?: string;
  onDismissInitialThread?: () => void;
  onDraftChange?: (dirty: boolean) => void;
}
type Access = CommentPermissions & {
  userId: string | null;
  isAuthenticated: boolean;
  needsLogin: boolean;
  canReadVersions: boolean;
};
type Composer =
  | { kind: "create"; anchor: CommentAnchor }
  | { kind: "reply"; detail: CommentThreadDetail }
  | { kind: "edit"; detail: CommentThreadDetail; message: CommentMessage };

export function CommentWorkspace(props: CommentWorkspaceProps) {
  const auth = useAuth();
  const [identity, setIdentity] = useState<string | undefined>();
  const onIdentityChange = useCallback((userId: string | null) => setIdentity(userId || "guest"), []);
  const userId = identity ?? auth.user?.id ?? "guest";
  if (auth.loading) return null;
  return (
    <CommentWorkspaceSession
      key={`${userId}:${props.scope.siteId}`}
      {...props}
      viewerUserId={userId === "guest" ? null : userId}
      onIdentityChange={onIdentityChange}
    />
  );
}
function CommentWorkspaceSession(
  props: CommentWorkspaceProps & {
    viewerUserId: string | null;
    onIdentityChange: (userId: string | null) => void;
  },
) {
  const {
    slug,
    scope,
    filePath,
    shareToken,
    onMarkersChange,
    selectedAnchor,
    initialThreadId,
    onLocateThread,
    onDraftChange,
    onPanelChange,
  } = props;
  const t = useT();
  const locale = useLocale();
  const auth = useAuth();
  const { viewerUserId, onIdentityChange } = props;
  const [access, setAccess] = useState<Access | null>(null);
  const [discoveryDenied, setDiscoveryDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<CommentThreadDetail | null>(null);
  const [options, setOptions] = useState<{
    versions: { id: string; entry: string; createdAt: number }[];
    shares: { id: string; label: string | null; source?: string }[];
    authors: { id: string; label: string | null }[];
  }>({ versions: [], shares: [], authors: [] });
  const [versionFilter, setVersionFilter] = useState("current");
  const [shareFilter, setShareFilter] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [sort, setSort] = useState<"activity" | "newest" | "oldest">("activity");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [updates, setUpdates] = useState(0);
  const [undo, setUndo] = useState<CommentThreadDetail | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const [hasDrafts, setHasDrafts] = useState<boolean | null>(null);
  const draftCache = useRef<Record<string, CommentDraft> | null>(null);
  const storageFailed = useRef(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const node = workspaceRef.current;
    if (!viewport || !node) return;
    const measure = () => {
      node.style.setProperty("--comment-viewport-height", `${viewport.height}px`);
      node.style.setProperty(
        "--comment-keyboard-inset",
        `${Math.max(0, innerHeight - viewport.height - viewport.offsetTop)}px`,
      );
    };
    measure();
    viewport.addEventListener("resize", measure);
    viewport.addEventListener("scroll", measure);
    return () => {
      viewport.removeEventListener("resize", measure);
      viewport.removeEventListener("scroll", measure);
    };
  }, []);
  const listScroll = useRef(0);
  const requestBusy = useRef(false);
  const collapsed = useSyncExternalStore(
    commentRailPreference.subscribe,
    commentRailPreference.getSnapshot,
    commentRailPreference.getServerSnapshot,
  );
  const [markers, setMarkers] = useState(false);
  const [rows, setRows] = useState<CommentThreadDetail[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"" | "open" | "resolved">("");
  const [source, setSource] = useState<"all" | "main">("all");
  const [loadedKey, setLoadedKey] = useState("");
  const inFlight = useRef(false);
  const refreshRequested = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const {notice,noticeSuccess,setNotice,showSuccess} = useCommentToast();
  const [composer, setComposer] = useState<Composer | null>(null);
  const [internalSelecting, setSelecting] = useState(false);
  const selecting = props.selectionActive ?? internalSelecting;
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [likes, setLikes] = useState({ count: 0, liked: false });
  const [likeBusy, setLikeBusy] = useState(false);
  const [mainPolicy, setMainPolicy] = useState<"off" | "login" | "members" | null>(null);
  const [conflict, setConflict] = useState<CommentMessage | null>(null);
  const [deleting, setDeleting] = useState<{
    detail: CommentThreadDetail;
    message: CommentMessage;
  } | null>(null);
  const requestId = useRef<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const generation = useRef(0);
  const expanded = useRef({
    key: "",
    threads: 1,
    messages: new Map<string, number>(),
  });
  const unavailableInitial = useRef<string | null>(null);
  const handledInitial = useRef<string | null>(null);
  const locateRef = useRef(onLocateThread);
  const scopeRef = useRef(scope);
  useEffect(() => {
    locateRef.current = onLocateThread;
    scopeRef.current = scope;
  });
  const displacedChecks = useRef(new Map<string, number>());
  const polling = useRef({ failures: 0, nextAt: 0 });
  const lifecycle = useRef({ active: true });
  useEffect(() => {
    const instance = lifecycle.current;
    instance.active = true;
    return () => {
      instance.active = false;
    };
  }, []);
  const endpoint = `/api/sites/${encodeURIComponent(slug)}/comments`;
  const query = new URLSearchParams({ versionId: scope.versionId });
  if (scope.entry.kind === "share") query.set("shareId", scope.entry.shareId);
  const scopeQuery = query.toString();
  const viewKey = `${unreadOnly}:${scopeQuery}:${status}:${source}:${versionFilter}:${shareFilter}:${authorFilter}:${sort}`;
  const overviewAllowed = shouldAggregateComments(
    scope,
    Boolean(access?.canAggregate),
    "all",
    Boolean(props.focusedThreadOnly),
  );
  const aggregate = overviewAllowed;
  const unread = useCommentUnread({endpoint,versionId:scope.versionId,shareId:scope.entry.kind === "share" ? scope.entry.shareId : undefined,aggregate,userId:access?.userId,token:shareToken,enabled:Boolean(access?.canRead) && !discoveryDenied,open,workspace:workspaceRef});
  const accessKnown = access !== null;
  const previewQuery = new URLSearchParams({ v: props.previewVersionId || scope.versionId });
  if (shareToken) previewQuery.set("share", shareToken);
  const previewHref = `/api/preview/${encodeURIComponent(slug)}/?${previewQuery}`;

  useEffect(() => () => onMarkersChange?.([], false), [onMarkersChange]);
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
    selectedRef.current = selectedId;
  });
  useEffect(() => {
    onPanelChange?.(open);
    return () => onPanelChange?.(false);
  }, [open, onPanelChange]);
  useEffect(() => {
    if (!overviewAllowed) return;
    let active = true;
    void commentRequest<typeof options>(`${endpoint}/options`)
      .then((value) => {
        if (active) setOptions(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [overviewAllowed, endpoint]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("comments") === "all")
      queueMicrotask(() => {
        setVersionFilter("all");
        setOpen(true);
      });
  }, []);
  const selected = selectedId ? rows.find((row) => row.thread.id === selectedId) || (selectedSnapshot?.thread.id === selectedId ? selectedSnapshot : null) : null;
  const shareLabel = (share: { id: string; label: string | null; source?: string }) => share.label || (share.source === "publish" ? t("Publication link") : t("Share link · {id}", { id: share.id.slice(-6) }));
  const sourceLabel = (detail: CommentThreadDetail) => {
    const entry = detail.space.entry;
    const label =
      entry.kind === "main"
        ? t("Main discussion")
        : (() => { const share = options.shares.find(s => s.id === entry.shareId); return share ? shareLabel(share) : t("Shared discussion"); })();
    const index = options.versions.findIndex((v) => v.id === detail.space.versionId);
    return `${index < 0 ? t("Selected version") : `v${options.versions.length - index}`} · ${label}`;
  };
  const bucket = viewerUserId ? draftBucket(viewerUserId, scope.siteId) : null;
  const storedDrafts = useCallback(() => {
    if (draftCache.current) return draftCache.current;
    try { draftCache.current = bucket ? readDrafts(sessionStorage, bucket) : {}; }
    catch { draftCache.current = {}; }
    return draftCache.current;
  }, [bucket]);
  const visibleDraft = useCallback((draft: CommentDraft) =>
    !discoveryDenied && canRecoverCommentDraft(draft, scope, overviewAllowed, Boolean(access?.canReadVersions)),
  [scope, overviewAllowed, access?.canReadVersions, discoveryDenied]);
  function currentDraft(next = composer, value = body): CommentDraft | null {
    if (!next) return null;
    const targetScope = next.kind === "create" ? scope : next.detail.space;
    return {
      kind: next.kind,
      body: value,
      requestId: requestId.current,
      scope: { siteId: targetScope.siteId, versionId: targetScope.versionId, entry: targetScope.entry },
      ...(next.kind === "create" ? { anchor: next.anchor } : { threadId: next.detail.thread.id }),
      ...(next.kind === "edit" ? { messageId: next.message.id, revision: next.message.revision } : {}),
      updatedAt: 0,
    };
  }
  function flushDrafts() {
    clearTimeout(persistTimer.current);
    const drafts = storedDrafts();
    setHasDrafts(Object.values(drafts).some(visibleDraft));
    if (!bucket) return true;
    try {
      writeDrafts(sessionStorage, bucket, drafts);
      storageFailed.current = false;
      return true;
    } catch {
      storageFailed.current = Object.values(drafts).some(d => d.body.trim());
      if (!storageFailed.current) return true;
      setNotice(t("Draft could not be saved on this device. Keep this page open."));
      return false;
    }
  }
  function stash(next = composer, value = body, deferred = false) {
    const draft = currentDraft(next, value);
    if (!draft || !bucket) return flushDrafts();
    const drafts = storedDrafts();
    const id = draftIdentity(draft);
    if (value.trim()) drafts[id] = stampDraft(draft);
    else delete drafts[id];
    if (deferred) {
      setHasDrafts(Object.values(drafts).some(visibleDraft));
      setDraftSaved(false);
      clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => setDraftSaved(flushDrafts() && Boolean(value.trim())), 250);
      return true;
    }
    const saved = flushDrafts();
    setDraftSaved(saved && Boolean(value.trim()));
    return saved;
  }
  function removeDraft(draft: CommentDraft | null) {
    if (draft) delete storedDrafts()[draftIdentity(draft)];
    flushDrafts();
  }
  function dismissInitial() {
    restoreAttempt.current++;
    handledInitial.current = initialThreadId || null;
    setRestoringDraft(false);
    props.onDismissInitialThread?.();
  }
  function focusPanel() {
    requestAnimationFrame(() => {
      if (listRef.current) { listRef.current.scrollTop = 0; if (!workspaceRef.current?.querySelector("textarea")) listRef.current.focus(); }
    });
  }
  function choose(detail: CommentThreadDetail) {
    if (requestBusy.current || busy) return;
    stash();
    setComposer(null);
    setBody("");
    setConflict(null);
    setDeleting(null);
    setUndo(null);
    props.onCancelSelection?.();
    listScroll.current = listRef.current?.scrollTop || 0;
    dismissInitial();
    focusPanel();
    setSelectedId(detail.thread.id);
    setSelectedSnapshot(detail);
    setOpen(true);
    onLocateThread?.(detail);
    const url = new URL(window.location.href);
    url.hash = new URLSearchParams({ comment: detail.thread.id }).toString();
    if (overviewAllowed && detail.space.versionId !== scope.versionId) url.searchParams.set("comments", "all");
    window.history.replaceState(null, "", url);
  }
  const chooseRef = useRef(choose);
  useEffect(() => { chooseRef.current = choose; });
  const chooseSummary = useCallback((detail: CommentThreadDetail) => chooseRef.current(detail), []);
  function backToList() {
    if (requestBusy.current || busy) return;
    stash();
    setComposer(null);
    setBody("");
    selectedRef.current = null;
    setSelectedId(null);
    setSelectedSnapshot(null);
    setDeleting(null);
    setUndo(null);
    dismissInitial();
    const url = new URL(window.location.href);
    url.hash = "";
    url.searchParams.delete("thread");
    window.history.replaceState(null, "", url);
    requestAnimationFrame(() => {
      if (listRef.current) { listRef.current.scrollTop = listScroll.current; listRef.current.focus(); }
    });
  }
  const acceptExternalSelection = useEffectEvent((detail: CommentThreadDetail) => {
    if (composer && (composer.kind === "create" || composer.detail.thread.id !== detail.thread.id)) {
      stash();
      setComposer(null);
      setBody("");
      setConflict(null);
    }
    props.onCancelSelection?.();
    setDeleting(null);
    setUndo(null);
    focusPanel();
    setSelectedId(detail.thread.id);
    setSelectedSnapshot(detail);
    setOpen(true);
  });
  const canCreate = Boolean(access?.canCreate);
  const restored = useRef<string | null | undefined>(undefined);
  const [restoringDraft, setRestoringDraft] = useState(true);
  const restoreAttempt = useRef(0);
  useEffect(() => {
    if (!accessKnown) return;
    if (restored.current === bucket) { queueMicrotask(() => setRestoringDraft(false)); return; }
    // Record completion for guests too: null is a settled identity, not pending recovery.
    restored.current = bucket;
    // Storage recovery synchronizes external tab state after authorization resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!bucket) { setHasDrafts(false); setRestoringDraft(false); return; }
    const anyDrafts = Object.values(storedDrafts()).some(visibleDraft);
    setHasDrafts(anyDrafts);
    if (anyDrafts) setOpen(true);
    const requested = new URLSearchParams(window.location.hash.slice(1)).get("comment") || new URLSearchParams(window.location.search).get("thread");
    const draft = Object.values(storedDrafts())
      .filter(d => !requested || (d.kind !== "create" && d.threadId === requested))
      .filter((d) => canShowCommentScope(d.scope, scope, false) ||
        (overviewAllowed && d.kind !== "create" && d.scope.siteId === scope.siteId))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!draft) { setRestoringDraft(false); return; }
    let active = true;
    const attempt = ++restoreAttempt.current;
    const restore = async () => {
      let next: Composer;
      if (draft.kind === "create" && draft.anchor) {
        if (!canCreate) return;
        next = { kind: "create", anchor: draft.anchor };
      } else {
        if (!draft.threadId) return;
        const detail = await commentRequest<CommentThreadDetail>(`${endpoint}/${draft.threadId}`, shareToken);
        if (!active || attempt !== restoreAttempt.current) return;
        if (draft.kind === "edit") {
          const message = detail.messages.items.find((m) => m.id === draft.messageId);
          if (!message || !detail.permissions.messages[message.id]?.canEdit) return;
          next = {
            kind: "edit",
            detail,
            message: {
              ...message,
              revision: draft.revision ?? message.revision,
            },
          };
        } else {
          if (!detail.permissions.canReply) return;
          next = { kind: "reply", detail };
        }
        setSelectedId(detail.thread.id);
        setSelectedSnapshot(detail);
        locateRef.current?.(detail);
      }
      if (active) {
        setComposer(next);
        setBody(draft.body);
        requestId.current = draft.requestId;
        setOpen(true);
        setDraftSaved(true);
      }
    };
    void restore().catch(() => {}).finally(() => { if (active) setRestoringDraft(false); });
    return () => {
      active = false;
    };
  }, [bucket, accessKnown, canCreate, endpoint, scope, shareToken, storedDrafts, overviewAllowed, visibleDraft]);

  const explain = useCallback(
    (cause: unknown) => {
      if (cause instanceof CommentRequestError) {
        if (cause.status === 409)
          return t("This discussion changed. Refresh it before trying again. Your draft is preserved.");
        if (cause.status === 401) return t("Sign in to comment. Your draft is preserved.");
        if (cause.status === 403 || cause.status === 404)
          return t(
            "This discussion is no longer available with your current access. Your draft is preserved.",
          );
        if (cause.status === 429) return t("Too many requests. Wait a moment and try again.");
      }
      return t("Could not save or load comments. Try again. Your draft is preserved.");
    },
    [t],
  );
  const stashRef = useRef(stash);
  useEffect(() => { stashRef.current = stash; });
  const acceptIdentityChange = useCallback((id: string | null) => { stashRef.current(); onIdentityChange(id); }, [onIdentityChange]);
  const acceptAccess = useCallback((value: Access) => {
    // Re-arm before access becomes known so deep links wait for draft recovery after 401.
    if (restored.current !== bucket) setRestoringDraft(true);
    setDiscoveryDenied(false);
    setAccess(value);
  }, [bucket]);
  const load = useCallback(
    async (next?: string, quiet = false): Promise<void> => {
      if (quiet && inFlight.current) { refreshRequested.current = true; return; }
      inFlight.current = true;
      const initialThreadId = selectedRef.current;
      const sequence = ++generation.current;
      if (!quiet) setLoading(true);
      try {
        const permission = await commentRequest<Access>(`${endpoint}/permissions?${scopeQuery}`, shareToken);
        if (!lifecycle.current.active || sequence !== generation.current) return;
        if (permission.userId !== viewerUserId) {
          acceptIdentityChange(permission.userId);
          return;
        }
        acceptAccess(permission);
        if (permission.isAuthenticated) setNeedsReauthentication(false);
        if (permission.canManageSettings) {
          const settings = await commentRequest<{
            mainPolicy: "off" | "login" | "members";
          }>(`/api/sites/${encodeURIComponent(slug)}/comment-settings`, shareToken);
          if (!lifecycle.current.active || sequence !== generation.current) return;
          setMainPolicy(settings.mainPolicy);
        }
        if (!permission.canRead) {
          polling.current = { failures: 0, nextAt: 0 };
          setRows([]);
          setSelectedId(null);
          setSelectedSnapshot(null);
          setCursor(null);
          setTotal(0);
          return;
        }
        const aggregate = shouldAggregateComments(
          scopeRef.current,
          permission.canAggregate,
          "all",
          Boolean(props.focusedThreadOnly),
        );
        const listEndpoint = aggregate ? `${endpoint}/aggregate` : endpoint;
        const filters = new URLSearchParams(scopeQuery);
        if (aggregate) {
          if (versionFilter === "all") filters.delete("versionId");
          else if (versionFilter !== "current") filters.set("versionId", versionFilter);
          if (source === "main") filters.set("entry", "main");
          else if (shareFilter) filters.set("shareId", shareFilter);
          if (authorFilter) filters.set("authorUserId", authorFilter);
          filters.set("sort", sort);
        }
        if (status) filters.set("status", status);
        if (unreadOnly && permission.userId) filters.set("unread", "true");
        const windowKey = `${viewKey}:${aggregate}`;
        if (expanded.current.key !== windowKey) {
          displacedChecks.current.clear();
          expanded.current = {
            key: windowKey,
            threads: 1,
            messages: new Map(),
          };
        }
        const depth = expanded.current.threads + (next ? 1 : 0);
        const readPage = async (cursor?: string) => {
          if (!lifecycle.current.active || sequence !== generation.current) throw new Error("Superseded comment refresh");
          if (cursor) filters.set("cursor", cursor); else filters.delete("cursor");
          return commentRequest<CommentPage<CommentThreadDetail>>(`${listEndpoint}?${filters}`, shareToken);
        };
        const page = await refreshCommentWindow(depth, readPage);
        // A full window may displace still-readable rows. Revalidate missing displayed IDs
        // individually rather than treating cursor displacement as deletion or fetching all history.
        const retained: CommentThreadDetail[] = [];
        const cachedRows = new Set<string>();
        const revalidated = new Map<string, CommentThreadDetail>();
        if (quiet && !unreadOnly) {
          const seen = new Set(page.items.map(row => row.thread.id));
          for (const id of displacedChecks.current.keys()) if (seen.has(id) || !rowsRef.current.some(row => row.thread.id === id)) displacedChecks.current.delete(id);
          for (const old of rowsRef.current) {
            if (!lifecycle.current.active || sequence !== generation.current) return;
            if (seen.has(old.thread.id)) continue;
            if (old.thread.id !== selectedRef.current && Date.now() - (displacedChecks.current.get(old.thread.id) || 0) < 60_000) { retained.push(old); cachedRows.add(old.thread.id); continue; }
            try {
              const fresh = await commentRequest<CommentThreadDetail>(`${endpoint}/${old.thread.id}`, shareToken);
              displacedChecks.current.set(old.thread.id, Date.now());
              revalidated.set(old.thread.id, fresh);
              if ((!status || fresh.thread.resolution.status === status) &&
                  (!authorFilter || fresh.thread.createdBy === authorFilter) &&
                  (aggregate ? (versionFilter === "all" || fresh.space.versionId === (versionFilter === "current" ? scopeRef.current.versionId : versionFilter)) : canShowCommentScope(fresh.space, scopeRef.current, false)) &&
                  (source !== "main" || fresh.space.entry.kind === "main") &&
                  (!shareFilter || (fresh.space.entry.kind === "share" && fresh.space.entry.shareId === shareFilter))) retained.push(fresh);
            } catch (cause) {
              if (!(cause instanceof CommentRequestError && [403,404].includes(cause.status))) { retained.push(old); cachedRows.add(old.thread.id); }
            }
          }
        }
        let detachedSelection: CommentThreadDetail | undefined;
        const initialKey = `${scopeQuery}:${initialThreadId}`;
        if (
          initialThreadId &&
          unavailableInitial.current !== initialKey &&
          ![...page.items, ...retained].some((row) => row.thread.id === initialThreadId)
        ) {
          try {
            const selected = revalidated.get(initialThreadId) ?? await commentRequest<CommentThreadDetail>(
              `${endpoint}/${encodeURIComponent(initialThreadId)}`,
              shareToken,
            );
            if (!lifecycle.current.active || sequence !== generation.current) return;
            if (selected.thread.id === selectedRef.current) detachedSelection = selected;
          } catch (cause) {
            if (
              cause instanceof CommentRequestError &&
              [403, 404].includes(cause.status) &&
              sequence === generation.current
            ) {
              unavailableInitial.current = initialKey;
              setSelectedId(null);
              setSelectedSnapshot(null);
            }
            if (sequence === generation.current && (!quiet || (cause instanceof CommentRequestError && [403,404].includes(cause.status)))) setNotice(explain(cause));
          }
        }
        for (const detail of [...page.items, ...retained, ...(detachedSelection ? [detachedSelection] : [])]) {
          if (cachedRows.has(detail.thread.id)) continue;
          for (
            let index = 1;
            index < (expanded.current.messages.get(detail.thread.id) ?? 1) && detail.messages.nextCursor;
            index++
          ) {
            if (!lifecycle.current.active || sequence !== generation.current)
              throw new Error("Superseded comment refresh");
            const part = await commentRequest<
              CommentPage<CommentMessage> & {
                permissions: CommentThreadDetail["permissions"]["messages"];
              }
            >(
              `${endpoint}/${detail.thread.id}/messages?${new URLSearchParams({ cursor: detail.messages.nextCursor })}`,
              shareToken,
            );
            detail.messages.items.push(...part.items);
            detail.messages.nextCursor = part.nextCursor;
            Object.assign(detail.permissions.messages, part.permissions);
          }
        }
        if (!lifecycle.current.active || sequence !== generation.current) return;
        setRows((previous) => {
          if (!quiet) return mergeThreads([], page);
          const fresh = new Map([...page.items, ...retained].map((row) => [row.thread.id, row]));
          return previous.filter((row) => fresh.has(row.thread.id)).map((row) => fresh.get(row.thread.id)!);
        });
        if (quiet)
          setUpdates(
            page.items.filter((row) => !rowsRef.current.some((old) => old.thread.id === row.thread.id))
              .length,
          );
        else setUpdates(0);
        const selectedFresh = [...page.items, ...retained].find((row) => row.thread.id === selectedRef.current) ||
          (detachedSelection?.thread.id === selectedRef.current ? detachedSelection : undefined);
        if (selectedFresh) setSelectedSnapshot(selectedFresh);
        setLoadedKey(viewKey);
        expanded.current.threads = depth;
        setCursor(page.nextCursor);
        if (page.total !== undefined) setTotal(page.total);
        polling.current = { failures: 0, nextAt: 0 };
        if (!quiet) setError("");
      } catch (cause) {
        if (lifecycle.current.active && sequence === generation.current) {
          const failures = polling.current.failures + 1;
          polling.current = {
            failures,
            nextAt: Date.now() + commentPollDelay(failures),
          };
          if (cause instanceof CommentRequestError && [401, 403, 404].includes(cause.status)) {
            // An account may change between the permissions and list/settings requests.
            try {
              const current = await commentRequest<Access>(`${endpoint}/permissions?${scopeQuery}`, shareToken);
              if (!lifecycle.current.active || sequence !== generation.current) return;
              if (current.userId !== viewerUserId) { acceptIdentityChange(current.userId); return; }
            } catch { /* Keep the normal access-failure surface when identity cannot be checked. */ }
            setRows([]);
            setSelectedId(null);
            setSelectedSnapshot(null);
            setAccess(null);
            setTotal(0);
          }
          if (!quiet || (cause instanceof CommentRequestError && [401,403,404].includes(cause.status))) setError(explain(cause));
        }
      } finally {
        if (sequence === generation.current) {
          setLoading(false);
          inFlight.current = false;
          if (refreshRequested.current && lifecycle.current.active) { refreshRequested.current = false; queueMicrotask(() => void load(undefined, true)); }
        }
      }
    },
    [
      endpoint,
      scopeQuery,
      shareToken,
      status,
      explain,
      slug,
      source,
      viewKey,
      props.focusedThreadOnly,
      versionFilter,
      shareFilter,
      authorFilter,
      unreadOnly,
      sort,
      setNotice,
      viewerUserId,
      acceptIdentityChange,
      acceptAccess,
    ],
  );

  const settleDeniedDiscovery = useEffectEvent(() => {
    // Inaccessible stored drafts remain intact, but cannot block artifact refresh.
    setDiscoveryDenied(true);
    setHasDrafts(false);
    setRestoringDraft(false);
  });
  useEffect(() => {
    let active = true;
    const discovery = discoverCommentPermissions(
      () => commentRequest<Access>(`${endpoint}/permissions?${scopeQuery}`, shareToken),
      (value) => {
        if (value.userId !== viewerUserId) acceptIdentityChange(value.userId);
        else acceptAccess(value);
      },
      () => document.hidden,
      () => settleDeniedDiscovery(),
    );
    window.addEventListener("focus", discovery.resume);
    document.addEventListener("visibilitychange", discovery.resume);
    void commentRequest<{ count: number; liked: boolean }>(
      `/api/sites/${encodeURIComponent(slug)}/likes`,
      shareToken,
    )
      .then((value) => {
        if (active) setLikes(value);
      })
      .catch(() => {});
    return () => {
      active = false; discovery.stop();
      window.removeEventListener("focus", discovery.resume);
      document.removeEventListener("visibilitychange", discovery.resume);
    };
  }, [endpoint, scopeQuery, shareToken, slug, viewerUserId, acceptIdentityChange, acceptAccess]);
  useEffect(() => {
    if (!initialThreadId) { handledInitial.current = null; return; }
    if (!accessKnown || handledInitial.current === initialThreadId || restoringDraft) return;
    let active = true;
    void commentRequest<CommentThreadDetail>(`${endpoint}/${encodeURIComponent(initialThreadId)}`, shareToken)
      .then((detail) => {
        if (!active) return;
        if (
          !canShowCommentScope(detail.space, scopeRef.current, overviewAllowed) &&
          !(overviewAllowed && detail.space.siteId === scopeRef.current.siteId)
        ) {
          setOpen(true);
          setNotice(
            t("This comment belongs to another version or discussion. Open its original review link."),
          );
          return;
        }
        handledInitial.current = initialThreadId;
        if (overviewAllowed && detail.space.versionId !== scopeRef.current.versionId) setVersionFilter("all");
        acceptExternalSelection(detail);
        locateRef.current?.(detail);
      })
      .catch((cause) => {
        if (active) {
          if (cause instanceof CommentRequestError && [403, 404].includes(cause.status))
            unavailableInitial.current = `${scopeQuery}:${initialThreadId}`;
          setNotice(explain(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [
    initialThreadId,
    restoringDraft,
    endpoint,
    shareToken,
    scopeQuery,
    explain,
    t,
    accessKnown,
    setNotice,
    overviewAllowed,
    versionFilter,
  ]);
  useEffect(() => {
    if (!open && !composer && !markers) return;
    const initial = window.setTimeout(() => void load(), 0);
    const refresh = () => {
      if (document.visibilityState === "visible" && Date.now() >= polling.current.nextAt)
        void load(undefined, true);
    };
    const timer = window.setInterval(refresh, 10_000);
    const focused = () => {
      if (document.visibilityState === "visible") void load(undefined, true);
    };
    window.addEventListener("focus", focused);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(initial);
      clearInterval(timer);
      window.removeEventListener("focus", focused);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, composer, markers, load]);
  useEffect(() => {
    onMarkersChange?.(
      rows.map((row) => ({
        threadId: row.thread.id,
        anchor: row.thread.anchor,
        versionId: row.space.versionId,
      })),
      markers,
    );
  }, [rows, markers, onMarkersChange]);
  const acceptAnchor = useEffectEvent((anchor: CommentAnchor) => {
      stash();
      // A validated iframe selection is an external event, opening the host composer.
      setComposer({ kind: "create", anchor });
      const saved = Object.values(storedDrafts()).find(
        (d) => d.kind === "create" && canShowCommentScope(d.scope, scope, false),
      );
      setBody(saved?.body || "");
      requestId.current = null;
      setOpen(true);
      setSelecting(false);
  });
  useEffect(() => {
    // A validated iframe selection is an external event.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selectedAnchor) acceptAnchor(selectedAnchor);
  }, [selectedAnchor]);
  useEffect(() => {
    if (composer) editor.current?.focus();
  }, [composer]);
  const protectScope = useEffectEvent((event: Event) => {
    const automatic = event instanceof CustomEvent && event.detail?.automatic === true;
    if (automatic && (hasDrafts !== false || Object.values(storedDrafts()).some(visibleDraft) || props.historical)) { event.preventDefault(); return; }
    if (!automatic && !stash()) { event.preventDefault(); setOpen(true); }
  });
  useEffect(() => {
    if (hasDrafts === null) return;
    onDraftChange?.(hasDrafts);
    if (!hasDrafts && !Object.values(storedDrafts()).some(visibleDraft) && !props.historical) window.dispatchEvent(new Event("artifact:comment-draft-cleared"));
  }, [hasDrafts, props.historical, onDraftChange, storedDrafts, visibleDraft]);
  useEffect(() => {
    const before = (event: Event) => protectScope(event);
    const persist = () => {
      clearTimeout(persistTimer.current);
      if (bucket) try { writeDrafts(sessionStorage, bucket, storedDrafts()); storageFailed.current = false; } catch { storageFailed.current = true; }
    };
    const unload = (event: BeforeUnloadEvent) => {
      persist();
      if (storageFailed.current && Object.values(storedDrafts()).some(d => d.body.trim())) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("artifact:before-comment-scope-change", before);
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", persist);
    return () => { persist(); window.removeEventListener("artifact:before-comment-scope-change", before); window.removeEventListener("beforeunload", unload); window.removeEventListener("pagehide", persist); };
  }, [storedDrafts, bucket]);
  function cancel() {
    if (requestBusy.current || busy) return;
    stash();
    dismissInitial();
    setBody("");
    setComposer(null);
    setConflict(null);
    setSelecting(false);
    props.onCancelSelection?.();
    (trigger.current?.offsetParent ? trigger.current : workspaceRef.current)?.focus();
  }
  function discard() {
    setRestoringDraft(false);
    removeDraft(currentDraft());
    setBody("");
    setComposer(null);
    setConflict(null);
    setDraftSaved(false);
    requestId.current = null;
    props.onCancelSelection?.();
  }
  function begin(next?: Composer) {
    if (requestBusy.current || busy) return;
    stash();
    dismissInitial();
    setError("");
    setConflict(null);
    requestId.current = null;
    setDraftSaved(false);
    if (next) {
      setOpen(true);
      const seed =
        next.kind === "edit" && next.message.content.state === "visible" ? next.message.content.body : "";
      const key = currentDraft(next, seed);
      const draft = bucket && key ? storedDrafts()[draftIdentity(key)] : undefined;
      setComposer(next.kind === "edit" && draft?.revision ? { ...next, message: { ...next.message, revision: draft.revision } } : next);
      setBody(draft?.body ?? seed);
      requestId.current = draft?.requestId ?? null;
      setDraftSaved(Boolean(draft));
    } else if (props.onStartSelection) {
      setBody("");
      setComposer(null);
      setSelecting(true);
      if (window.matchMedia("(max-width: 899px)").matches) setOpen(false);
      props.onStartSelection();
    } else {
      begin({ kind: "create", anchor: { kind: "document", schemaVersion: 1, filePath } });
    }
  }

  async function submit() {
    if (!composer || !body.trim() || requestBusy.current || busy) return;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    try {
      if (!requestId.current) requestId.current = crypto.randomUUID();
      stash();
      let createdDetail: CommentThreadDetail | null = null;
      if (composer.kind === "create")
        createdDetail = await commentRequest<CommentThreadDetail>(endpoint, shareToken, {
          method: "POST",
          body: JSON.stringify({
            scope,
            anchor: composer.anchor,
            body,
            clientRequestId: requestId.current,
          }),
        });
      else if (composer.kind === "reply")
        await commentRequest(`${endpoint}/${composer.detail.thread.id}/messages`, shareToken, {
          method: "POST",
          body: JSON.stringify({ body, clientRequestId: requestId.current }),
        });
      else
        await commentRequest(
          `${endpoint}/${composer.detail.thread.id}/messages/${composer.message.id}`,
          shareToken,
          {
            method: "PATCH",
            body: JSON.stringify({
              body,
              expectedRevision: composer.message.revision,
            }),
          },
        );
      if (!lifecycle.current.active) return;
      setRestoringDraft(false);
      removeDraft(currentDraft());
      setComposer(null);
      setBody("");
      requestId.current = null;
      props.onCancelSelection?.();
      setOpen(true);
      showSuccess(t("Comment saved"));
      if (createdDetail) {
        setSelectedId(createdDetail.thread.id);
        setSelectedSnapshot(createdDetail);
        onLocateThread?.(createdDetail);
      }
      await load();
    } catch (cause) {
      setError(explain(cause));
      if (cause instanceof CommentRequestError && cause.status === 401) setNeedsReauthentication(true);
      if (cause instanceof CommentRequestError && cause.status === 409 && composer.kind === "edit") {
        try {
          const fresh = await commentRequest<CommentThreadDetail>(
            `${endpoint}/${composer.detail.thread.id}`,
            shareToken,
          );
          const latest = fresh.messages.items.find((message) => message.id === composer.message.id);
          if (latest) setConflict(latest);
        } catch {
          /* Preserve the draft while access is rechecked by the next refresh. */
        }
      }
    } finally {
      setBusy(false);
      requestBusy.current = false;
    }
  }
  async function mutate(detail: CommentThreadDetail, message?: CommentMessage) {
    if (requestBusy.current || busy) return;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await commentRequest<CommentThreadDetail["thread"]>(
        `${endpoint}/${detail.thread.id}/${message ? `messages/${message.id}` : "status"}`,
        shareToken,
        {
          method: message ? "DELETE" : "PATCH",
          body: JSON.stringify(
            message
              ? { expectedRevision: message.revision }
              : {
                  expectedRevision: detail.thread.revision,
                  status: detail.thread.resolution.status === "open" ? "resolved" : "open",
                },
          ),
        },
      );
      if (!message) {
        const fresh = { ...detail, thread: result };
        setSelectedSnapshot(fresh);
        setRows((previous) => previous.map((row) => (row.thread.id === fresh.thread.id ? fresh : row)));
        setUndo(fresh.thread.resolution.status === "resolved" ? fresh : null);
      }
      setDeleting(null);
      await load();
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
      requestBusy.current = false;
    }
  }
  async function moreMessages(detail: CommentThreadDetail) {
    if (!detail.messages.nextCursor || requestBusy.current || busy) return;
    requestBusy.current = true;
    setBusy(true);
    try {
      const page = await commentRequest<
        CommentPage<CommentMessage> & {
          permissions: CommentThreadDetail["permissions"]["messages"];
        }
      >(
        `${endpoint}/${detail.thread.id}/messages?${new URLSearchParams({ cursor: detail.messages.nextCursor })}`,
        shareToken,
      );
      // Refresh authoritative affordances after pagination; never infer edit rights from author IDs.
      const fresh = await commentRequest<CommentThreadDetail>(`${endpoint}/${detail.thread.id}`, shareToken);
      expanded.current.messages.set(
        detail.thread.id,
        (expanded.current.messages.get(detail.thread.id) ?? 1) + 1,
      );
      const combined: CommentThreadDetail = {
        ...fresh,
        permissions: {
          ...fresh.permissions,
          messages: { ...detail.permissions.messages, ...fresh.permissions.messages, ...page.permissions },
        },
        messages: {
          items: [
            ...new Map(
              [...detail.messages.items, ...fresh.messages.items, ...page.items].map((message) => [
                message.id,
                message,
              ]),
            ).values(),
          ],
          nextCursor: page.nextCursor,
        },
      };
      setRows((previous) => previous.map((row) => (row.thread.id === detail.thread.id ? combined : row)));
      if (selectedRef.current === detail.thread.id) setSelectedSnapshot(combined);
    } catch (cause) {
      setError(explain(cause));
    } finally {
      setBusy(false);
      requestBusy.current = false;
    }
  }
  async function like() {
    if (likeBusy) return;
    setLikeBusy(true);
    try {
      setLikes(
        await commentRequest(`/api/sites/${encodeURIComponent(slug)}/likes`, shareToken, {
          method: "PUT",
          body: JSON.stringify({ liked: !likes.liked }),
        }),
      );
    } catch {
      setNotice(t("Could not update your like. Try again."));
    } finally {
      setLikeBusy(false);
    }
  }
  const composerView = composer && (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby="comment-compose-title"
      className={`comment-composer ${composer.kind === "create" ? "comment-composer-floating" : "comment-composer-inline"}`}
    >
      <div className="comment-panel-heading">
        <h2 id="comment-compose-title">
          {composer.kind === "edit"
            ? t("Edit comment")
            : composer.kind === "reply"
              ? t("Reply")
              : t("Add comment")}
        </h2>
        <button aria-label={t("Close composer")} disabled={busy} onClick={cancel}>
          <X size={18} />
        </button>
      </div>
      <p className="comment-scope">
        {composer.kind === "create"
          ? t("New comment on the selected position")
          : sourceLabel(composer.detail)}
      </p>
      {composer.kind === "create" && (
        <p className="comment-selection-summary">
          {commentAnchorLabel(composer.anchor, "quote" in composer.anchor ? composer.anchor.quote?.exact : null, t)}
          <button
            type="button"
            onClick={() => {
              stash();
              setComposer(null);
              setSelecting(true);
              props.onStartSelection?.();
            }}
          >
            {t("Choose another position")}
          </button>
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={editor}
          aria-label={t("Comment")}
          placeholder={t("Write your feedback…")}
          maxLength={COMMENT_LIMITS.body}
          value={body}
          disabled={busy}
          onChange={(event) => {
            setBody(event.target.value);
            requestId.current = null;
            stash(composer, event.target.value, true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <small className="comment-character-count">{body.length} / {COMMENT_LIMITS.body}</small>
        {error && (
          <p className="comment-error" role="alert">
            {error}
          </p>
        )}
        {needsReauthentication && auth.oidcEnabled && (
          <CommentSignIn onRefresh={() => void load()} busy={loading} />
        )}
        {conflict && (
          <div className="comment-conflict">
            <p>{t("Latest saved comment:")}</p>
            <blockquote>
              {conflict.content.state === "visible" ? conflict.content.body : t("This comment was deleted.")}
            </blockquote>
            {conflict.content.state === "visible" && (
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  if (composer.kind === "edit") { const next = { ...composer, message: conflict }; setComposer(next); stash(next); }
                  setConflict(null);
                  setError("");
                }}
              >
                {t("Keep my draft and use this revision")}
              </button>
            )}
          </div>
        )}
        <div className="comment-compose-footer">
          <button type="button" disabled={busy} onClick={discard}>
            {t("Discard draft")}
          </button>
          <span>{draftSaved ? t("Draft saved in this tab") : t("Ctrl / ⌘ Enter to send")}</span>
          <button className="btn solid" disabled={busy || !body.trim() || Boolean(conflict)} type="submit">
            {busy ? t("Saving…") : t("Send")}
          </button>
        </div>
      </form>
    </section>
  );
  const visibleRows = unreadOnly && !viewerUserId ? rows.filter(detail => unread.unreadThreadIds.has(detail.thread.id)) : rows;
  const canOfferComments =
    access?.canRead || access?.canCreate || (access?.needsLogin && !viewerUserId && auth.oidcEnabled);
  return (
    <div
      ref={workspaceRef}
      tabIndex={-1}
      className="comment-workspace"
      data-panel={open ? "open" : "closed"}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          if (composer || selecting) cancel();
          else {
            dismissInitial();
            setOpen(false);
            (trigger.current?.offsetParent ? trigger.current : workspaceRef.current)?.focus();
          }
        }
      }}
    >
      <div
        className="comment-rail"
        role="toolbar"
        aria-label={t("Artifact actions")}
        data-collapsed={collapsed}
      >
        {!collapsed && (
          <>
            {canOfferComments && (
              <button
                ref={trigger}
                type="button"
                data-tooltip
                aria-label={t("Comments")}
                aria-expanded={open}
                aria-controls="artifact-comments"
                onClick={() => { if (open) dismissInitial(); setOpen(!open); }}
              >
                <MessageCircle size={20} />
                {unread.hasUnread && <span className="comment-unread-dot" role="status" aria-label={t("Unread")} />}
              </button>
            )}
            {access?.canCreate && !props.historical && (
              <button
                type="button"
                data-tooltip
                aria-label={t("Add comment")}
                onClick={() => begin()}
              >
                <MessageCirclePlus size={20} />
              </button>
            )}
            {access?.canRead && (
              <button
                type="button"
                data-tooltip
                aria-label={markers ? t("Hide comment markers") : t("Show comment markers")}
                aria-pressed={markers}
                onClick={() => setMarkers(!markers)}
              >
                {markers ? <Eye size={19} /> : <EyeOff size={19} />}
              </button>
            )}
            <button
              type="button"
              data-tooltip
              aria-label={t("Like this artifact")}
              aria-pressed={likes.liked}
              disabled={likeBusy}
              onClick={() => void like()}
            >
              <Heart size={20} fill={likes.liked ? "currentColor" : "none"} />
              <span className="comment-like-count">{likes.count}</span>
            </button>
            <button
              type="button"
              data-tooltip
              aria-label={t("Copy link")}
              onClick={() => {
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => showSuccess(t("Link copied")))
                  .catch(() => setNotice(t("Could not copy the link. Copy it from the address bar.")));
              }}
            >
              <Copy size={18} />
            </button>
            <MoreMenu
              label={t("More artifact actions")}
              iconOnly
              buttonClassName="comment-more-trigger"
            >
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  if (!document.documentElement.requestFullscreen) {
                    setNotice(t("Fullscreen is unavailable in this browser."));
                    return;
                  }
                  const operation = document.fullscreenElement
                    ? document.exitFullscreen()
                    : document.documentElement.requestFullscreen();
                  void operation.catch(() => setNotice(t("Fullscreen is unavailable in this browser.")));
                }}
              >
                <Maximize size={16} />
                {t("Toggle fullscreen")}
              </button>
              <a role="menuitem" className="menu-item" href={previewHref} target="_blank" rel="noreferrer">
                <ExternalLink size={16} />
                {t("Open in a new tab")}
              </a>
              {props.canDownload && scope.entry.kind === "main" && (
                <SiteDownload
                  slug={slug}
                  editToken={props.editToken}
                  versionId={props.previewVersionId || scope.versionId}
                />
              )}
            </MoreMenu>
          </>
        )}
        <button
          type="button"
          className="comment-rail-toggle"
          data-tooltip
          aria-label={collapsed ? t("Expand artifact actions") : t("Collapse artifact actions")}
          aria-expanded={!collapsed}
          onClick={() => commentRailPreference.set(!collapsed)}
        >
          {collapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          {collapsed && unread.hasUnread && <span className="comment-unread-dot" role="status" aria-label={t("Unread")} />}
        </button>
      </div>
      {selecting && (
        <div className="comment-selection" role="status">
          {t("Click an element, or drag a region on an image or PDF. Esc cancels.")}
          <button
            className="btn sm"
            onClick={() => {
              props.onCancelSelection?.();
              setSelecting(false);
              begin({ kind: "create", anchor: { schemaVersion: 1, kind: "document", filePath } });
            }}
          >
            {t("Whole file")}
          </button>
          <button aria-label={t("Cancel")} onClick={cancel}>
            <X size={16} />
          </button>
        </div>
      )}
      {open && (
        <aside id="artifact-comments" className="comment-panel" aria-label={t("Comments")}>
          <div className="comment-panel-header">
            <div className="comment-panel-heading">
              {selected ? (
                <button type="button" onClick={backToList}>
                  <ArrowLeft size={17} />
                  {t("All comments")}
                </button>
              ) : (
                <h2>
                  {t("Comments")} <small>{total}</small>
                </h2>
              )}
              <div className="comment-header-actions">
                <button type="button" data-tooltip aria-label={t("Refresh comments")} onClick={() => void load()} disabled={loading}>
                  <RefreshCw size={18} />
                </button>
                <button
                  type="button"
                  data-tooltip
                  aria-label={markers ? t("Hide comment markers") : t("Show comment markers")}
                  aria-pressed={markers}
                  onClick={() => setMarkers(!markers)}
                >
                  {markers ? <Eye size={18} /> : <EyeOff size={18} />}
                </button>
                <button
                  type="button"
                  data-tooltip
                  aria-label={t("Close comments")}
                  onClick={() => {
                    stash();
                    dismissInitial();
                    setOpen(false);
                    (trigger.current?.offsetParent ? trigger.current : workspaceRef.current)?.focus();
                  }}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            {!selected && (
              <>
                <p className="comment-scope">
                  {scope.entry.kind === "share"
                    ? t("Only this share link · Selected version")
                    : t("Replies stay in their original discussion.")}
                </p>
                <div className="comment-toolbar">
                  {overviewAllowed && (
                    <>
                      <select
                        aria-label={t("Version")}
                        value={versionFilter}
                        onChange={(e) => {
                          setVersionFilter(e.target.value);
                          setUpdates(0);
                        }}
                      >
                        <option value="current">{t("Current version")}</option>
                        <option value="all">{t("All versions")}</option>
                        {options.versions.map((v, i) => (
                          <option key={v.id} value={v.id}>
                            v{options.versions.length - i} · {new Date(v.createdAt).toLocaleDateString(locale)}
                          </option>
                        ))}
                      </select>
                      <label className="comment-source-filter">
                        <select
                          aria-label={t("Discussion")}
                          value={source}
                          onChange={(e) => {
                            setSource(e.target.value as "all" | "main");
                            setShareFilter("");
                          }}
                        >
                          <option value="all">{t("All discussions")}</option>
                          <option value="main">{t("Main discussion")}</option>
                        </select>
                      </label>
                    </>
                  )}
                  <button
                    type="button"
                    aria-label={t("Filters")}
                    aria-expanded={filtersOpen}
                    onClick={() => setFiltersOpen(!filtersOpen)}
                  >
                    <SlidersHorizontal size={17} /> {t("Filters")}
                  </button>
                </div>
                {filtersOpen && (
                  <div className="comment-filter-drawer">
                    <label>{t("Discussion status")}<select value={status} onChange={event => setStatus(event.target.value as typeof status)}>
                      <option value="">{t("All discussions")}</option><option value="open">{t("In progress")}</option><option value="resolved">{t("Ended")}</option>
                    </select></label>
                    {overviewAllowed && (
                      <>
                        <label>
                          {t("Discussion source")}
                          <select
                            disabled={source === "main"}
                            value={shareFilter}
                            onChange={(e) => setShareFilter(e.target.value)}
                          >
                            <option value="">{t("All discussions")}</option>
                            {options.shares.map((item) => (
                              <option key={item.id} value={item.id}>
                                {shareLabel(item)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Sort order")}
                          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                            <option value="activity">{t("Recent activity")}</option>
                            <option value="newest">{t("Newest first")}</option>
                            <option value="oldest">{t("Oldest first")}</option>
                          </select>
                        </label>
                        <label>
                          {t("Author")}
                          <select value={authorFilter} onChange={(e) => setAuthorFilter(e.target.value)}>
                            <option value="">{t("All authors")}</option>
                            {options.authors.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label || t("Participant")}
                              </option>
                            ))}
                          </select>
                        </label>
                      </>
                    )}

                  </div>
                )}
                    {scope.entry.kind === "main" && access?.canManageSettings && mainPolicy && (
                      <details className="comment-settings"><summary>{t("Comment permissions")}</summary><label>
                        {t("Who can comment on the main link?")}
                        <select
                          value={mainPolicy}
                          disabled={busy}
                          onChange={(e) => {
                            if (requestBusy.current || busy) return;
                            requestBusy.current = true;
                            const policy = e.target.value as typeof mainPolicy;
                            setBusy(true);
                            void commentRequest(
                              `/api/sites/${encodeURIComponent(slug)}/comment-settings`,
                              shareToken,
                              {
                                method: "PATCH",
                                body: JSON.stringify({ mainPolicy: policy }),
                              },
                            )
                              .then(() => {
                                setMainPolicy(policy);
                                void load();
                              })
                              .catch((cause) => setError(explain(cause)))
                              .finally(() => { requestBusy.current = false; setBusy(false); });
                          }}
                        >
                          <option value="login">{t("Signed-in readers")}</option>
                          <option value="members">{t("Site members")}</option>
                          <option value="off">{t("Off")}</option>
                        </select>
                      </label></details>
                    )}
                <div className="comment-tabs" role="group" aria-label={t("Comments")}>
                  <button aria-pressed={!unreadOnly} onClick={() => setUnreadOnly(false)}>{t("All")}</button>
                  <button aria-pressed={unreadOnly} onClick={() => setUnreadOnly(true)}>{t("Unread")} {unread.hasUnread && <span className="comment-unread-dot" />}</button>
                  {unread.hasUnread && <button onClick={() => void unread.markAllRead().catch(cause => setError(explain(cause)))}>{t("Mark all read")}</button>}
                </div>

              </>
            )}
            {props.historical && (
              <div className="comment-history-banner">
                {t("Viewing the original version")}
                <button onClick={props.onRestoreCurrent}>{t("Return to current version")}</button>
              </div>
            )}
          </div>
          {!composer && hasDrafts && (
            <details className="comment-draft-recovery">
              <summary>{t("Saved drafts")}</summary>
              {Object.values(storedDrafts()).filter(visibleDraft).map(d => (
                <a key={draftIdentity(d)} href={scope.entry.kind === "main"
                  ? `/s/${encodeURIComponent(slug)}?version=${encodeURIComponent(d.scope.versionId)}&comments=all${d.threadId ? `#comment=${encodeURIComponent(d.threadId)}` : ""}`
                  : `${window.location.pathname}${window.location.search}${d.threadId ? `#comment=${encodeURIComponent(d.threadId)}` : ""}`}
                  onClick={event => {
                    if (scope.entry.kind === "share" && d.kind === "create" && d.anchor && canShowCommentScope(d.scope, scope, false)) {
                      event.preventDefault();
                      if (canCreate) begin({ kind: "create", anchor: d.anchor });
                      else setNotice(t("This discussion is no longer available with your current access. Your draft is preserved."));
                    } else if (!stash()) event.preventDefault();
                  }}>
                  {t("Resume saved draft")}: {d.body.slice(0, 80)}
                </a>
              ))}
            </details>
          )}
          <div className="comment-panel-content" tabIndex={-1} ref={listRef}>
            {error && (
              <p className="comment-error" role="alert">
                {error}
              </p>
            )}
            {updates > 0 && !selected && (
              <button className="comment-updates" onClick={() => void load()}>
                {t("{count} new discussions", { count: updates })}
              </button>
            )}
            {loading && loadedKey !== viewKey && rows.length === 0 && !selected && (
              <div role="status" className="comment-loading">
                {t("Loading comments…")}
              </div>
            )}
            {selected ? (
              <>
                <CommentConversation
                  detail={selected}
                  source={sourceLabel(selected)}
                  userId={viewerUserId || undefined}
                  busy={busy}
                  onReply={() => begin({ kind: "reply", detail: selected })}
                  onEdit={(message) => begin({ kind: "edit", detail: selected, message })}
                  onDelete={(message) => setDeleting({ detail: selected, message })}
                  onResolve={() => void mutate(selected)}
                  onLocate={() => onLocateThread?.(selected)}
                  onMore={() => void moreMessages(selected)}
                  onReact={async (message, emoji: CommentEmoji, reacted) => {
                    if (requestBusy.current) return;
                    requestBusy.current = true; setBusy(true);
                    try {
                      const reactions = await commentRequest<CommentReaction[]>(`${endpoint}/${selected.thread.id}/messages/${message.id}/reactions`, shareToken, {method:"PUT",body:JSON.stringify({emoji,reacted})});
                      if (!lifecycle.current.active) return;
                      ++generation.current; setLoading(false);
                      // The superseded load no longer owns its finally bookkeeping.
                      inFlight.current = false;
                      refreshRequested.current = false;
                      const update = (detail: CommentThreadDetail): CommentThreadDetail => ({...detail,messages:{...detail.messages,items:detail.messages.items.map(item => item.id === message.id ? {...item,reactions} : item)}});
                      setRows(previous => previous.map(row=>row.thread.id===selected.thread.id ? update(row) : row));
                      setSelectedSnapshot(previous => previous ? update(previous) : previous);
                      void load(undefined, true);
                    } catch (cause) { setError(explain(cause)); }
                    finally { requestBusy.current = false; setBusy(false); }
                  }}
                  actions={props.renderThreadActions?.(selected, Boolean(access?.canAggregate))}
                  context={props.renderThreadContext?.(selected)}
                />
                {props.locationNotice}
                {deleting && (
                  <div className="comment-delete-confirm">
                    <p>{t("Delete this comment? Replies will be kept.")}</p>
                    <button disabled={busy} onClick={() => void mutate(deleting.detail, deleting.message)}>
                      {t("Delete")}
                    </button>
                    <button onClick={() => setDeleting(null)}>{t("Cancel")}</button>
                  </div>
                )}
                {undo?.thread.id === selected.thread.id && (
                  <div className="comment-undo">
                    <Check size={14} />
                    {t("Ended")}
                    <button disabled={busy} onClick={() => void mutate(undo)}>
                      {t("Undo")}
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="comment-threads">
                {visibleRows.map((detail) => (
                  <CommentSummary
                    key={detail.thread.id}
                    detail={detail}
                    source={sourceLabel(detail)}
                    userId={viewerUserId || undefined}
                    unread={unread.unreadThreadIds.has(detail.thread.id)}
                    onChoose={chooseSummary}
                  />
                ))}
                {(!loading || loadedKey === viewKey) && access?.canRead && visibleRows.length === 0 && (
                  <div className="comment-empty">
                    <MessageCircle size={28} />
                    <h3>
                      {unreadOnly ? t("No unread comments") : status || shareFilter || authorFilter
                        ? t("No discussions match these filters.")
                        : t("Start a conversation")}
                    </h3>
                    <p>{t("Keep feedback with this version of the artifact.")}</p>
                  </div>
                )}
                {cursor && (
                  <button className="btn comment-more" disabled={loading} onClick={() => void load(cursor)}>
                    {t("Load more comments")}
                  </button>
                )}
              </div>
            )}
            {access && !access.canRead && viewerUserId && <p>{t("Comments are not available with your current access.")}</p>}
          </div>
          {composer && composer.kind !== "create"
            ? composerView
            : !selected && (
                <div className="comment-panel-footer">
                  {access?.canCreate && !props.historical && (
                    <button className="btn comment-add" onClick={() => begin()}>
                      <MessageCirclePlus size={16} />
                      {aggregate ? t("Add comment to main discussion") : t("Add comment")}
                    </button>
                  )}
                  {access?.needsLogin && !access.isAuthenticated && auth.oidcEnabled && (
                    <CommentSignIn onRefresh={() => void load()} busy={loading} />
                  )}
                </div>
              )}
        </aside>
      )}
      {composer?.kind === "create" && composerView}
      <CommentToast notice={notice} noticeSuccess={noticeSuccess} setNotice={setNotice} />
    </div>
  );
}
export default CommentWorkspace;
