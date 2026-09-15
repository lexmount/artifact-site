// Viewer route /s/[slug] — resolves the live site + current version from the store and renders
// the running site inside the sandboxed SiteViewer chrome. Unknown/deleted slug → 404.
import { cache } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import SiteViewer from "@/components/site-viewer";
import RecentTracker from "@/components/recent-tracker";
import Assistant from "@/components/assistant";
import SiteVersionWatcher from "@/components/site-version-watcher";
import { config } from "@/lib/config";
import { getSiteView } from "@/lib/sites";
import { anonymousExpiresAt } from "@/lib/quota";
import { getVersion, countVersions } from "@/lib/db";
import { describePermissions, isAnonymousCreator, viewerRequestFromHeaders } from "@/lib/authz";
import { getStorage } from "@/lib/storage";
import { extractDescription } from "@/lib/upload";
// Same origin resolver the /for-agents surfaces use: ARTIFACT_PUBLIC_URL, else the forwarded Host.
import { resolvePublicBase } from "@/lib/publish-skill";
import { canReadVersion, canReadSite, logSiteOpen } from "@/lib/share";
import { resolveSession } from "@/lib/session";
import { anonIdFromRequest } from "@/lib/anon";
import { afterResponse } from "@/lib/after-response";
import { getT } from "@/lib/i18n-server";
import type { Translator } from "@/lib/i18n";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/**
 * Everything both generateMetadata and the page need about this request, resolved ONCE.
 *
 * Next runs generateMetadata and the page as two separate calls in the same request; before this,
 * each independently looked up the site, rebuilt the viewer Request, resolved the session and ran
 * the read gate — on a private site that gate walks every live share. React's cache() collapses
 * the two into one execution per request (and stays a plain pass-through when the page is invoked
 * directly, as the tests do — there is no request scope to cache in, which is also why the pair
 * can never leak between requests).
 */
const pageContext = cache(async (slug: string) => {
  const bag = await headers();
  const request = viewerRequestFromHeaders(bag, `/s/${slug}`);
  const [view, session] = await Promise.all([getSiteView(slug), resolveSession(request)]);
  const readable = view != null && (await canReadSite(request, view.site, session));
  return { bag, request, view, session, readable };
});

/** How much of the entry document to scan for a description. `<head>` lives at the top, and a large
 *  artifact should not turn a link-preview scrape into a full-file read. */
const META_SCAN_BYTES = 64 * 1024;

