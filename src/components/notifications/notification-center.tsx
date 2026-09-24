"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, Check, X, ArrowRight } from "lucide-react";
import { useAuth } from "@/lib/use-auth";
import { useLocale, useT } from "@/components/locale-provider";
import { relTime } from "@/lib/rel-time";
import type { NotificationPage } from "@/lib/notifications/types";
import { commentRequest } from "@/components/comments/comment-client";

export default function NotificationBell() {
  const { user } = useAuth(),
    t = useT();
  const [open, setOpen] = useState(false),
    [unread, setUnread] = useState(false);
  useEffect(() => {
    if (!user) return;
    let alive = true,
      running = false;
    const check = async () => {
      if (document.hidden || running) return;
      running = true;
      try {
        const result = await commentRequest<{ hasUnread: boolean }>(
          "/api/notifications?badge=1",
        );
        if (alive) setUnread(result.hasUnread);
      } catch {
        /* Retry next foreground interval without interrupting the artifact. */
      } finally {
        running = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 60_000);
    window.addEventListener("artifact:notifications-read", check);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("artifact:notifications-read", check);
    };
  }, [user]);
  if (!user) return null;
  return (
    <>
      <button
        className="notification-bell"
        type="button"
        title={t("Notifications")}
        aria-label={
          unread ? t("Notifications · unread updates") : t("Notifications")
        }
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Bell size={20} />
        {unread && <span />}
      </button>
      {open && <NotificationDrawer onClose={() => setOpen(false)} />}
    </>
  );
}
function NotificationDrawer({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null),
    t = useT();
  useEffect(() => {
    const node = ref.current!,
      previous = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="notification-drawer"
      aria-label={t("Notifications")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) {
          const box = ref.current.getBoundingClientRect();
          if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) onClose();
        }
      }}
    >
      <header>
        <h2>{t("Notifications")}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <NotificationList />
      <footer>
        <Link href="/notifications" onClick={onClose}>
          {t("View all notifications")} <ArrowRight size={16} />
        </Link>
      </footer>
    </dialog>
  );
}
export function NotificationList() {
  const t = useT(),
    locale = useLocale();
  const [unread, setUnread] = useState(false),
    [page, setPage] = useState<NotificationPage | null>(null),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(true);
  const epoch = useRef(0),
    through = useRef(0);
  const load = useCallback(
    async (more = false) => {
      const generation = ++epoch.current;
      setBusy(true);
      setError(false);
      const query = new URLSearchParams(unread ? { unread: "1" } : {});
      if (more && page?.nextCursor) {
        query.set("before", String(page.nextCursor.time));
        query.set("id", page.nextCursor.id);
      }
      try {
        const next = await commentRequest<NotificationPage>(
          `/api/notifications?${query}`,
        );
        if (generation === epoch.current)
          setPage((old) => ({
            ...next,
            items: more ? [...(old?.items ?? []), ...next.items] : next.items,
          }));
      } catch {
        if (generation === epoch.current) setError(true);
      } finally {
        if (generation === epoch.current) setBusy(false);
      }
    },
    [unread, page],
  );
  useEffect(() => {
    let alive = true;
    const generation = ++epoch.current;
    through.current = Date.now();
    void commentRequest<NotificationPage>(
      `/api/notifications${unread ? "?unread=1" : ""}`,
    )
      .then((next) => {
        if (alive && generation === epoch.current) setPage(next);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [unread]);
  const mark = async (id?: string) => {
    const generation = epoch.current;
    setBusy(true);
    try {
      await commentRequest("/api/notifications", undefined, {
        method: "POST",
        body: JSON.stringify(id ? { id } : { through: through.current }),
      });
      window.dispatchEvent(new Event("artifact:notifications-read"));
      if (generation !== epoch.current) return;
      setPage((old) =>
        old
          ? {
              ...old,
              items: old.items.map((item) =>
                (id ? item.id === id : item.createdAt <= through.current) ? { ...item, readAt: Date.now() } : item,
              ).filter((item) => !unread || !item.readAt),
            }
          : old,
      );
    } catch {
      if (generation === epoch.current) setError(true);
    } finally {
      // A filter change starts a newer load, which owns clearing its own busy state.
      if (generation === epoch.current) setBusy(false);
    }
  };
  return (
    <>
      <div className="notification-filters">
        <div role="group" aria-label={t("Filter notifications")}>
          <button
            aria-pressed={!unread}
            onClick={() => {
              if (unread) {
                setUnread(false);
                setPage(null);
                setBusy(true);
                setError(false);
              }
            }}
          >
            {t("All")}
          </button>
          <button
            aria-pressed={unread}
            onClick={() => {
              if (!unread) {
                setUnread(true);
                setPage(null);
                setBusy(true);
                setError(false);
              }
            }}
          >
            {t("Unread")}
          </button>
        </div>
        <button disabled={busy || (!page?.nextCursor && !page?.items.some(item => !item.readAt))} onClick={() => void mark()}>
          <Check size={15} />
          {t("Mark all read")}
        </button>
      </div>
      <div className="notification-list" aria-busy={busy}>
        {error && (
          <p role="alert">
            {t("Could not load notifications.")}{" "}
            <button onClick={() => void load()}>{t("Retry")}</button>
          </p>
        )}
        {!page && busy && <div className="notification-loading" role="status" aria-label={t("Loading…")}>{[0, 1, 2].map(row => <div key={row}><span /><div><i /><i /></div></div>)}</div>}
        {page && !page.items.length && !page.nextCursor && !busy && (
          <div className="notification-empty">
            <span className="notification-empty-icon"><Check size={24} aria-hidden="true" /></span>
            <h3>{t(unread ? "No unread notifications" : "You're all caught up")}</h3>
            <p>{t("Follow a discussion to receive new replies here.")}</p>
          </div>
        )}
        {page?.items.map((item) => (
          <div
            key={item.id}
            className="notification-row"
            data-unread={item.available && !item.readAt}
          >
            {item.available ? (
              <Link
                href={`/notifications/${encodeURIComponent(item.id)}?message=${encodeURIComponent(item.messageId)}&notification=${encodeURIComponent(item.id)}`}
                prefetch={false}
              >
                <span className="notification-avatar" aria-hidden="true">
                  {Array.from(item.author || t("Participant"))[0]}
                </span>
                <div className="notification-content">
                  <strong>
                    {item.author || t("Participant")}{" "}
                    {item.agent && <small>{t("Agent")}</small>} ·{" "}
                    {item.mentioned ? t("mentioned you in a comment") : t("replied to a discussion you follow")}
                  </strong>
                  <p>{item.excerpt || t("Image attachment")}</p>
                  <small className="notification-context">
                    {item.siteTitle} · v{item.versionNumber} ·{" "}
                    {item.shared
                      ? item.shareLabel || t("Share discussion")
                      : t("Main discussion")}
                  </small>
                  <time dateTime={new Date(item.createdAt).toISOString()}>
                    {relTime(item.createdAt, t, locale)}
                  </time>
                </div>
                {!item.readAt && <i aria-hidden="true" />}
              </Link>
            ) : (
              <p>
                {t(
                  "This discussion is no longer available. No content is shown.",
                )}
              </p>
            )}
            {!item.readAt && (
              <button
                className="notification-read"
                disabled={busy}
                onClick={() => void mark(item.id)}
              >
                {t("Mark read")}
              </button>
            )}
          </div>
        ))}
        {page?.nextCursor && (
          <button
            className="btn notification-more"
            disabled={busy}
            onClick={() => void load(true)}
          >
            {t("Load more")}
          </button>
        )}
      </div>
    </>
  );
}
