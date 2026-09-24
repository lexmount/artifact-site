// View history — who opened this site, through EITHER door: a share link (share_views) or the site's
// own /s/ address (site_views). Owner-only, and emphatically not because the data is exotic: the
// rows carry IP addresses and user agents, so anything short of the owner would turn a reading log
// into a way to watch other people read.
//
// The response also carries a small `summary` block (7-day opens / unique viewers / last opened),
// aggregated over both tables WITH the owner and collaborators excluded — the question it answers
// is "is anyone ELSE looking", and counting your own refreshes would answer it with noise. The
// detail rows below it stay unfiltered: an audit list that silently dropped the owner's own opens
// would be lying about what was recorded.
import type { NextResponse } from "next/server";
import { getSiteViewStats, getUser, listAudienceExcludedUserIds, listSiteOpens } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { requirePermission } from "@/lib/authz";
import type { User } from "@/lib/types";
import { errorResponse, json } from "../../../_util";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const SUMMARY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requirePermission(request, view.site, "site.audit.read");

    const raw = Number(new URL(request.url).searchParams.get("limit"));
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_LIMIT) : DEFAULT_LIMIT;

    // Exclude the owner and explicitly named editors/admins, not broad tenant/everyone grants —
    // and an ANONYMOUS owner too, by their browser id, or the agent-publish flow (anonymous
    // creation is the hero path) would count its own author forever.
    const collaborators = await listAudienceExcludedUserIds(view.site.id);
    const summary = await getSiteViewStats(view.site.id, Date.now() - SUMMARY_WINDOW_MS, {
      userIds: [view.site.ownerId, ...collaborators].filter((id): id is string => id != null),
      anonIds: view.site.anonOwnerId ? [view.site.anonOwnerId] : [],
    });

    const rows = await listSiteOpens(view.site.id, limit);
    // One lookup per distinct account, not per row: a colleague who opens a link every morning
    // would otherwise cost a query per visit just to render the same name.
    const users = new Map<string, User | null>();
    const views = [];
    for (const row of rows) {
      if (row.userId && !users.has(row.userId)) users.set(row.userId, await getUser(row.userId));
      const user = row.userId ? users.get(row.userId) ?? null : null;
      views.push({
        ...row,
        // Named readers get a name; anonymous ones stay anonymous rather than being dressed up as
        // an identity we do not actually have.
        displayName: user?.displayName ?? null,
        email: user?.emailVerified ? user.email : null,
      });
    }
    return json({ views, summary: { windowMs: SUMMARY_WINDOW_MS, ...summary } }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