/**
 * Metadata for the page a READER lands on, which is also what a chat client scrapes for its link
 * preview card. Two things matter here and neither is about this platform:
 *
 * 1. The description must come from the artifact, never be inherited. Without an explicit one here,
 *    Next merges the root layout's — the platform's own tagline, written for whoever is publishing.
 *    A colleague sent a quarterly report then sees a card explaining how to drag .zip files in.
 *    When the artifact says nothing about itself we say nothing either: a card carrying only a real
 *    title beats one carrying borrowed marketing copy.
 * 2. Open Graph tags, so the card renders as a card at all. There were none, which is why the
 *    scrapers were falling back to the bare <title> + <meta description> in the first place.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  // Gate the METADATA too, not just the page. generateMetadata runs on its own — the page calling
  // notFound() replaces the <head> from the not-found boundary, but this function's result is still
  // serialised into the RSC flight payload, so a plain `curl` on a private site's URL hands out its
  // title and description. Verified: without this check the title appeared 3× in the response body
  // while <head> looked clean, which is exactly how it slipped past the first round of testing.
  const { bag, view, readable } = await pageContext(slug);
  if (!view || !readable) return { title: (await getT())("Site not found — artifact-site"), description: null };

  const title = `${view.site.title} — artifact-site`;
  // Best-effort: a missing/unreadable entry must never fail the page, only leave the card plainer.
  let description: string | null = null;
  try {
    const bytes = await getStorage().read(view.site.id, view.version.id, view.version.entry);
    description = extractDescription(Buffer.from(bytes.slice(0, META_SCAN_BYTES)).toString("utf8"));
  } catch {
    description = null;
  }

  const url = `${resolvePublicBase(bag)}/s/${slug}`;
  // `description: null`, never an omitted key. Next MERGES metadata with the parent layout, so
  // leaving the field out means "inherit" — which is the entire bug: the root description is the
  // platform's tagline. Only an explicit null removes it. (A unit test on this return value cannot
  // catch the difference, because the merge happens after we return; assert on `null` itself.)
  return {
    title,
    description,
    // Neither openGraph nor twitter accepts null for description (only the top-level field does),
    // so both are left to derive from the resolved one above. Spelling `undefined` here instead
    // would be the same mistake in a different place: it reads as "unset", and unset inherits.
    openGraph: { type: "article", siteName: "artifact-site", title, url },
    twitter: { card: "summary", title },
    alternates: { canonical: url },
  };
}

export default async function ViewerPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ published?: string; version?: string }>;
}) {
  const { slug } = await params;
  const { published, version: requestedVersion } = await searchParams;
  // One rebuilt Request and one session resolution for the whole request — generateMetadata, the
  // gate, the permission flags and the view log all see the same reader (see pageContext). The
  // viewer Request variant carries the address / agent / prefetch headers logSiteOpen reads; the
  // authorization path ignores them.
  const { request, view: latestView, session, readable } = await pageContext(slug);
  const selected = requestedVersion ? await getVersion(requestedVersion) : latestView?.version;
  const view = latestView && selected && selected.siteId === latestView.site.id ? { site: latestView.site, version: selected } : null;
  if (!view) notFound();
  // Taken down: the link was public and people hold it, so the honest answer is a sentence, not a
  // 404. No reason is shown — it was written for the owner and the administrators.
  if (!readable && view.site.takenDownAt) return removedNotice(await getT());
  // A private site's own address is for its owner and collaborators; readers arrive at /v/<token>.
  // notFound() rather than a refusal screen — same reason the API outlets answer 404.
  if (!readable) notFound();
  if (!(await canReadVersion(request, view.site, view.version.id, session))) notFound();
  // Independent lookups, one round-trip's worth of waiting. `session` is threaded into
  // describePermissions so nothing on this page resolves the cookie twice.
  const [versionCount, permissions] = await Promise.all([
    countVersions(view.site.id),
    // Permissions are computed server-side and handed down as flags. The client never decides who
    // may do what — after identity landed only the server can know, and rendering a control the
    // viewer cannot use is worse than not rendering it.
    describePermissions(request, view.site, session),
  ]);
  // Recorded HERE and nowhere else — the /s/ twin of /v/[token]'s logShareView, same contract
  // (page only, 30-minute collapse, best-effort). After the read gate: a refused opening is not
  // a view. And after the RESPONSE: the collapse SELECT + INSERT are bookkeeping, and on a
  // Postgres deployment they were two network round-trips the reader waited on for nothing.
  afterResponse(() => logSiteOpen(request, view.site, session, anonIdFromRequest(request)));

  return (
    <>
      {/* Renders nothing — it files this visit into the browser's "Recently viewed" shelf. Everything it
          needs was already resolved above, so the shelf costs no extra query and no extra fetch. */}
      <RecentTracker
        slug={slug}
        title={view.site.title}
        kind={view.site.kind}
        entry={view.version.entry}
        versionCount={versionCount}
        createdAt={view.site.createdAt}
        updatedAt={view.site.updatedAt}
      />
      <SiteViewer
        key={view.version.id}
        viewedVersionId={view.version.id}
        latestVersionId={view.site.currentVersionId}
        pinnedVersionId={requestedVersion}
        officialVersionId={view.site.officialVersionId ?? null}
        slug={slug}
        title={view.site.title}
        kind={view.site.kind}
        versionCount={versionCount}
        published={published === "1"}
        visibility={view.site.visibility}
        permissions={permissions}
        takenDownReason={view.site.takenDownAt ? (view.site.takenDownReason ?? "") : null}
        // Only the anonymous creator is told about the clock — and only while it is running.
        expiresAt={isAnonymousCreator({ anonId: anonIdFromRequest(request) }, view.site) ? anonymousExpiresAt(view.site) : null}
        canSignIn={config.oidcEnabled}
      />
      {/* The page side of "a write-back notifies": SSE first, polling as the fallback, and an "updated"
          toast rather than an automatic reload. */}
      {/* Whoever can edit is the person who directed this change: swap in the new version right away,
          then tell them. Read-only visitors get a hint they can act on at a time of their choosing —
          they may be halfway through a long document. */}
      {!requestedVersion && <SiteVersionWatcher slug={slug} versionId={view.version.id} autoRefresh={permissions.canEditContent} />}
      {/* Assistant edit mode: the floating assistant appears only where the deployment enabled it
          AND this viewer may edit — the permission that makes "Let AI edit this artifact" honourable is
          decided server-side, so an unauthorized viewer never even loads the SDK. */}
      {config.assistantUrl && permissions.canEditContent && (
        <Assistant
          sdkBase={config.assistantUrl}
          slug={slug}
          site={{
            slug,
            title: view.site.title,
            kind: view.site.kind,
            version: versionCount,
            versionId: view.version.id,
          }}
        />
      )}
    </>
  );
}

/** The page a visitor gets for a taken-down site. Same quiet layout as not-found. */
function removedNotice(t: Translator) {
  return (
    <main className="notfound">
      <h1>{t("This content has been removed")}</h1>
      <p>{t("An administrator of this server has taken this site down. If you published it, sign in to see the details.")}</p>
      <Link className="btn solid" href="/">{t("Back to home")}</Link>
    </main>
  );
}
