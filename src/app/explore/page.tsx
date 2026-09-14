// /explore — the public directory: every public site on this deployment, newest first, with a
// title search. Deliberately the STRANGER's list (no viewer): a person's own unlisted sites belong
// on /me, and showing them here would make an unlisted site look public to its owner.
import type { Metadata } from "next";
import AppShell from "@/components/app-shell";
import ExploreGrid from "@/components/explore-grid";
import { listSites } from "@/lib/sites";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Explore — artifact-site"), description: t("Public sites on this deployment, newest first.") };
}

export default async function ExplorePage() {
  const t = await getT();
  const sites = await listSites();
  return (
    <AppShell>
      <div className="work-title">
        <h1>{t("Explore")}</h1>
      </div>
      <p className="work-lede">{t("Every public site on this deployment, most recently updated first.")}</p>
      <ExploreGrid sites={sites} />
    </AppShell>
  );
}
