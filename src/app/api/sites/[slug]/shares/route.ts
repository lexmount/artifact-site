import { withPermissionCommit } from "@/lib/authorized-commit";
import { assertMutationOrigin } from "@/lib/request-auth";
// Share links of one site — list + mint. Owner-only, for the same reason as /sharing and
// /collaborators: minting a link is handing out read access, so a tier that may merely edit content
// must not be able to widen who can see the site. `manage` is not enough either — a collaborator
// who could mint a `public` link would have laundered the owner's private site into an open one.
import type { NextResponse } from "next/server";
import { createId, createShare, listShares } from "@/lib/db";
import { getSiteView } from "@/lib/sites";
import { apiAuditContext, recordSiteAudit } from "@/lib/audit";
import { requireActor, requireCapability } from "@/lib/authz";
import { anonIdFromRequest } from "@/lib/anon";
import { createPasscode, createShareToken, hashPasscode, hashToken } from "@/lib/share";
import { resolvePublicBase } from "@/lib/publish-skill";
import type { User } from "@/lib/types";
import { errorResponse, json } from "../../../_util";
import { parseShareAuthorization, loadGrants, parseExpiry, parseLabel, parsePasscode, parsePolicy, shareUrl, summarize } from "./_shared";

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    await requireCapability(request, view.site, "manage");

    // Revoked and expired rows included: the owner's question is "who did I give this to and is it
    // still open", and a list that quietly drops dead links cannot answer the first half.
    const shares = await listShares(view.site.id);
    const users = new Map<string, User | null>(); // one lookup per account across every share
    const now = Date.now();
    const out = [];
    for (const share of shares) out.push(summarize(share, await loadGrants(share.id, users), now));
    return json({ shares: out }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Mint a link.
 *
 * The response is the ONLY time the token is legible — `POST` returns it, every later read returns
 * the hash-backed summary and nothing else. Same for a generated passcode. Losing either means
 * minting a new link, which is the intended remedy: it is also how you take the old one away.
 */
export async function POST(request: Request, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  try {
    const { slug } = await context.params;
    const view = await getSiteView(slug);
    if (!view) return json({ error: "site not found" }, 404);
    const { actor, viewer } = await requireActor(request, view.site, "manage");
    await assertMutationOrigin(request, view.site);

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    // `login` is the default because the person minting this is, by definition, signed in: the
    // safe-ish tier they can reason about ("anyone at the company who has the link") beats
    // defaulting to `public`, which silently reproduces the old behaviour of every link being open.
    const policy = parsePolicy(body.policy, "login");
    const expiresAt = parseExpiry(body.expiresInDays) ?? null;
    const label = parseLabel(body.label);
    const supplied = parsePasscode(body.passcode);

    // A passcode on a non-passcode policy would be stored and never checked — a setting the owner
    // believes they made. Refuse rather than confirm a protection that does not apply.
    if (supplied && policy !== "passcode") {
      return json({ error: "A passcode only applies to links with policy=passcode" }, 400);
    }
    const passcode = policy === "passcode" ? supplied ?? createPasscode() : undefined;

    const authorization = await parseShareAuthorization(body,view.site.id);
    const token = createShareToken();
    const share = await withPermissionCommit(request,view.site.id,"site.sharing.manage", async () => createShare({
      ...authorization,
      id: createId("shr"),
      siteId: view.site.id,
      tokenHash: hashToken(token),
      policy,
      passcodeHash: passcode ? hashPasscode(passcode) : null,
      label,
      createdBy: viewer.session?.userId ?? null,
      // Only ever the anonymous marker when there is no account — the two are alternatives, and
      // recording both would make "who minted this" ambiguous the moment the browser signs in.
      createdAnonId: viewer.session ? null : anonIdFromRequest(request),
      expiresAt,
      allowAi: body.allowAi === true, // Q&A tier: strictly opt-in, anything but literal true stays off
    }));
    await recordSiteAudit(view.site.id, "share", apiAuditContext(request, actor)); // best-effort, non-atomic

    return json({
      share: summarize(share, [], Date.now()),
      token,
      url: shareUrl(resolvePublicBase(request.headers), token),
      // Present only when we generated it: if the owner typed the code they already have it, and
      // echoing it back would put a secret they chose into one more log for no gain.
      passcode: supplied ? undefined : passcode,
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
