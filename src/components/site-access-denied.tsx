import RecentUnavailable from "@/components/recent-unavailable";
import Link from "next/link";
import { getT } from "@/lib/i18n-server";
import { getUser } from "@/lib/db";
import { config } from "@/lib/config";
import type { Session } from "@/lib/types";
import SiteAccessActions from "@/components/site-access-actions";

export default async function SiteAccessDenied({ session, viewingHref }: { session: Session | null; viewingHref?: string }) {
  const t = await getT();
  const user = session ? await getUser(session.userId) : null;
  const label = user?.email || user?.displayName;
  return <main className="notfound">
    {!viewingHref && <RecentUnavailable />}
    <h1>{t("Access denied")}</h1>
    <p>{!session && config.oidcEnabled
      ? t("You are not signed in. Sign in, then try opening this link again.")
      : viewingHref ? t("You do not have permission to edit this site. Contact the site owner or the person who sent you the link to request edit access.")
      : session
        ? t("Your current account does not have access to this site. Contact the site owner or the person who sent you the link, then retry once access is granted.")
        : t("You do not have access to this site. Contact the site owner or the person who sent you the link, then retry once access is granted.")}</p>
    {label && <p>{t("Current account: {account}", { account: label })}</p>}
    <SiteAccessActions signedIn={Boolean(session)} loginEnabled={config.oidcEnabled} />
    {viewingHref && <Link className="btn" href={viewingHref}>{t("Back to site")}</Link>}
    <Link className="btn" href="/">{t("Back to home")}</Link>
  </main>;
}
