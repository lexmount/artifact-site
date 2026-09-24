"use client";
import { MentionPicker } from "./mention-picker";
import { normalizedMentions,rebaseMentions,type CommentMention } from "@/lib/comments/mention-types";
import { createCommentCadence, startVisiblePolling } from "./comment-polling";
import { browserRandomId } from "@/lib/browser-random-id";
import { CommentBody } from "./comment-body";
import { CommentUpload } from "./comment-images";
import { Code, Eye as PreviewIcon } from "lucide-react";
import { CommentResult } from "./comment-result";
import { CommentDestination } from "./comment-destination";
import { commentAnchorLabel, commentAnchorSource } from "@/lib/comments/presentation";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useMemo,
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
  CommentAttachment,
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
  onTextSelectionChange?: (enabled: boolean, label: string) => void;
  selectionPosition?: {x:number;y:number} | null;
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
function consumeDraftRecovery(expected: string | null) {
  const url = new URL(window.location.href);
  if (!expected || url.searchParams.get("draft") !== expected) return;
  url.searchParams.delete("draft");
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

type Access = CommentPermissions & {
  userId: string | null;
  isAuthenticated: boolean;
  needsLogin: boolean;
  canReadVersions: boolean;
};
type Composer =
  | { kind: "create"; anchor: CommentAnchor; targetScope?: CommentScope }
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
  const composerElement = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<CommentThreadDetail | null>(null);
  const [options, setOptions] = useState<{
    versions: { id: string; entry: string; createdAt: number; number: number }[];
    shares: { id: string; label: string | null; createdAt?: number; source?: string; mode?: string; versionIds?: string[]; active?: boolean }[];
    authors: { id: string; label: string | null }[];
  }>({ versions: [], shares: [], authors: [] });
  const [versionFilter, setVersionFilter] = useState("current");
  const [shareFilter, setShareFilter] = useState("");
  const [authorFilter, setAuthorFilter] = useState("");
  const [sort, setSort] = useState<"activity" | "newest" | "oldest">("activity");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [participatedOnly, setParticipatedOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 250); return () => clearTimeout(timer); }, [searchInput]);
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
  const mentionsRef=useRef<CommentMention[]>([]);
  const [attachments, setAttachments] = useState<CommentAttachment[]>([]);
  const attachmentsRef = useRef<CommentAttachment[]>([]);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const [bodyFormat, setBodyFormat] = useState<"plain" | "lightweight">("lightweight");
  const [previewBody, setPreviewBody] = useState(false);
  function restoreAttachments(items: CommentAttachment[] = []) { attachmentsRef.current = items; setAttachments(items); }

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
  const cadence = useRef(createCommentCadence());
  const idleDelay = useRef(10000);
  const interacted = useRef(false);
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
  const viewKey = `${search}:${participatedOnly}:${unreadOnly}:${scopeQuery}:${status}:${source}:${versionFilter}:${shareFilter}:${authorFilter}:${sort}`;
  const overviewAllowed = shouldAggregateComments(
    scope,
    Boolean(access?.canAggregate),
    "all",
    Boolean(props.focusedThreadOnly),
  );
  const aggregate = overviewAllowed;
  const resultVersions = useMemo(() => overviewAllowed && options.versions.length ? options.versions : undefined, [overviewAllowed, options.versions]);
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
  const unreadRef = useRef(unread.unreadThreadIds);
  useEffect(() => { unreadRef.current = unread.unreadThreadIds; }, [unread.unreadThreadIds]);
  useEffect(() => {
    onPanelChange?.(open);
    return () => onPanelChange?.(false);
  }, [open, onPanelChange]);
  const composing = Boolean(composer);
  useEffect(() => {
    if (!overviewAllowed) return;
    let active = true;
    let sequence = 0;
    const refresh = () => {
      const request = ++sequence;
      void commentRequest<typeof options>(`${endpoint}/options`)
        .then(value => { if (active && request === sequence) setOptions(value); })
        .catch(() => {});
    };
    const sharesChanged = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.slug === slug) refresh();
    };
    refresh();
    window.addEventListener("artifact:shares-changed", sharesChanged);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("artifact:shares-changed", sharesChanged);
      window.removeEventListener("focus", refresh);
    };
  }, [overviewAllowed, endpoint, slug, open, composing]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has("comments"))
      queueMicrotask(() => {
        if (params.get("comments") === "all") setVersionFilter("all");
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
    return `${index < 0 ? t("Selected version") : `v${options.versions[index].number}`} · ${label}`;
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
  function currentDraft(next = composer, value = body, images = attachmentsRef.current, format = bodyFormat, mentions = mentionsRef.current): CommentDraft | null {
    if (!next) return null;
    const targetScope = next.kind === "create" ? next.targetScope ?? scope : next.detail.space;
    return {
      kind: next.kind,
      body: value,
      attachments: images,
      bodyFormat: format,
      mentions: mentions.filter(m=>value.slice(m.start,m.end) === "@"+m.label),
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
      storageFailed.current = Object.values(drafts).some(d => d.body.trim() || d.attachments?.length);
      if (!storageFailed.current) return true;
      setNotice(t("Draft could not be saved on this device. Keep this page open."));
      return false;
    }
  }
  function stash(next = composer, value = body, deferred = false, images = attachmentsRef.current, format = bodyFormat, mentions = mentionsRef.current) {
    const draft = currentDraft(next, value, images, format, mentions);
    if (!draft || !bucket) return flushDrafts();
    const drafts = storedDrafts();
    const id = draftIdentity(draft);
    if (value.trim() || draft.attachments?.length) {
      const active = stampDraft(draft);
      // Switching twice in one millisecond must still restore the active draft first.
      for (const other of Object.values(drafts)) other.updatedAt = Math.min(other.updatedAt, active.updatedAt - 1);
      drafts[id] = active;
    }
    else delete drafts[id];
    if (deferred) {
      setHasDrafts(Object.values(drafts).some(visibleDraft));
      setDraftSaved(false);
      clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => setDraftSaved(flushDrafts() && Boolean(value.trim() || draft.attachments?.length)), 250);
      return true;
    }
    const saved = flushDrafts();
    setDraftSaved(saved && Boolean(value.trim() || draft.attachments?.length));
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
    if (requestBusy.current || busy || attachmentPending) return;
    stash();
    setComposer(null);
    mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
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
    if (requestBusy.current || busy || attachmentPending) return;
    const returnThread = selectedRef.current;
    stash();
    setComposer(null);
    mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
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
      if (listRef.current) { listRef.current.scrollTop = listScroll.current; (returnThread ? listRef.current.querySelector<HTMLButtonElement>(`[data-thread-id="${CSS.escape(returnThread)}"]`) ?? listRef.current : listRef.current).focus({preventScroll:true}); }
    });
  }
  const acceptExternalSelection = useEffectEvent((detail: CommentThreadDetail) => {
    if (attachmentPending) return;
    if (composer && (composer.kind === "create" || composer.detail.thread.id !== detail.thread.id)) {
      stash();
      setComposer(null);
      mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
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
  const textSelectionChanged = props.onTextSelectionChange;
  useEffect(() => {
    textSelectionChanged?.(canCreate && !composer && !busy && !props.historical, t("Add comment"));
    return () => textSelectionChanged?.(false, t("Add comment"));
  }, [canCreate, composer, busy, props.historical, textSelectionChanged, t]);
  const eligibleShares = options.shares.filter(item => item.active && (item.mode === "comment" || item.mode === "edit") && item.versionIds?.includes(scope.versionId));
  const defaultCreateScope = (): CommentScope => scope.entry.kind === "main" && shareFilter && eligibleShares.some(item => item.id === shareFilter)
    ? {...scope, entry:{kind:"share", shareId:shareFilter}} : scope;
  const pendingCreationScope = useRef<CommentScope | null>(null);
  const restored = useRef<string | null | undefined>(undefined);
  const [restoringDraft, setRestoringDraft] = useState(true);
  const restoreAttempt = useRef(0);
  const persistRestoration = useEffectEvent((next: Composer, draft: CommentDraft) => {
    requestId.current = draft.requestId;
    return stash(next, draft.body, false, draft.attachments ?? [], draft.bodyFormat ?? "plain", draft.mentions ?? []);
  });
  useEffect(() => {
    if (!accessKnown) return;
    if (restored.current === bucket) { queueMicrotask(() => setRestoringDraft(false)); return; }
    // Record completion for guests too: null is a settled identity, not pending recovery.
    // Storage recovery synchronizes external tab state after authorization resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!bucket) { restored.current = bucket; setHasDrafts(false); setRestoringDraft(false); return; }
    const anyDrafts = Object.values(storedDrafts()).some(visibleDraft);
    setHasDrafts(anyDrafts);
    if (anyDrafts) setOpen(true);
    const requested = new URLSearchParams(window.location.hash.slice(1)).get("comment") || new URLSearchParams(window.location.search).get("thread");
    const requestedDraft = new URLSearchParams(window.location.search).get("draft");
    const draft = Object.values(storedDrafts())
      .filter(d => !requestedDraft || draftIdentity(d) === requestedDraft)
      .filter(d => !requested || (d.kind !== "create" && d.threadId === requested))
      .filter((d) => canShowCommentScope(d.scope, scope, false) ||
        (overviewAllowed && d.scope.siteId === scope.siteId && (d.kind !== "create" || d.scope.versionId === scope.versionId)))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!draft) { restored.current = bucket; setRestoringDraft(false); return; }
    let active = true;
    const attempt = ++restoreAttempt.current;
    const restore = async () => {
      let next: Composer;
      if (draft.kind === "create" && draft.anchor) {
        const target = new URLSearchParams({versionId: draft.scope.versionId});
        if (draft.scope.entry.kind === "share") target.set("shareId", draft.scope.entry.shareId);
        const permission = await commentRequest<Access>(`${endpoint}/permissions?${target}`, shareToken);
        if (!active || attempt !== restoreAttempt.current || !permission.canCreate || permission.userId !== viewerUserId) return;
        next = { kind: "create", anchor: draft.anchor, targetScope: draft.scope };
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
        // Recovery links select a draft once; subsequent reloads follow the active draft.
        // Consume only after successful authorization/restoration and preserve route state.
        const saved = persistRestoration(next, draft);
        if (saved) consumeDraftRecovery(requestedDraft);
        setComposer(next);
        mentionsRef.current=draft.mentions ?? []; setBody(draft.body); restoreAttachments(draft.attachments); setBodyFormat(draft.bodyFormat ?? "plain");
        setOpen(true);
        setDraftSaved(saved);
      }
    };
    void restore().catch(() => {}).finally(() => { if (active) { restored.current = bucket; setRestoringDraft(false); } });
    return () => {
      active = false;
    };
  }, [bucket, accessKnown, endpoint, scope, shareToken, storedDrafts, overviewAllowed, visibleDraft, viewerUserId]);

  const explain = useCallback(
    (cause: unknown) => {
      if (cause instanceof CommentRequestError) {
        if (cause.reason === "image_unavailable") return t("An attached image is unavailable. Remove it and upload it again. Your draft is preserved.");
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
  const mutationRefreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const load = useCallback(
    async (next?: string, quiet = false): Promise<void> => {
      if (quiet && inFlight.current) { refreshRequested.current = true; return; }
      inFlight.current = true;
      refreshRequested.current = false;
      clearTimeout(mutationRefreshTimer.current);
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
        if (search) filters.set("q", search);
        if (participatedOnly && permission.userId) filters.set("participated", "true");
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
        if (unreadOnly && !permission.userId) page.items = page.items.filter(row => unreadRef.current.has(row.thread.id));
        // A full window may displace still-readable rows. Revalidate missing displayed IDs
        // individually rather than treating cursor displacement as deletion or fetching all history.
        const retained: CommentThreadDetail[] = [];
        const cachedRows = new Set<string>();
        const revalidated = new Map<string, CommentThreadDetail>();
        if (quiet) {
          const seen = new Set(page.items.map(row => row.thread.id));
          for (const id of displacedChecks.current.keys()) if (seen.has(id) || !rowsRef.current.some(row => row.thread.id === id)) displacedChecks.current.delete(id);
          for (const old of rowsRef.current) {
            if (!lifecycle.current.active || sequence !== generation.current) return;
            if (seen.has(old.thread.id)) continue;
            // Detail responses cannot validate a search over all paginated replies. Only
            // the filtered list is authoritative; keep an open reader separately below.
            if (search) continue;
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
        // A reader can switch discussions while search refreshes. Preserve the current
        // selection separately from search results; otherwise keep the recovery snapshot.
        const detachedId = search ? selectedRef.current : initialThreadId;
        const initialKey = `${scopeQuery}:${detachedId}`;
        if (
          detachedId &&
          unavailableInitial.current !== initialKey &&
          ![...page.items, ...retained].some((row) => row.thread.id === detachedId)
        ) {
          try {
            const selected = revalidated.get(detachedId) ?? await commentRequest<CommentThreadDetail>(
              `${endpoint}/${encodeURIComponent(detachedId)}`,
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
        idleDelay.current = cadence.current.accept(JSON.stringify([viewKey, permission, page, retained, detachedSelection]), !quiet || interacted.current);
        interacted.current = false;
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
      search,
      participatedOnly,
      setNotice,
      viewerUserId,
      acceptIdentityChange,
      acceptAccess,
    ],
  );

  const recoverMutation = useEffectEvent(() => { void load(undefined, true); });
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{endpoint:string;phase:string}>).detail;
      if (detail?.endpoint !== endpoint) return;
      clearTimeout(mutationRefreshTimer.current);
      if (detail.phase === "start") {
        // Failed writes also restore the fast cadence even when the snapshot is unchanged.
        interacted.current = true;
        idleDelay.current = 10000;
        ++generation.current;
        inFlight.current = false;
        setLoading(false);
      } else {
        // A successful caller's immediate load consumes this fallback. Failed writes
        // still recover a refresh that their start event superseded.
        mutationRefreshTimer.current=setTimeout(()=>recoverMutation(),0);
      }
    };
    window.addEventListener("artifact:comment-mutation", changed);
    return () => { clearTimeout(mutationRefreshTimer.current); window.removeEventListener("artifact:comment-mutation", changed); };
  }, [endpoint]);

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
  const pollingEnabled = open || Boolean(composer) || markers;
  useEffect(() => {
    if (!pollingEnabled) return;
    return startVisiblePolling(
      async (initial) => { await load(undefined, !initial); },
      (wake) => Math.max(wake ? 0 : idleDelay.current, polling.current.nextAt - Date.now()),
    );
  }, [pollingEnabled, load]);
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
      const savedPrevious = stash();
      if (composer && !savedPrevious) return;
      // A validated iframe selection is an external event, opening the host composer.
      if (!canCreate || props.historical || busy || attachmentPending) return;
      const targetScope = pendingCreationScope.current ?? defaultCreateScope();
      pendingCreationScope.current = null;
      setComposer({ kind: "create", anchor, targetScope });
      const saved = Object.values(storedDrafts()).find(
        (d) => d.kind === "create" && canShowCommentScope(d.scope, targetScope, false),
      );
      mentionsRef.current=saved?.mentions ?? []; setBody(saved?.body || ""); restoreAttachments(saved?.attachments); setBodyFormat(saved?.bodyFormat ?? "lightweight");
      requestId.current = null;
      setSelecting(false);
  });
  useEffect(() => {
    // A validated iframe selection is an external event.
    if (selectedAnchor) acceptAnchor(selectedAnchor);
  }, [selectedAnchor]);
  useEffect(() => {
    if (composer) editor.current?.focus();
  }, [composer, open]);
  useEffect(() => {
    const input = editor.current;
    if (!input || !composer) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(240, Math.max(104, input.scrollHeight))}px`;
  }, [body, composer, open]);
  useEffect(() => {
    const element = composerElement.current;
    if (!element || open || composer?.kind !== "create") return;
    const place = () => {
      if (window.innerWidth < 900 || !props.selectionPosition) {
        element.style.removeProperty("left"); element.style.removeProperty("top");
        element.style.removeProperty("bottom"); return;
      }
      const {x,y} = props.selectionPosition;
      const {width,height} = element.getBoundingClientRect();
      element.style.left = `${Math.max(12,Math.min(x,window.innerWidth-width-64))}px`;
      element.style.top = `${Math.max(64,Math.min(y+12+height < window.innerHeight ? y+12 : y-height-44,window.innerHeight-height-12))}px`;
      element.style.bottom = "auto";
    };
    const observer = new ResizeObserver(place); observer.observe(element);
    window.addEventListener("resize",place); place();
    return () => { observer.disconnect(); window.removeEventListener("resize",place); };
  }, [composer, open, props.selectionPosition]);
  const protectScope = useEffectEvent((event: Event) => {
    const automatic = event instanceof CustomEvent && event.detail?.automatic === true;
    if (automatic && (hasDrafts !== false || Object.values(storedDrafts()).some(visibleDraft) || props.historical)) { event.preventDefault(); return; }
    if (attachmentPending) { event.preventDefault(); return; }
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
      if (storageFailed.current && Object.values(storedDrafts()).some(d => d.body.trim() || d.attachments?.length)) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("artifact:before-comment-scope-change", before);
    window.addEventListener("beforeunload", unload);
    window.addEventListener("pagehide", persist);
    return () => { persist(); window.removeEventListener("artifact:before-comment-scope-change", before); window.removeEventListener("beforeunload", unload); window.removeEventListener("pagehide", persist); };
  }, [storedDrafts, bucket]);
  function cancel() {
    if (requestBusy.current || busy || attachmentPending) return;
    pendingCreationScope.current = null;
    stash();
    dismissInitial();
    mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
    setComposer(null);
    setConflict(null);
    setSelecting(false);
    props.onCancelSelection?.();
    (trigger.current?.offsetParent ? trigger.current : workspaceRef.current)?.focus();
  }
  function discard() {
    pendingCreationScope.current = null;
    setRestoringDraft(false);
    for (const attachment of attachmentsRef.current) {
      void commentRequest(`${endpoint}/attachments/${attachment.id}`, shareToken, {method:"DELETE"}).catch(()=>{});
    }
    removeDraft(currentDraft());
    mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
    setComposer(null);
    setConflict(null);
    setDraftSaved(false);
    requestId.current = null;
    props.onCancelSelection?.();
  }
  function begin(next?: Composer) {
    if (requestBusy.current || busy || attachmentPending) return;
    const savedPrevious = stash();
    if (composer && !savedPrevious) return;
    dismissInitial();
    setError("");
    setConflict(null);
    requestId.current = null;
    setDraftSaved(false);
    if (next) {
      if (next.kind === "create") next = {...next, targetScope:next.targetScope ?? pendingCreationScope.current ?? defaultCreateScope()};
      pendingCreationScope.current = null;
      setOpen(true);
      const seed =
        next.kind === "edit" && next.message.content.state === "visible" ? next.message.content.body : "";
      const key = currentDraft(next, seed);
      const draft = bucket && key ? storedDrafts()[draftIdentity(key)] : undefined;
      setComposer(next.kind === "edit" && draft?.revision ? { ...next, message: { ...next.message, revision: draft.revision } } : next);
      mentionsRef.current=draft?.mentions ?? (next.kind === "edit" && next.message.content.state === "visible" ? next.message.content.mentions ?? [] : []); setBody(draft?.body ?? seed); restoreAttachments(draft?.attachments ?? (next.kind === "edit" ? next.message.attachments : [])); setBodyFormat(draft?.bodyFormat ?? (next.kind === "edit" && next.message.content.state === "visible" ? next.message.content.format ?? "plain" : "lightweight"));
      requestId.current = draft?.requestId ?? null;
      setDraftSaved(Boolean(draft));
    } else if (props.onStartSelection) {
      pendingCreationScope.current = defaultCreateScope();
      mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
      setComposer(null);
      setSelecting(true);
      if (window.matchMedia("(max-width: 899px)").matches) setOpen(false);
      props.onStartSelection();
    } else {
      begin({ kind: "create", anchor: { kind: "document", schemaVersion: 1, filePath } });
    }
  }

  async function submit() {
    if (!composer || (!body.trim() && !attachments.length) || requestBusy.current || busy || attachmentPending) return;
    requestBusy.current = true;
    setBusy(true);
    setError("");
    try {
      if (!requestId.current) requestId.current = browserRandomId();
      stash();
      let createdDetail: CommentThreadDetail | null = null;
      if (composer.kind === "create")
        createdDetail = await commentRequest<CommentThreadDetail>(endpoint, shareToken, {
          method: "POST",
          body: JSON.stringify({
            scope: composer.targetScope ?? scope,
            anchor: composer.anchor,
            body, bodyFormat, mentions:normalizedMentions(body,mentionsRef.current), attachmentIds: attachments.map(item=>item.id),
            clientRequestId: requestId.current,
          }),
        });
      else if (composer.kind === "reply")
        await commentRequest(`${endpoint}/${composer.detail.thread.id}/messages`, shareToken, {
          method: "POST",
          body: JSON.stringify({ body, bodyFormat, mentions:normalizedMentions(body,mentionsRef.current), attachmentIds: attachments.map(item=>item.id), clientRequestId: requestId.current }),
        });
      else
        await commentRequest(
          `${endpoint}/${composer.detail.thread.id}/messages/${composer.message.id}`,
          shareToken,
          {
            method: "PATCH",
            body: JSON.stringify({
              body, bodyFormat, mentions:normalizedMentions(body,mentionsRef.current), attachmentIds: attachments.map(item=>item.id),
              expectedRevision: composer.message.revision,
            }),
          },
        );
      if (!lifecycle.current.active) return;
      setRestoringDraft(false);
      removeDraft(currentDraft());
      setComposer(null);
      mentionsRef.current=[]; setBody(""); restoreAttachments(); setPreviewBody(false);
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
      if (cause instanceof CommentRequestError && cause.status === 409 && !cause.reason && composer.kind === "edit") {
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
    if (requestBusy.current || busy || attachmentPending) return;
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
    const sequence = ++generation.current;
    inFlight.current = false;
    setLoading(false);
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
      if (!lifecycle.current.active || sequence !== generation.current) return;
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
      className={`comment-composer ${composer.kind === "create" && !open ? "comment-composer-floating" : "comment-composer-inline"}`}
      ref={composerElement}
    >
      <div className="comment-panel-heading">
        <h2 id="comment-compose-title">
          {composer.kind === "edit"
            ? t("Edit comment")
            : composer.kind === "reply"
              ? t("Reply")
              : t("Add comment")}
        </h2>
        <button aria-label={t("Close composer")} disabled={busy || attachmentPending} onClick={cancel}>
          <X size={18} />
        </button>
      </div>
      {composer.kind !== "create" && <p className="comment-scope">{sourceLabel(composer.detail)}</p>}
      {composer.kind === "create" && (
        <div className="comment-selection-summary">
          <span className="comment-quote-text">
          {commentAnchorLabel(composer.anchor, "quote" in composer.anchor ? composer.anchor.quote?.exact : null, t)}
          </span>
          <div className="comment-quote-source"><span>{commentAnchorSource(composer.anchor, t)}</span>
          <button
            type="button"
            aria-label={t("Choose another position")}
            disabled={busy || attachmentPending}
            onClick={() => {
              if (!stash()) return;
              pendingCreationScope.current = composer.targetScope ?? scope;
              setComposer(null);
              setSelecting(true);
              props.onStartSelection?.();
            }}
          >
            {t("Reselect")}
          </button></div>
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          hidden={previewBody}
          ref={editor}
          aria-label={t("Comment")}
          placeholder={t("Write your feedback…")}
          maxLength={COMMENT_LIMITS.body}
          value={body}
          disabled={busy}
          onChange={(event) => {
            mentionsRef.current=rebaseMentions(body,event.target.value,mentionsRef.current);
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
        {previewBody && <div className="comment-body comment-body-preview"><CommentBody body={body || t("Write your feedback…")} mentions={mentionsRef.current} format={bodyFormat}/></div>}
        <div className="comment-format-tools">
          <MentionPicker key={JSON.stringify(composer.kind === "create" ? composer.targetScope ?? scope : composer.detail.space)} endpoint={endpoint} shareToken={shareToken} textarea={editor} disabled={busy || previewBody} scope={composer.kind === "create" ? composer.targetScope ?? scope : composer.detail.space} onInsert={(person,start,end)=>{
            const text="@"+person.label,next=body.slice(0,start)+text+" "+body.slice(end);
            if(next.length>COMMENT_LIMITS.body)return;
            mentionsRef.current=[...rebaseMentions(body,next,mentionsRef.current),{...person,start,end:start+text.length}];
            setBody(next);requestId.current=null;stash(composer,next,true);
            requestAnimationFrame(()=>{editor.current?.focus();editor.current?.setSelectionRange(start+text.length+1,start+text.length+1);});
          }}/>

          <button type="button" disabled={busy || previewBody} title={t("Code format: for field names, filenames or code snippets.")} aria-label={t("Code format")} onClick={()=>{
            const input=editor.current; if(!input) return;
            const start=input.selectionStart,end=input.selectionEnd;
            if(body.length+2>COMMENT_LIMITS.body) return;
            const next=body.slice(0,start)+"`"+body.slice(start,end)+"`"+body.slice(end);
            mentionsRef.current=rebaseMentions(body,next,mentionsRef.current);setBodyFormat("lightweight");setBody(next);requestId.current=null;stash(composer,next,true,attachmentsRef.current,"lightweight");
            requestAnimationFrame(()=>{input.focus();input.setSelectionRange(start+1,end+1);});
          }}><Code size={16}/></button>
          <button type="button" disabled={busy} aria-pressed={previewBody} onClick={()=>setPreviewBody(value=>!value)}><PreviewIcon size={16}/>{previewBody ? t("Back to editing") : t("Preview comment style")}</button>
        </div>
        <CommentUpload key={JSON.stringify([composer.kind,composer.kind === "create" ? composer.targetScope ?? scope : composer.detail.space, composer.kind === "edit" ? composer.message.id : ""])}
          textarea={editor} attachments={attachments} endpoint={endpoint} shareToken={shareToken}
          scope={composer.kind === "create" ? composer.targetScope ?? scope : composer.detail.space}
          disabled={busy} onPending={setAttachmentPending} onChange={next=>{restoreAttachments(next);requestId.current=null;stash();}}/>
        {body.length >= COMMENT_LIMITS.body * .9 && <small className="comment-character-count">{body.length} / {COMMENT_LIMITS.body}</small>}
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
      {composer.kind === "create" && overviewAllowed && scope.entry.kind === "main" && (eligibleShares.length > 0 || composer.targetScope?.entry.kind === "share") && (
        <CommentDestination disabled={busy || attachmentPending} value={(composer.targetScope ?? scope).entry.kind === "share" ? ((composer.targetScope ?? scope).entry as {kind:"share";shareId:string}).shareId : "main"}
          options={[{id:"main",label:t("Main discussion")},
            ...eligibleShares.map(item=>({id:item.id,label:item.label || (item.source === "publish" ? t("Publication link") : t("Shared discussion")),createdAt:item.createdAt})),
            ...(composer.targetScope?.entry.kind === "share" && !eligibleShares.some(item=>item.id === (composer.targetScope!.entry as {shareId:string}).shareId) ? [{id:composer.targetScope.entry.shareId,label:t("Unavailable discussion"),disabled:true}] : [])]}
          onChange={value=>{
              if (!stash()) return;
              const targetScope: CommentScope = {...scope, entry:value === "main" ? {kind:"main"} : {kind:"share",shareId:value}};
              let next: Composer = {...composer, targetScope};
              const draft = currentDraft(next);
              const saved = draft ? storedDrafts()[draftIdentity(draft)] : undefined;
              // An empty composer represents the position the user just chose. Keep that
              // position when loading a destination's body; nonempty drafts restore in full.
              const keepSelection = !body.trim() && !attachments.length;
              if (!keepSelection && saved?.kind === "create" && saved.anchor) next = {...next, anchor: saved.anchor};
              const nextBody = saved?.body ?? "";
              const previousRequestId = requestId.current;
              requestId.current = keepSelection && JSON.stringify(saved?.anchor) !== JSON.stringify(next.anchor)
                ? null : saved?.requestId ?? null;
              if (!stash(next, nextBody, false, saved?.attachments ?? [], saved?.bodyFormat ?? "lightweight", saved?.mentions ?? [])) { requestId.current = previousRequestId; return; }
              // A successful switch also supersedes a recovery link retained after a storage failure.
              consumeDraftRecovery(new URLSearchParams(window.location.search).get("draft"));
              restoreAttachments(saved?.attachments); setBodyFormat(saved?.bodyFormat ?? "lightweight");
              mentionsRef.current=saved?.mentions ?? []; setComposer(next); setBody(nextBody);
              setError("");
          }}/>

      )}
        <div className="comment-compose-footer">
          {(body.trim() || attachments.length > 0) && <button type="button" disabled={busy || attachmentPending} onClick={discard}>
            {t("Discard draft")}
          </button>}
          <span title={t("Draft saved in this tab")}>{draftSaved && t("Draft saved")}</span>
          <button className="btn solid" disabled={busy || attachmentPending || (!body.trim() && !attachments.length) || Boolean(conflict)} type="submit">
            {busy ? t("Saving…") : t("Send")}
          </button>
        </div>
      </form>
    </section>
  );
  const visibleRows = rows;
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
                disabled={attachmentPending}
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
        <aside id="artifact-comments" className="comment-panel" data-composing={composer?.kind === "create" || undefined} aria-label={t("Comments")}>
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
                  disabled={attachmentPending}
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
                        {options.versions.map((v) => (
                          <option key={v.id} value={v.id}>
                            v{v.number} · {new Date(v.createdAt).toLocaleDateString(locale)}
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
                            if (requestBusy.current || busy || attachmentPending) return;
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
                <div className="comment-search-field"><input className="comment-search" type="search" aria-label={t("Search comments and replies")} placeholder={t("Search comments and replies")} maxLength={200} value={searchInput} onChange={event => setSearchInput(event.target.value)} />
                  {searchInput && <button type="button" aria-label={t("Clear search")} onClick={event => {setSearchInput("");setSearch("");event.currentTarget.parentElement?.querySelector("input")?.focus();}}><X size={16}/></button>}
                </div>
                {(search || status || authorFilter || shareFilter || source !== "all" || sort !== "activity" || versionFilter !== "current" || participatedOnly || unreadOnly) && <div className="comment-filter-summary">
                  <span>{[search && t("Search: {query}", {query:search}), status && (status === "open" ? t("In progress") : t("Ended")), authorFilter && (options.authors.find(a=>a.id===authorFilter)?.label || t("Participant")), shareFilter && (options.shares.find(a=>a.id===shareFilter)?.label || t("Shared discussion")), versionFilter !== "current" && (versionFilter === "all" ? t("All versions") : t("Version {n}",{n:options.versions.find(v=>v.id===versionFilter)?.number??"?"})), source === "main" && t("Main discussion"), sort !== "activity" && (sort === "newest" ? t("Newest first") : t("Oldest first")), participatedOnly && t("I participated"), unreadOnly && t("Unread")].filter(Boolean).join(" · ")}</span>
                  <button type="button" onClick={event=>{event.currentTarget.closest(".comment-panel-header")?.querySelector<HTMLInputElement>(".comment-search")?.focus();setSearchInput("");setSearch("");setStatus("");setAuthorFilter("");setShareFilter("");setVersionFilter("current");setSource("all");setSort("activity");setParticipatedOnly(false);setUnreadOnly(false);}}>{t("Clear filters")}</button>
                </div>}
                <div className="comment-tabs" role="group" aria-label={t("Comments")}>
                  <button aria-pressed={!unreadOnly && !participatedOnly} onClick={() => { setUnreadOnly(false); setParticipatedOnly(false); }}>{t("All")}</button>
                  <button aria-pressed={unreadOnly} onClick={() => { setUnreadOnly(true); setParticipatedOnly(false); }}>{t("Unread")} {unread.hasUnread && <span className="comment-unread-dot" />}</button>
                  {access?.userId && <button aria-pressed={participatedOnly} onClick={() => { setParticipatedOnly(true); setUnreadOnly(false); }}>{t("I participated")}</button>}
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
                  ? `/s/${encodeURIComponent(slug)}?version=${encodeURIComponent(d.scope.versionId)}&comments=all&draft=${encodeURIComponent(draftIdentity(d))}${d.threadId ? `#comment=${encodeURIComponent(d.threadId)}` : ""}`
                  : `${window.location.pathname}${window.location.search}${d.threadId ? `#comment=${encodeURIComponent(d.threadId)}` : ""}`}
                  onClick={event => {
                    if (d.kind === "create" && d.anchor && d.scope.versionId === scope.versionId) {
                      event.preventDefault();
                      if (canCreate && (canShowCommentScope(d.scope, scope, false) || (overviewAllowed && d.scope.entry.kind === "share" && eligibleShares.some(item => item.id === (d.scope.entry as {shareId:string}).shareId)))) begin({ kind: "create", anchor: d.anchor, targetScope: d.scope });
                      else setNotice(t("This discussion is no longer available with your current access. Your draft is preserved."));
                    } else if (!stash()) event.preventDefault();
                  }}>
                  {t("Resume saved draft")}: {d.body.slice(0, 80) || t("Image attachment")}
                </a>
              ))}
            </details>
          )}
          <div className="comment-panel-content" tabIndex={-1} ref={listRef}>
            {error && (
              <p className="comment-error" role="alert">
                {error}
                {!selected && <button type="button" disabled={loading} onClick={()=>void load(loadedKey === viewKey ? cursor || undefined : undefined)}>{t("Retry")}</button>}
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
                  endpoint={endpoint} shareToken={shareToken} query={search}
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
                <CommentResult key={selected.thread.id} detail={selected} endpoint={endpoint} token={shareToken} busy={busy} versions={resultVersions} onChange={() => void load(undefined, true)} onError={cause => setError(explain(cause))} />
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
                    query={search}
                    detail={detail}
                    source={sourceLabel(detail)}
                    userId={viewerUserId || undefined}
                    unread={unread.unreadThreadIds.has(detail.thread.id)}
                    onChoose={chooseSummary}
                  />
                ))}
                {!error && (!loading || loadedKey === viewKey) && access?.canRead && visibleRows.length === 0 && (
                  <div className="comment-empty">
                    <MessageCircle size={28} />
                    <h3>
                      {unreadOnly ? t("No unread comments") : search || participatedOnly || status || shareFilter || authorFilter || versionFilter !== "current" || source !== "all"
                        ? t("No discussions match these filters.")
                        : t("Start a conversation")}
                    </h3>
                    <p>{search || participatedOnly || unreadOnly || status || shareFilter || authorFilter || versionFilter !== "current" || source !== "all" ? t("Try another keyword or clear the filters.") : t("Keep feedback with this version of the artifact.")}</p>
                  </div>
                )}
                {cursor && (
                  <button className="btn comment-more" disabled={loading} onClick={() => void load(cursor)}>
                    {loading ? t("Loading comments…") : t("Load more comments")}
                  </button>
                )}
              </div>
            )}
            {access && !access.canRead && viewerUserId && <p>{t("Comments are not available with your current access.")}</p>}
          </div>
          {composer
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
      {composer?.kind === "create" && !open && composerView}
      <CommentToast notice={notice} noticeSuccess={noticeSuccess} setNotice={setNotice} />
    </div>
  );
}
export default CommentWorkspace;
