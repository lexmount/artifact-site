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

  const url = new URL(request.url);
  // Only the unkeyed entry URL accepts legacy platform controls. File queries belong to the
  // artifact (v/cache hashes, share buttons, t/timestamps, etc.), not to authorization. Explicit
  // platform links use a reserved namespace on both entry and file URLs; it takes precedence
  // over legacy entry controls. Keyed requests always keep the grant's
  // version; no query can override it. Leave the browser's URL and uploaded bytes untouched.
  const entryRequest = !key && !path?.length;
  const authUrl = new URL(request.url);
  authUrl.search = "";
  if (!key) {
    if (entryRequest) authUrl.search = url.search;
    for (const [source, target] of [["__artifact_version", "v"], ["__artifact_share", "share"]]) {
      const value = url.searchParams.get(source);
      if (value !== null) authUrl.searchParams.set(target, value);
    }
  }
  const authRequest = new Request(authUrl, { headers: request.headers });
  const imageViewer = url.searchParams.get("__artifact_image") === "1" ||
    (entryRequest && url.searchParams.get("comment-image") === "1");
  const view = await getSiteView(slug);
  const access = view ? await authorizePreview(authRequest,view.site,key) : null;
  if (!access) return new NextResponse("not found", {status:view?.site.takenDownAt ? 410 : 404});
  const baseHref=previewBaseHref(slug,access.key);
  // A hosted document can read its own location. Exchange the share credential for a
  // read-only resource key before serving any untrusted bytes.
  if (!key && authUrl.searchParams.has("share")) {
    const controls = new Set(["__artifact_version", "__artifact_share", "__artifact_image"]);
    if (entryRequest) for (const name of ["v", "share", "t", "comment-image"]) controls.add(name);
    // Decode only names for filtering (including encoded/duplicate credential names). Keep
    // each remaining field verbatim: URLSearchParams.toString() changes flags and escapes.
    const fields = url.search.slice(1).split("&").filter(field => {
      const name = new URLSearchParams(`&${field}`).keys().next().value;
      return name === undefined || !controls.has(name);
    });
    if (imageViewer) fields.push("__artifact_image=1");
    const search = fields.join("&");
    const location = baseHref + (path ?? []).map(encodeURIComponent).join("/") + (search ? `?${search}` : "");
    return new NextResponse(null, {status:307,headers:{location,"cache-control":"private, no-store"}});
  }
  // Document navigations include popups, which inherit the preview sandbox and cannot use
  // the native PDF plugin. Use the same reader for direct links; raw fetch/download stays PDF.
  const versionId=access.versionId;
  const result = await servePreviewFile(slug, path, versionId, baseHref, request.headers.get("range"), imageViewer,
    ["document", "iframe", "frame", "object", "embed"].includes(request.headers.get("sec-fetch-dest") ?? ""),
    url.searchParams.get("__artifact_download") === "1");
  return new NextResponse(result.body as BodyInit, { status: result.status, headers: { ...result.headers, vary: "Sec-Fetch-Dest", "cache-control": access.key ? "private, no-store" : result.headers["cache-control"] ?? "no-store" } });
}
