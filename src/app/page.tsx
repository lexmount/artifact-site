// Home introduces agent publishing and collaboration, then shows the viewer's recent work.
//
// `listSites()` is every site this VIEWER may see listed, not "mine" — the browser derives
// "recently viewed" FROM this list. Why the viewer is resolved here at all: the list hides
// unlisted sites, and handing down the bare public directory would hide your own unlisted site
// from your own recent shelf. So the query gets the viewer, and the exception stays server-side.
import { headers } from "next/headers";
import type { Metadata } from "next";
import AppShell from "@/components/app-shell";
import HomePublishActions from "@/components/home-publish-actions";
import HeroMotion from "@/components/hero-motion";
import HomeRecent from "@/components/home-recent";
import { listSites, listViewerFromRequest } from "@/lib/sites";
import { resolvePublicBase } from "@/lib/publish-skill";
import { forwardedProto } from "@/lib/http";
import { getLocale, getT } from "@/lib/i18n-server";
import { marketingMetadata } from "@/lib/marketing-metadata";
import { platformCopy } from "@/lib/platform-copy";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const [h, locale, t] = await Promise.all([headers(), getLocale(), getT()]);
  return marketingMetadata({
    base: resolvePublicBase(h),
    path: "/",
    locale,
    title: t(platformCopy.title),
    description: t(platformCopy.description),
  });
}

export default async function Home() {
  const t = await getT();
  // A server component has headers, not a Request, and both cookie readers key off the scheme
  // (`__Host-` on https, the bare name on plain-http dev). Next fills in x-forwarded-proto, so the
  // synthesized URL carries the real scheme instead of guessing one and missing the cookie.
  const h = await headers();
  const proto = forwardedProto(h) === "https" ? "https" : "http";
  const viewer = await listViewerFromRequest(
    new Request(`${proto}://x/`, { headers: { cookie: h.get("cookie") ?? "" } }),
  );
  const [sites, ownedSites] = await Promise.all([listSites(viewer), listSites(viewer, { ownedOnly: true, limit: 6 })]);
  // The AI entry hands out THIS deployment's own address, same resolution as /for-agents(.md).
  const base = resolvePublicBase(h);

  return (
    <AppShell>
      <section className="hero">
        <div className="hero-copy">
          <h1>{t("Manage your agent’s work,")}<br /><span className="hl">{t("build a bridge to collaboration.")}</span></h1>
          <p className="deck">{t("Share pages, reports and documents with one link.")}<br />{t("Discuss together, then let an agent keep improving it.")}</p>
          <HomePublishActions base={base} />
        </div>
        <HeroMotion />
      </section>

      <HomeRecent allSites={sites} ownedSites={ownedSites} />
    </AppShell>
  );
}
