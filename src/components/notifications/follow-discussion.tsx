"use client";
import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useT } from "@/components/locale-provider";
import { commentRequest } from "@/components/comments/comment-client";
export default function FollowDiscussion({
  endpoint,
  shareToken,
}: {
  endpoint: string;
  shareToken?: string;
}) {
  const t = useT(),
    [following, setFollowing] = useState<boolean | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    void commentRequest<{ following: boolean }>(
      `${endpoint}/subscription`,
      shareToken,
    )
      .then((r) => {
        if (alive) setFollowing(r.following);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [endpoint, shareToken]);
  const toggle = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await commentRequest<{ following: boolean }>(
        `${endpoint}/subscription`,
        shareToken,
        { method: "POST", body: JSON.stringify({ following: !following }) },
      );
      setFollowing(r.following);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="discussion-follow">
      <button
        type="button"
        disabled={busy || following === null}
        aria-pressed={following === true}
        title={
          following
            ? t(
                "New replies notify you. Unfollow to stop reply notifications; mentions still notify you.",
              )
            : t("Notify me about new replies")
        }
        onClick={() => void toggle()}
      >
        {following ? <Bell size={15} /> : <BellOff size={15} />}{" "}
        {following ? t("Following") : t("Follow discussion")}
      </button>
      {error && (
        <small role="alert">{t("Could not update subscription.")}</small>
      )}
    </span>
  );
}
