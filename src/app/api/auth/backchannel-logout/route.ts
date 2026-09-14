// POST /api/auth/backchannel-logout — the IdP tells us a session ended (sign-out elsewhere, a
// password change, an admin revoking access). Without this, our cookie would outlive the identity
// it represents for up to its full lifetime.
import { NextResponse } from "next/server";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { config } from "@/lib/config";
import { revokeSessionsByOidcSid } from "@/lib/db";
import { errorResponse, json } from "../../_util";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksIssuer = "";

async function keys(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const { issuer } = config.oidc;
  if (jwks && jwksIssuer === issuer) return jwks;
  const res = await fetch(`${issuer}/.well-known/openid-configuration`);
  // Without these two checks an IdP hiccup (429/503) yields an undefined jwks_uri, `new URL`
  // throws, the caller's catch swallows it, and the logout is dropped in silence — the IdP
  // believes the session ended while ours keeps working. Mirrors discover() in lib/oidc.ts.
  if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: string; issuer?: string };
  if (doc.issuer !== issuer) throw new Error("The issuer in the OIDC discovery document does not match the configuration");
  if (!doc.jwks_uri) throw new Error("The OIDC discovery document has no jwks_uri");
  jwks = createRemoteJWKSet(new URL(doc.jwks_uri));
  jwksIssuer = issuer;
  return jwks;
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await request.formData();
    const token = String(form.get("logout_token") ?? "");
    if (!token) return json({ error: "missing logout_token" }, 400);

    const { payload } = await jwtVerify(token, await keys(), {
      issuer: config.oidc.issuer,
      audience: config.oidc.clientId,
    });
    // Required by the spec, and load-bearing: without the events claim an ordinary id_token could
    // be replayed here to log people out.
    const events = payload.events as Record<string, unknown> | undefined;
    if (!events || !("http://schemas.openid.net/event/backchannel-logout" in events)) {
      return json({ error: "not a logout token" }, 400);
    }
    const sid = payload.sid as string | undefined;
    if (!sid) return json({ error: "missing sid" }, 400);

    const revoked = await revokeSessionsByOidcSid(sid);
    return json({ revoked }, 200);
  } catch (error) {
    // A token that fails verification is the sender's problem and always answered 400 here;
    // errorResponse would now treat jose's error as internal. Discovery failures stay internal.
    if (error instanceof joseErrors.JOSEError) return json({ error: `invalid logout_token: ${error.message}` }, 400);
    return errorResponse(error);
  }
}
