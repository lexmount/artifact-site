import { getUser } from "@/lib/db";
import { rateLimit } from "@/lib/config";
import { noStoreJson, oauthErrorResponse, resolveOauthAccessToken } from "@/lib/oauth";
import { discoveryPreflight, issuerFor, parseScopeList, SCOPE_EMAIL, SCOPE_OPENID } from "@/lib/oauth-shared";
import { oauthAccessTokenFromRequest } from "@/lib/publish-token";
import { checkRateLimit, clientKey } from "@/lib/ratelimit";

export const dynamic = "force-dynamic";

/** Identity claims for MCP workspace-domain checks; browser cookies are never accepted. */
export async function GET(request: Request): Promise<Response> {
  try {
    checkRateLimit(request, Date.now(), `oauth-userinfo:${clientKey(request)}`, rateLimit.burst, rateLimit.perMin);
    const secret = oauthAccessTokenFromRequest(request);
    const token = secret ? await resolveOauthAccessToken(secret, issuerFor(request)) : null;
    const user = token ? await getUser(token.userId) : null;
    if (!token || !user || user.disabledAt != null) {
      return noStoreJson({ error: "invalid_token", error_description: "A valid OAuth access token is required" }, 401, {
        "www-authenticate": 'Bearer realm="artifact-site", error="invalid_token"',
      });
    }
    const scopes = parseScopeList(token.scope);
    if (!scopes.includes(SCOPE_OPENID)) {
      return noStoreJson({ error: "insufficient_scope", scope: SCOPE_OPENID }, 403, {
        "www-authenticate": 'Bearer realm="artifact-site", error="insufficient_scope", scope="openid"',
      });
    }
    return noStoreJson({
      sub: user.id,
      ...(scopes.includes(SCOPE_EMAIL) && user.email && user.emailVerified
        ? { email: user.email, email_verified: true }
        : {}),
    });
  } catch (error) {
    return oauthErrorResponse(error);
  }
}

export const POST = GET;

export function OPTIONS(): Response {
  return discoveryPreflight();
}
