// /publish-from-page — the bookmarklet's landing page: opened directly it is the install guide,
// opened by the bookmark it is the publish confirmation. Both ends live in one route because they
// are two ends of the same thing; splitting them would only give people one more address to remember.
import AppShell from "@/components/app-shell";
import type { Metadata } from "next";
import PublishFromPage from "@/components/publish-from-page";
import { getT } from "@/lib/i18n-server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return {
    title: t("Publish the page you are looking at — artifact-site"),
    description: t("Drag a button to your bookmarks bar; after that any page (including local file:// files) can be published as a shareable link in one click."),
  };
}

export default async function PublishFromPageRoute() {
  return (
    <AppShell>
      <div className="pfp">
        <PublishFromPage />
      </div>
    </AppShell>
  );
}
