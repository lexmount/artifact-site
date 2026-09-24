import { headers } from "next/headers";
import Link from "next/link";
import ViewerBrand from "@/components/viewer-brand";
import { LockKeyhole } from "lucide-react";
import { notificationTarget } from "@/lib/notifications/service";
import { getT } from "@/lib/i18n-server";
import SharedCommentShell from "@/components/comments/shared-comment-shell";
import { getVersion } from "@/lib/db";
import { forwardedProto } from "@/lib/http";
export const dynamic = "force-dynamic";
export default async function NotificationTargetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params,
    t = await getT();
  const bag = await headers();
  const proto = forwardedProto(bag) === "https" ? "https" : "http";
  const request = new Request(
    `${proto}://server-component/notifications/${encodeURIComponent(id)}`,
    { headers: { cookie: bag.get("cookie") ?? "" } },
  );
  let target: Awaited<ReturnType<typeof notificationTarget>> = null;
  try {
    target = await notificationTarget(request, id);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode !== 401) throw error;
  }
  const version = target ? await getVersion(target.scope.versionId) : null;
  if (!target || !version)
    return (
      <main className="notification-unavailable">
        <LockKeyhole size={40} />
        <h1>{t("Access needs to be verified")}</h1>
        <p>
          {t(
            "Open the original share link to verify access before viewing this discussion.",
          )}
        </p>
        <Link className="btn" href="/notifications">
          {t("Back to notifications")}
        </Link>
      </main>
    );
  return (
    <SharedCommentShell
      comments={{
        slug: target.site.slug,
        scope: target.scope,
        filePath: version.entry,
        initialThreadId: target.threadId,
      }}
      header={
        <header className="fs-bar notification-viewer-header">
          <Link className="brand" href="/notifications" aria-label={t("Notifications")} title={t("Notifications")}><ViewerBrand /></Link>
          <strong>{target.site.title}</strong>
        </header>
      }
    >
      <div className="fs-stage-wrap">
        <div className="fs-stage">
          <iframe
            className="fs-frame"
            title={target.site.title}
            src={`/api/preview/${encodeURIComponent(target.site.slug)}?v=${encodeURIComponent(version.id)}`}
            sandbox="allow-forms allow-modals allow-scripts allow-popups allow-downloads"
          />
        </div>
      </div>
    </SharedCommentShell>
  );
}
