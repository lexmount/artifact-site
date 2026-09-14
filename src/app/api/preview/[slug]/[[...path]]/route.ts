// Serve read path — GET /api/preview/:slug/:path*. The whole body is lib/preview.servePreviewFile:
// path guards, current-version render, <base> + storage shim, sandbox CSP. 404 unknown · 400 guard.
//
// THIS is where an artifact's bytes leave the building, so it is the route the read gate has to sit
// on. Gating only /s/<slug> would be theatre: the preview URL is one guess away and the artifact's
// own sub-resources come through here too. A refused reader gets 404, not 403 — a private site
// should not confirm its own existence to someone who cannot read it.
//
// [The first segment may carry a credential: `<slug>~<key>`]
// The artifact runs in a sandbox iframe without allow-same-origin, so the browser classifies every
// sub-request it makes as cross-site and attaches no cookie at all — the raw requests captured looked like:
//
//   (entry)   sec-fetch-site=same-origin  dest=iframe  → carries the session cookie
//   arch.png  sec-fetch-site=cross-site   dest=image   → carries nothing
//
// So a private site's entry HTML gets through, while every image and stylesheet it references is
// turned away as a stranger. Hence the credential goes into the path: `<base>` carries
// `<slug>~<key>/`, and sub-resources inherit it when resolving relative paths. See lib/preview-key.
import { NextResponse } from "next/server";
import { servePreviewFile } from "@/lib/preview";
import { getSiteView } from "@/lib/sites";
import { canReadSite } from "@/lib/share";
import { mintPreviewKey, previewBaseHref, splitSlugKey, verifyPreviewKey } from "@/lib/preview-key";

export async function GET(request: Request, context: { params: Promise<{ slug: string; path?: string[] }> }): Promise<NextResponse> {
  try {
    return await serve(request, context);
  } catch (error) {
    // Anything the read gate or the store throws (a database outage, a bad row) must not reach the
    // visitor as text: on this route a message is an existence oracle, and a stack is worse. Log
    // it for the operator and answer a bare 500 — no body, nothing to compare across slugs.
    console.error("[preview] unexpected error:", error);
    return new NextResponse(null, { status: 500 });
  }
}

async function serve(request: Request, context: { params: Promise<{ slug: string; path?: string[] }> }): Promise<NextResponse> {
  const { slug: segment, path } = await context.params;
  const { slug, key } = splitSlugKey(segment);

  // One extra lookup per request, and only on private sites does it cost a share query — a public
  // or unlisted site short-circuits inside canReadSite before touching the shares table.
  const view = await getSiteView(slug);
  // Only someone who fails both checks is a stranger: either they can read the site themselves (the
  // requests that can carry cookies), or the URL they hold carries an unexpired credential issued by
  // this site (the sub-requests from the opaque frame take this path).
  const canRead = view ? await canReadSite(request, view.site) : false;
  const keyed = view ? verifyPreviewKey(key, view.site) : false;
  if (view && !canRead && !keyed) {
    // A takedown is not a secret the way a private site is: the link was public, people hold it,
    // and "gone" is the honest answer. Everything else stays 404 (see the header comment).
    if (view.site.takenDownAt) return new NextResponse("gone", { status: 410 });
    return new NextResponse("not found", { status: 404 });
  }

  // The `<base>` injected into the artifact. Only private sites need a credential; public/unlisted
  // sites are let through on canReadSite's first line, and an extra credential segment in the URL
  // would only make the link uglier.
  //
  // Minting happens ONLY when the **real gate** passes. A request that came in on a credential keeps
  // the one it holds and never gets a fresh one: otherwise someone whose share was revoked could keep
  // rolling the credential forward for as long as the page stays open and keeps fetching resources,
  // and revocation would mean nothing. Kept apart, revocation takes effect within one TTL at most.
  let baseHref: string | undefined;
  if (view && view.site.visibility === "private") {
    baseHref = previewBaseHref(slug, canRead ? mintPreviewKey(view.site) : key);
  }

  // ?v pins the read to an earlier version (history preview); unknown/foreign values fall back to current.
  const versionId = new URL(request.url).searchParams.get("v") || undefined;
  // Range is handed downstream as-is: only media types use it; every other type is returned whole as before.
  const result = await servePreviewFile(slug, path, versionId, baseHref, request.headers.get("range"));
  return new NextResponse(result.body as BodyInit, { status: result.status, headers: result.headers });
}
