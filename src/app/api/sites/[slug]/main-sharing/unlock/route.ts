import { NextResponse } from "next/server";
import { getSiteBySlug } from "@/lib/db";
import { activeMainPasscode, mainPasscodeCookie } from "@/lib/main-passcode";
import { hashPasscode } from "@/lib/share";
import { safeEqual } from "@/lib/crypto";
import { checkRateLimit, clientKey, RateLimitError } from "@/lib/ratelimit";
import { rateLimit } from "@/lib/config";
import { requestBase } from "@/lib/public-base";
import { publicationPolicy } from "@/lib/publication-policy";
import { errorResponse, privateJson as json, readBodyWithinUploadLimit } from "@/lib/api-http";

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const wantsJson = request.headers.get("content-type")?.includes("application/json");
  const url = new URL(`${requestBase(request)}/s/${encodeURIComponent(slug)}`);
  const denied = (message: string, status: number, reason: string) => {
    if (wantsJson) return json({ error: message }, status);
    url.searchParams.set("e", reason);
    const response = NextResponse.redirect(url, 303);
    response.headers.set("cache-control", "private, no-store");
    return response;
  };
  try {
    const site = await getSiteBySlug(slug);
    const code = site && await activeMainPasscode(site);
    if (!site || !code) { checkRateLimit(request); return denied("This link does not need a passcode", 404, "unavailable"); }
    // Admission proves the submitted secret and never uses ambient account credentials.
    // As with independent-link unlock, accept no-JS form posts: the global no-referrer
    // policy makes their Origin opaque. Sharing mutations still require their CSRF gate.
    checkRateLimit(request, Date.now(), `main-passcode:${site.id}`);
    checkRateLimit(request, Date.now(), `main-passcode-scan:${clientKey(request)}`, rateLimit.burst * 10);
    const input = await readBodyWithinUploadLimit(request, 4096);
    const body = wantsJson ? await input.json() : Object.fromEntries(await input.formData());
    if (!body || typeof body !== "object" || Array.isArray(body)) return denied("Please enter the passcode", 400, "empty");
    if (typeof body.version === "string" && body.version.length < 200) url.searchParams.set("version", body.version);
    const passcode = typeof body.passcode === "string" ? body.passcode.trim() : "";
    if (!passcode) return denied("Please enter the passcode", 400, "empty");
    const external = await publicationPolicy.externalSite(site);
    if (passcode.length > 64 || !safeEqual(hashPasscode(passcode), code.passcode_hash) || !(await publicationPolicy.allowsVersion(site, external.currentVersionId)))
      return denied("Incorrect passcode", 403, "wrong");
    const response = wantsJson ? json({ ok: true, url: url.toString() }) : NextResponse.redirect(url, 303);
    response.headers.set("cache-control", "private, no-store");
    response.headers.append("set-cookie", await mainPasscodeCookie(request, site, code.id));
    return response;
  } catch (error) {
    if (error instanceof RateLimitError && !wantsJson) return denied("Too many attempts. Try again later.", 429, "slow");
    return errorResponse(error);
  }
}
