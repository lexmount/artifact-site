// GET /api/auth/login?return_to=/path — hand off to the IdP.
import { NextResponse } from "next/server";
import { beginLogin, OidcError, safeReturnTo } from "@/lib/oidc";
import { appPath, localPath } from "@/lib/app-path";
import { requestBase } from "@/lib/public-base";
import { autoLoginAllowed, autoLoginOptedOut, autoLoginRetryCookie, cancelPendingSilentLogins } from "@/lib/oidc-auto-login";
import { resolveSession } from "@/lib/session";
import { checkRateLimit } from "@/lib/ratelimit";
import { errorResponse } from "../../_util";

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const silent = params.get("silent") === "1";
  const switchAccount = params.get("switch_account") === "1";
  if (silent && switchAccount) return errorResponse(new OidcError("Account switching requires interactive sign-in"));
  const returnTo = appPath(safeReturnTo(localPath(params.get("return_to") || "/")));
  const guestReturn = () => NextResponse.redirect(new URL(returnTo, new URL(requestBase(request)).origin), 302);
  let res: NextResponse;
  try {
    // Unauthenticated and it writes a row every call; retain the existing limiter.
    checkRateLimit(request);
    if (!silent) await cancelPendingSilentLogins(request);
    if (silent && (!autoLoginAllowed(request) || await resolveSession(request))) {
      res = guestReturn();
    } else {
      const { url, cookie } = await beginLogin(request, returnTo, silent, switchAccount || (!silent && autoLoginOptedOut(request)));
      res = NextResponse.redirect(url, 302);
      res.headers.append("set-cookie", cookie);
    }
  } catch (error) {
    res = silent ? guestReturn() : errorResponse(error);
  }
  res.headers.set("Cache-Control", "private, no-store");
  if (silent) res.headers.append("set-cookie", autoLoginRetryCookie(request));
  else {
    // Keep deliberate sign-out suppression until an interactive callback succeeds.
    res.headers.append("set-cookie", autoLoginRetryCookie(request, true));
  }
  return res;
}
