// The edit frame: a site's entry HTML with the visual-editor bootstrap injected, ready for the
// editor to fetch into a srcDoc iframe. This module builds the document; the route
// (app/api/sites/[slug]/edit-frame) owns authorization and the response headers. The split keeps
// the "who may see this" decision visibly in front of everything below, and keeps the
// version/entry/marker rules testable without a Request.
//
// Scope: any site whose entry is HTML — single-file and folder alike, with or without the page's
// own <script>. Saving goes through text write-back (lib/text-writeback), which replaces text
// ranges in the ORIGINAL source rather than serializing the live DOM, so the old "no scripts, no
// folders" restrictions no longer have a reason to exist. The locator markers (markEditableText)
// are numbered from a parse of the source, never from the rendered DOM.
//
// ?version= — editing on top of a historical version. When given, the entry HTML served is that
// version's, the markers are computed from THAT version's source, and `versionId` names it, so the
// source, the marker numbering and the version the parent page holds are one and the same and the
// write-back offsets line up. The version MUST be checked against the site: lib/db.getVersion looks
// up by id globally, without a site filter, so using its result directly would serve another site's
// source from under this slug.
import { config } from "@/lib/config";
import { createId, getVersion } from "@/lib/db";
import { injectVisualEditor, withConnectSrcMeta } from "@/lib/preview";
import { mintPreviewKey, previewBaseHref } from "@/lib/preview-key";
import { getStorage } from "@/lib/storage";
import { markEditableText, scriptPrecedesHead } from "@/lib/text-writeback";
import type { Site, Version } from "@/lib/types";

/** Why the frame could not be built. `code` is what the client keys its fallback UI on. */
export type EditFrameRefusal = {
  ok: false;
  status: 400 | 404 | 409;
  error: string;
  code?: "unknown_version" | "not_html" | "empty_entry" | "script_before_head";
};

export type EditFrameResult =
  | {
      ok: true;
      /** The injected document. */
      body: string;
      /** Pairs the save reply with this editing session (sent back as x-ah-editor-nonce). */
      nonce: string;
      /** The version the markers were computed from (sent back as x-ah-editor-version). */
      versionId: string;
    }
  | EditFrameRefusal;

/**
 * Build the edit frame for `view`, based on its current version or on `requestedVersion` when that
 * belongs to the same site. Authorization is the CALLER's job and must happen before this runs:
 * nothing here checks who is asking, and a refusal from here must never be reachable by someone
 * who could not also have fetched the frame.
 */
export async function buildEditFrame(
  view: { site: Site; version: Version },
  slug: string,
  requestedVersion: string | null,
): Promise<EditFrameResult> {
  // A document site's entry is a generated wrapper page; editing it visually is meaningless (the
  // next upload would overwrite it) and the original is binary. Same boundary as editSite:
  // updating a document means re-uploading it.
  if (view.site.kind === "document") {
    return { ok: false, status: 400, error: "Document sites cannot be edited online; re-upload to publish a new version" };
  }

  // The base version: current by default. A requested version must be proven to belong to this
  // site — getVersion ignores siteId, and skipping this check is a cross-site read. Unknown and
  // foreign ids both answer 404, so the response does not say which.
  let version = view.version;
  if (requestedVersion && requestedVersion !== view.version.id) {
    const target = await getVersion(requestedVersion);
    if (!target || target.siteId !== view.site.id) {
      return { ok: false, status: 404, error: "The specified version does not belong to this site or no longer exists", code: "unknown_version" };
    }
    version = target;
  }

  const entry = version.entry;
  // No HTML entry, no text to double-click (should not happen: uploads normalize the entry).
  if (!/\.html?$/i.test(entry)) {
    return { ok: false, status: 409, error: "The site entry is not HTML; only source editing is available", code: "not_html" };
  }
  const bytes = await getStorage().read(view.site.id, version.id, entry).catch(() => null);
  const html = bytes ? Buffer.from(bytes).toString("utf8") : "";
  if (!html.trim()) {
    return { ok: false, status: 409, error: "The entry file is empty; only source editing is available", code: "empty_entry" };
  }
  // When the page's own <script> precedes <head> (HTML5 allows it; browsers treat it as implicit
  // head content and run it first), the injected bootstrap is no longer the first script to run.
  // That earlier script could register a message listener first, receive the parent's handshake
  // ping, take the port and stopImmediatePropagation, then impersonate the bootstrap and write
  // forged patches into the user's source. So not one byte of editor script is sent: answer 409
  // and let the client fall back to source editing IMMEDIATELY with the real reason, instead of
  // injecting, waiting out an 8-second handshake timeout, and showing a vague "the page blocked
  // the editor script".
  if (scriptPrecedesHead(html)) {
    return {
      ok: false,
      status: 409,
      error: "This page has a script before <head>, so the editor script cannot be guaranteed to run first; only source editing is available",
      code: "script_before_head",
    };
  }

  const nonce = createId("nonce");
  // <base> deliberately does NOT follow ?version= (nor could it: relative-path resolution drops the
  // query string). This matches the save semantics rather than compromising them — saving a folder
  // site copies the current version's tree and overwrites the one file you changed, so "entry from
  // the chosen version, every other file from the current one" is exactly what a save produces,
  // and the frame previews that.
  const body = withConnectSrcMeta(
    // Once inside srcDoc the frame is an opaque origin and its sub-requests carry no cookies. A
    // private site therefore puts its read credential into <base> so relative assets inherit it
    // through the path — the same mechanism as the main preview (lib/preview-key).
    injectVisualEditor(
      markEditableText(html),
      previewBaseHref(slug, view.site.visibility === "private" ? mintPreviewKey(view.site) : null),
      nonce,
    ),
    config.cspConnectSrc,
  );
  return { ok: true, body, nonce, versionId: version.id };
}
