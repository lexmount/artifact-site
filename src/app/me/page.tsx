// /me — the server half: resolve the viewer and the list of sites they may see, then hand it to the
// client page. The viewer matters even signed out: the list must include this browser's own unlisted
// and private sites, or an anonymous creator would not find what they just published.
import type { Metadata } from "next";
import { headers } from "next/headers";
import MePage from "@/components/me-page";
import { listSites } from "@/lib/sites";
import { forwardedProto } from "@/lib/http";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { readDirectory } from "@/lib/directory";
import { parseDirectoryQuery } from "@/lib/directory-query";
import { getT } from "@/lib/i18n-server";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("My sites — artifact-site") };
}

export default async function Me({ searchParams }: { searchParams: Promise<Record<string,string|string[]|undefined>> }) {
  // Same cookie-to-viewer bridge as the home page: both readers key off the scheme.
  const h = await headers();
  const proto = forwardedProto(h) === "https" ? "https" : "http";
  const request = new Request(`${proto}://x/`, { headers: { cookie: h.get("cookie") ?? "" } });
  const session = await resolveSession(request);
  const params = new URLSearchParams();
  for (const [k,v] of Object.entries(await searchParams)) if(typeof v === "string") params.set(k,v);
  const tab = params.get("tab") ?? "owned";
  const directory = session && (tab === "owned" || tab === "collab") ? await readDirectory({userId:session.userId,session},parseDirectoryQuery(params)) : undefined;
  // The full discovery set is needed only by browser-local history/anonymous discovery.
  const sites = !session || tab === "recent" ? await listSites({userId:session?.userId ?? null,anonId:anonIdFromRequest(request)}, {withViews:true}) : [];
  return <MePage allSites={sites} directory={directory} userId={session?.userId} />;
}
