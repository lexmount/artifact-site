import { getReadableView } from "@/lib/read-view";
import { requirePermission } from "@/lib/authz";
// GET /api/sites/:slug/text — the current version as plain text, for an agent that wants to know
// what a site says without downloading and parsing its tree. `?file=<relpath>` returns one file
// of the tree verbatim instead (text types only). Same read gate as the site itself, so an
// administrator opening a private site this way is logged like any other read.
// An un-indexed site is extracted on the spot, through the same two extraction slots the backfill
// and fresh publishes use — behind a large pdf parse such a read waits its turn (a slot reserved
// for reads is the next step if that ever shows).
import type { NextResponse } from "next/server";
import { BadRequestError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/ratelimit";

import { cutText, MAX_TEXT_CHARS, siteTextOf } from "@/lib/site-text";
import { siteUrl } from "@/lib/sites";
import { getStorage } from "@/lib/storage";
import { errorResponse, json } from "../../../_util";

const DEFAULT_MAX_CHARS = 20_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TEXT_FILE = /\.(html?|css|js|mjs|cjs|ts|tsx|jsx|json|md|markdown|txt|csv|tsv|xml|svg|yml|yaml|toml|ini|env|sh|py|rb|go|rs|java|c|h|cpp|hpp|sql|vue|svelte|astro|map|webmanifest)$/i;

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    const { slug } = await context.params;
    const view = await getReadableView(request, slug);
    if (!view) return json({ error: "site not found" }, 404);
    if (!view.readable) {
      if (view.site.takenDownAt) return json({ error: "This site has been taken down by an administrator", code: "taken_down" }, 410);
      return json({ error: "site not found" }, 404);
    }
    const params = new URL(request.url).searchParams;
    const maxRaw = params.get("max_chars");
    const maxChars = maxRaw === null ? DEFAULT_MAX_CHARS : Number(maxRaw);
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_TEXT_CHARS) throw new BadRequestError(`max_chars must be an integer from 1 to ${MAX_TEXT_CHARS}`);

    const file = params.get("file");
    let text: string;
    if (file !== null) {
      await requirePermission(request, view.site, "site.source.export");
      const files = await getStorage().list(view.site.id, view.version.id);
      if (!files.includes(file)) return json({ error: `file not found: ${file}` }, 404);
      if (!TEXT_FILE.test(file)) return json({ error: "not a text file; download it from the site instead", code: "not_text" }, 415);
      // One bounded range read: the cap holds even when the backend cannot say the size up front
      // (a failed probe must not fall open into a whole-file read of something 250 MB large).
      const slice = await getStorage().readRange(view.site.id, view.version.id, file, 0, MAX_FILE_BYTES - 1);
      if (slice.total > MAX_FILE_BYTES) return json({ error: `file too large to return as text (over ${MAX_FILE_BYTES} bytes)` }, 413);
      text = new TextDecoder("utf-8", { fatal: false }).decode(slice.bytes);
    } else {
      text = await siteTextOf(view.site.id, view.version.id);
    }
    const truncated = text.length > maxChars;
    return json({
      slug: view.site.slug,
      url: siteUrl(view.site.slug),
      title: view.site.title,
      kind: view.site.kind,
      versionId: view.version.id,
      file: file ?? null,
      chars: text.length,
      truncated,
      text: truncated ? cutText(text, maxChars) : text,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
