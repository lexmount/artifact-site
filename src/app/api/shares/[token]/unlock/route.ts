// POST /api/shares/<token>/unlock — hand in a passcode, get the entry cookie.
//
// Reached by a plain <form> on /v/<token>, so it has to work with no JavaScript and answers with a
// 303 back to the viewer. A fetch caller (`content-type: application/json`) gets JSON instead.
import { NextResponse } from "next/server";
import { config, rateLimit as rateLimitCfg } from "@/lib/config";
import { getShareByTokenHash } from "@/lib/db";
import { buildPasscodeCookie, hashToken, isLive, resolveShareAccess } from "@/lib/share";
import { checkRateLimit, clientKey, RateLimitError } from "@/lib/ratelimit";
import { errorResponse, json } from "../../../_util";

/** Same-origin address of the viewer page. Built from the token we were routed with — never from
 *  anything in the body — so this can never become an open redirect. */
function viewerUrl(request: Request, token: string, error?: string): string {
  const base = config.publicUrl || new URL(request.url).origin;
  const url = new URL(`/v/${encodeURIComponent(token)}`, base);
  if (error) url.searchParams.set("e", error);
  return url.toString();
}

/** Accepts both wire formats: a browser form post, and a JSON fetch. */
async function readPasscode(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { passcode?: unknown };
    return typeof body.passcode === "string" ? body.passcode : "";
  }
  const form = await request.formData().catch(() => null);
  const value = form?.get("passcode");
  return typeof value === "string" ? value : "";
}

export async function POST(request: Request, context: { params: Promise<{ token: string }> }): Promise<NextResponse> {
  const { token } = await context.params;
  const wantsJson = (request.headers.get("content-type") || "").includes("application/json");
  try {
    const share = await getShareByTokenHash(hashToken(token));

    // An unknown or dead token is limited PER CLIENT, and a real one PER SHARE. The split is the
    // whole trick:
    //
    //   · per-share is what passcode entry needs — the secret being guessed belongs to the link, so
    //     the budget should too. Keying on the caller would let a distributed attacker spend one
    //     bucket per address, while a single fumbling reader behind a corporate NAT would burn the
    //     bucket that every colleague at that office shares and lock them all out of a link they
    //     were legitimately given.
    //   · per-client for the miss, because there the key would otherwise be attacker-chosen: an
    //     unlimited stream of invented tokens could mint an unlimited stream of buckets and evict
    //     the real shares' buckets out of the limiter's LRU, which is the per-share budget undone.
    //     Nobody legitimate ever lands here, so the shared bucket costs no one anything.
    if (!share || !isLive(share)) {
      checkRateLimit(request);
      // Answers exactly like a wrong code would to someone probing: the viewer page is what says
      // "This link is no longer valid", and it says it for revoked, expired and never-existed alike.
      return wantsJson
        ? json({ error: "This link is no longer valid" }, 404)
        : NextResponse.redirect(viewerUrl(request, token), 303);
    }
    checkRateLimit(request, Date.now(), `share:${share.id}`);
    // Behind it, a far roomier bucket on the address. The per-share key deliberately ignores who is
    // asking, which is what stops a distributed guess at ONE code — but it also means an address
    // working through many links it already holds draws a fresh budget from each. This caps that
    // aggregate. Ten times the burst, so an office sharing one egress never reaches it by fumbling.
    checkRateLimit(request, Date.now(), `share-scan:${clientKey(request)}`, rateLimitCfg.burst * 10);

    // Nothing to unlock on the other three tiers. Send the reader back to the viewer, which knows
    // what they actually need (a login, an invitation, or nothing at all) — answering "Incorrect
    // passcode" to someone who was never asked for one would be a dead end.
    if (share.policy !== "passcode") {
      return wantsJson
        ? json({ error: "This link does not need a passcode", code: share.policy }, 400)
        : NextResponse.redirect(viewerUrl(request, token), 303);
    }

    const passcode = await readPasscode(request);
    if (!passcode.trim()) {
      return wantsJson
        ? json({ error: "Please enter the passcode" }, 400)
        : NextResponse.redirect(viewerUrl(request, token, "empty"), 303);
    }

    // Re-decided by the gate rather than compared here, so the page, the sub-resources and this
    // route can never drift on what counts as admitted.
    const access = await resolveShareAccess(request, token, { passcodeAttempt: passcode, session: null });
    if (!access.ok) {
      return wantsJson
        ? json({ error: "Incorrect passcode", code: access.reason }, 403)
        : NextResponse.redirect(viewerUrl(request, token, "wrong"), 303);
    }

    // The grant is a cookie, not a query parameter, because the artifact's own sub-resources have to
    // carry it too — an <img src="logo.png"> inside the page cannot append anything we invented.
    const res = wantsJson
      ? json({ ok: true, url: viewerUrl(request, token) }, 200)
      : NextResponse.redirect(viewerUrl(request, token), 303);
    res.headers.append("set-cookie", buildPasscodeCookie(request, access.share));
    return res;
  } catch (error) {
    // A form post must land back on a page, not on a bare 429 body — the reader has no way to read
    // a JSON error and no way back. JSON callers keep the real status.
    if (error instanceof RateLimitError && !wantsJson) {
      return NextResponse.redirect(viewerUrl(request, token, "slow"), 303);
    }
    return errorResponse(error);
  }
}
