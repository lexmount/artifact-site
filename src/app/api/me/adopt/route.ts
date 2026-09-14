// POST /api/me/adopt — settle ownership at the moment it actually matters.
//
// Waiting for people to claim their sites during a grace period does not work: nobody has a reason
// to go looking. The real trigger is hitting a wall — you try to edit, you are asked to sign in.
// So the client hands over the evidence it has been holding all along (the edit tokens in its
// localStorage) right after that sign-in, and whatever is still unowned becomes yours.
//
// This is the only path that reaches sites created BEFORE the identity migration: they have no
// anon owner to adopt and no claim receipt to redeem, so the browser's own token is the sole
// remaining signal of who made them.
import type { NextResponse } from "next/server";
import { attributeUnattributedVersions, getSiteBySlug, setSiteOwnerIfUnowned } from "@/lib/db";
import { AuthError } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";
import { csrfSafe, resolveSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse, json } from "../../_util";

/** Bounded so a stolen session cannot walk the slug space one request at a time. */
const MAX_CANDIDATES = 200;

export async function POST(request: Request): Promise<NextResponse> {
  try {
    checkRateLimit(request);
    if (!csrfSafe(request)) throw new AuthError("Cross-site request rejected");
    const session = await resolveSession(request);
    if (!session) throw new AuthError("Please sign in first");

    const body = (await request.json().catch(() => ({}))) as { sites?: unknown };
    const candidates = Array.isArray(body.sites) ? body.sites.slice(0, MAX_CANDIDATES) : [];

    const adopted: string[] = [];
    for (const entry of candidates) {
      const slug = typeof (entry as { slug?: unknown })?.slug === "string" ? (entry as { slug: string }).slug : "";
      const token = typeof (entry as { editToken?: unknown })?.editToken === "string" ? (entry as { editToken: string }).editToken : "";
      if (!slug || !token) continue;

      const site = await getSiteBySlug(slug);
      if (!site || site.deletedAt || site.ownerId) continue;
      // A site that recorded its creating browser is NOT this route's business: adoptAnonymousSites
      // in the sign-in callback already settles those, keyed on that browser's own cookie, which a
      // recipient of a shared ?t= link can never present. Holding the token proves an invitation to
      // edit, not authorship — and for these rows there is better evidence, so defer to it. Without
      // this the token alone still decides, which is how a colleague's link could be redeemed for
      // their site; the provenance split in lib/edit-token stops that going forward, but only this
      // check also covers tokens the old client already filed under the created-by-me prefix.
      if (site.anonOwnerId) continue;
      // The token is checked against the row, so a caller can only adopt what it can already edit.
      if (!site.editToken || !safeEqual(token, site.editToken)) continue;

      if (await setSiteOwnerIfUnowned(site.id, session.userId)) {
        await attributeUnattributedVersions(site.id, session.userId);
        adopted.push(slug);
      }
    }

    return json({ adopted: adopted.length, slugs: adopted }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
