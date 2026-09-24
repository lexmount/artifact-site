// /explore — the public directory: every public site on this deployment, newest first, with a
// title search. Deliberately the STRANGER's list (no viewer): a person's own unlisted sites belong
// on /me, and showing them here would make an unlisted site look public to its owner.
import type { Metadata } from "next";
import AppShell from "@/components/app-shell";
import ExploreGrid from "@/components/explore-grid";
import { readDirectory } from "@/lib/directory";
import { parseDirectoryQuery } from "@/lib/directory-query";
import { getLocale, getT } from "@/lib/i18n-server";
import { headers } from "next/headers";
import { resolvePublicBase } from "@/lib/publish-skill";
import { marketingMetadata } from "@/lib/marketing-metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [h, locale, t] = await Promise.all([headers(), getLocale(), getT()]);
  return marketingMetadata({
    base: resolvePublicBase(h),
    path: "/explore",
    locale,
    title: t("Explore — artifact-site"),
    description: t("Public sites on this deployment, newest first."),
  });
}

export default async function ExplorePage({searchParams}: {searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const t = await getT();
  const params=new URLSearchParams();
  for(const [k,v] of Object.entries(await searchParams))if(typeof v === "string")params.set(k,v);
  const directory=await readDirectory({},parseDirectoryQuery(params,"public"));
  return (
    <AppShell>
      <div className="work-title">
        <h1>{t("Explore")}</h1>
      </div>
      <p className="work-lede">{t("Every public site on this deployment, most recently updated first.")}</p>
      <ExploreGrid sites={directory.sites} directory={directory} />
    </AppShell>
  );
}
