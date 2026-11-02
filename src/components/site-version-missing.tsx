import Link from "next/link";
import { getT } from "@/lib/i18n-server";

export default async function SiteVersionMissing({ slug }: { slug: string }) {
  const t = await getT();
  return <main className="notfound">
    <h1>{t("Version not found")}</h1>
    <p>{t("The version this link points to does not exist or has been deleted. Try opening the current version of the site.")}</p>
    <Link className="btn solid" href={`/s/${encodeURIComponent(slug)}`}>{t("Open current version")}</Link>
    <Link className="btn" href="/">{t("Back to home")}</Link>
  </main>;
}
