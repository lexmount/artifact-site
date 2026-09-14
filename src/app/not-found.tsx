import type { Metadata } from "next";
import Link from "next/link";
import { getT } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("Site not found — artifact-site"),
    description: null,
  };
}

export default async function NotFound() {
  const t = await getT();
  return (
    <main className="notfound">
      <h1>{t("Site not found")}</h1>
      <p>{t("The site this link points to does not exist or has been deleted.")}</p>
      <Link className="btn solid" href="/">{t("Back to home")}</Link>
    </main>
  );
}
