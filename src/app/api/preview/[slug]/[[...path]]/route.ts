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
import { authorizePreview } from "@/lib/preview-access";
import { previewBaseHref, splitSlugKey } from "@/lib/preview-key";

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

  const view = await getSiteView(slug);
  const access = view ? await authorizePreview(request,view.site,key) : null;
  if (!access) return new NextResponse("not found", {status:view?.site.takenDownAt ? 410 : 404});
  const baseHref=previewBaseHref(slug,access.key);
  // A hosted document can read its own location. Exchange the share credential for a
  // read-only resource key before serving any untrusted bytes.
  if (!key && new URL(request.url).searchParams.has("share")) {
    const location = baseHref + (path ?? []).map(encodeURIComponent).join("/");
    return new NextResponse(null, {status:307,headers:{location,"cache-control":"private, no-store"}});
  }
  const versionId=access.versionId;
  const result = await servePreviewFile(slug, path, versionId, baseHref, request.headers.get("range"));
  return new NextResponse(result.body as BodyInit, { status: result.status, headers: { ...result.headers, "cache-control": access.key ? "private, no-store" : result.headers["cache-control"] ?? "no-store" } });
}
