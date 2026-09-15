import { getReadableView } from "@/lib/read-view";
import { requirePermission } from "@/lib/authz";
import { assertMutationOrigin } from "@/lib/request-auth";
// /api/sites/:slug — the item endpoint.
//   GET     viewer/editor data: site + current version + its file list + raw source of one file.
//           ?file=<relpath> selects the file to return (default: the entry). Guarded read.
//   PATCH   rename: { title } → updates the display title (metadata only; slug unchanged).
//   DELETE  soft-delete + rm the on-disk tree.
//
// Both writes carry the same CSRF gate the edit route already uses, and for the same reason: when
// authorization came from AMBIENT credentials (session or anon cookie), anything that can make the
// viewer's browser issue the request acts as them. The attacker that makes this concrete is one we
// host ourselves — a sandboxed artifact runs without allow-same-origin, so it is an opaque origin
// sending `Origin: null`, yet it sits inside our own page and rides the viewer's cookies.
//
// Gated on `ambientlyAuthed` rather than unconditionally: a caller that presented an edit token or
// a Bearer set that header deliberately, which an attacker's page cannot do, so demanding an Origin
// there would only 401 every non-browser API client. GET stays open — it reads what is public.
import type { NextResponse } from "next/server";
import { z } from "zod";
import { requireActor } from "@/lib/authz";

import { deleteSite, getSiteView, publicSite, renameSite, siteUrl } from "@/lib/sites";
import { apiAuditContext } from "@/lib/audit";
import { getStorage } from "@/lib/storage";
import { errorResponse, json } from "../../_util";

const renameSchema = z.object({ title: z.string() });

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getReadableView(request, slug);
    if (!view) return json({ error: "site not found" }, 404);
    // This response carries the entry file's full source, so it is a content outlet like
    // /api/preview and needs the same gate. 404 rather than 403: a private site does not confirm
    // its own existence to someone who cannot read it.
    if (!view.readable) {
      // A taken-down site answers "gone" rather than hiding: the link was public and people hold it.
      if (view.site.takenDownAt) return json({ error: "This site has been taken down by an administrator", code: "taken_down" }, 410);
      return json({ error: "site not found" }, 404);
    }
    await requirePermission(request, view.site, "site.source.export");
    const files = await getStorage().list(view.site.id, view.version.id);

    // Which file's source to return: an explicit ?file, else the entry.
    const requested = new URL(request.url).searchParams.get("file") ?? view.version.entry;
    const safe = files.includes(requested) ? requested : null;
    if (!safe) return json({ error: `file not found: ${requested}` }, 404);
    // storage.read re-applies the path guards (throws → 400) before returning bytes.
    const content = Buffer.from(await getStorage().read(view.site.id, view.version.id, safe)).toString("utf8");

    return json({
      slug: view.site.slug,
      url: siteUrl(view.site.slug),
      title: view.site.title,
      kind: view.site.kind,
      site: publicSite(view.site), // never leak edit_token in a public read
      version: view.version,
      files,
      file: safe,
      content,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor } = await requireActor(request, view.site, "manage"); // rename
    // Authorization ran first, so a credential-less request was already refused and never gets here.
    await assertMutationOrigin(request, view.site);
    const { title } = renameSchema.parse(await request.json());
    const site = await renameSite(slug, title, apiAuditContext(request, actor)); // trims + validates length (throws → 400)
    if (!site) return json({ error: "site not found" }, 404);
    return json({ slug: site.slug, title: site.title });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    // Delete is owner-only and never delegated: it removes the object-storage tree and is
    // effectively irreversible, unlike an edit which only appends a rollback-able version.
    const { actor } = await requireActor(request, view.site, "owner");
    await assertMutationOrigin(request, view.site);
    // Record BEFORE the delete: this is the one irreversible action, and its site_id has no FK, so
    // the trail row survives even though the site is about to go. (Deletion is soft, but recording
    // first is the honest order for an irreversible op.)
    const deleted = await deleteSite(slug, apiAuditContext(request, actor));
    if (!deleted) return json({ error: "site not found" }, 404);
    return json({ deleted: true, slug });
  } catch (error) {
    return errorResponse(error);
  }
}
