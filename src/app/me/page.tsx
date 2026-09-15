// /me — the server half: resolve the viewer and the list of sites they may see, then hand it to the
// client page. The viewer matters even signed out: the list must include this browser's own unlisted
// and private sites, or an anonymous creator would not find what they just published.
import type { Metadata } from "next";
import { headers } from "next/headers";
import MePage from "@/components/me-page";
import { listSites, listViewerFromRequest } from "@/lib/sites";
import { forwardedProto } from "@/lib/http";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("My sites — artifact-site") };
}

export default async function Me() {
  // Same cookie-to-viewer bridge as the home page: both readers key off the scheme.
  const h = await headers();
  const proto = forwardedProto(h) === "https" ? "https" : "http";
  const viewer = await listViewerFromRequest(new Request(`${proto}://x/`, { headers: { cookie: h.get("cookie") ?? "" } }));
  const sites = await listSites(viewer, { withViews: true });
  return <MePage allSites={sites} />;
}
